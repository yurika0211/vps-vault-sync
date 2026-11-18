package handler

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/PeoneEr/self-hosted-vault-sync-server/internal/atomicfile"
	"github.com/PeoneEr/self-hosted-vault-sync-server/internal/changelog"
	"github.com/PeoneEr/self-hosted-vault-sync-server/internal/sse"
)

// Snapshot manifests pin immutable blobs. The catalog and restore intent share
// an atomic file so the safety snapshot always precedes the first replacement.
type version struct {
	Hash     string `json:"hash"`
	Modified int64  `json:"modified,omitempty"`
}
type snapshotMeta struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Time int64  `json:"time"`
}
type snapshot struct {
	snapshotMeta
	Files map[string]version `json:"files"`
}
type restoreIntent struct {
	ID      string
	Changes []string
}
type historyCatalog struct {
	Snapshots []snapshot
	Restore   *restoreIntent
}
type revision struct {
	version
	Kind string `json:"kind"`
	Time int64  `json:"time"`
	Name string `json:"name"`
}
type restoreRequest struct {
	ID     string `json:"id"`
	Path   string `json:"path"`
	Cursor *int64 `json:"cursor"`
}

func editTime(r *http.Request) int64 {
	m, _ := strconv.ParseInt(r.Header.Get("X-Modified"), 10, 64)
	c, _ := strconv.ParseInt(r.Header.Get("X-Client-Time"), 10, 64)
	now := time.Now().UnixMilli()
	if m <= 0 || m > c || c < now-60000 || c > now+60000 {
		return 0
	}
	return m
}

func (h *Handler) loadHistory() {
	data, err := os.ReadFile(filepath.Join(h.store.Root(), "history.json"))
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err == nil {
		err = json.Unmarshal(data, &h.history)
	}
	if err != nil {
		h.recoveryErr = err
	}
}

func (h *Handler) saveHistory(next historyCatalog) error {
	data, err := json.Marshal(next)
	if err == nil {
		err = atomicfile.Write(filepath.Join(h.store.Root(), "history.json"), data, 0600)
	}
	if err == nil {
		h.history = next
	} else {
		h.loadHistory()
	}
	return err
}

func (h *Handler) registerHistory() {
	routes := map[string]http.HandlerFunc{
		"POST /history/version":   h.restoreVersion,
		"GET /history/snapshots":  h.snapshots,
		"POST /history/snapshots": h.createSnapshot,
		"GET /history/manifest":   h.manifest,
		"POST /history/restore":   h.restore,
		"GET /history/search":     h.searchHistory,
		"GET /history/note":       h.noteHistory,
	}
	for route, handle := range routes {
		h.mux.HandleFunc(route, h.withAuth(func(w http.ResponseWriter, r *http.Request) {
			h.mutationMu.Lock()
			defer h.mutationMu.Unlock()
			if h.ready(w) {
				handle(w, r)
			}
		}))
	}
	h.mux.HandleFunc("POST /history/archive/{path...}", h.withAuth(h.historyUpload(h.archiveCopy)))
	h.mux.HandleFunc("POST /history/resolve/{path...}", h.withAuth(h.historyUpload(h.resolveConflict)))
}

// Buffer slow uploads outside the commit lock, sharing the normal upload limit.
func (h *Handler) historyUpload(handle func(http.ResponseWriter, *http.Request, []byte)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		select {
		case h.uploadSlots <- struct{}{}:
			defer func() { <-h.uploadSlots }()
		default:
			w.Header().Set("Retry-After", "2")
			http.Error(w, "upload capacity reached", 429)
			return
		}
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 100<<20))
		if err != nil {
			http.Error(w, "invalid content", 413)
			return
		}
		h.mutationMu.Lock()
		defer h.mutationMu.Unlock()
		if h.ready(w) {
			handle(w, r, data)
		}
	}
}

func (h *Handler) currentFiles() map[string]version {
	files := map[string]version{}
	paths, _ := h.store.ListAll()
	for _, p := range paths {
		if strings.Contains(p, ".conflict.") {
			continue
		}
		hash, _ := h.store.GetHash(p)
		e, _ := h.changelog.Latest(p)
		files[p] = version{Hash: hash, Modified: e.Modified}
	}
	return files
}

func (h *Handler) checkpoint(name string) (snapshot, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return snapshot{}, err
	}
	return snapshot{snapshotMeta{hex.EncodeToString(raw[:]), name, time.Now().UnixMilli()}, h.currentFiles()}, nil
}

func (h *Handler) findSnap(id string) *snapshot {
	for i := range h.history.Snapshots {
		if h.history.Snapshots[i].ID == id {
			return &h.history.Snapshots[i]
		}
	}
	return nil
}

func (h *Handler) snapshots(w http.ResponseWriter, r *http.Request) {
	out := []snapshotMeta{}
	for i := len(h.history.Snapshots) - 1; i >= 0; i-- {
		out = append(out, h.history.Snapshots[i].snapshotMeta)
	}
	writeJSON(w, out)
}
func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(v); err != nil {
		http.Error(w, "invalid request", 400)
		return false
	}
	return true
}

func (h *Handler) matchesCursor(w http.ResponseWriter, c *int64) bool {
	if c == nil || *c != h.changelog.Cursor() {
		http.Error(w, "vault changed; sync and review again", 409)
		return false
	}
	return true
}

func (h *Handler) createSnapshot(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name   string
		Cursor *int64
	}
	if !readJSON(w, r, &req) || !h.matchesCursor(w, req.Cursor) {
		return
	}
	if len(req.Name) > 512 {
		http.Error(w, "name too long", 400)
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "手动快照"
	}
	s, err := h.checkpoint(name)
	if err == nil {
		next := h.history
		next.Snapshots = append(next.Snapshots, s)
		err = h.saveHistory(next)
	}
	if err != nil {
		http.Error(w, "snapshot not saved", 503)
		return
	}
	writeJSON(w, s.snapshotMeta)
}

func (h *Handler) manifest(w http.ResponseWriter, r *http.Request) {
	s := h.findSnap(r.URL.Query().Get("id"))
	if s == nil {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, map[string]any{"files": s.Files, "current": h.currentFiles(), "cursor": h.changelog.Cursor()})
}
func changedFiles(target, current map[string]version, path string) []string {
	paths := map[string]bool{}
	for p, v := range target {
		if current[p].Hash != v.Hash {
			paths[p] = true
		}
	}
	for p := range current {
		if _, ok := target[p]; !ok {
			paths[p] = true
		}
	}
	out := []string{}
	for p := range paths {
		if path == "" || p == path {
			out = append(out, p)
		}
	}
	sort.Strings(out)
	return out
}

func (h *Handler) restore(w http.ResponseWriter, r *http.Request) {
	var req restoreRequest
	if !readJSON(w, r, &req) || !h.matchesCursor(w, req.Cursor) {
		return
	}
	s := h.findSnap(req.ID)
	if s == nil {
		http.NotFound(w, r)
		return
	}
	if req.Path != "" && (!validPath(req.Path) || s.Files[req.Path].Hash == "") {
		http.NotFound(w, r)
		return
	}
	before, err := h.checkpoint("恢复前 · " + s.Name)
	if err != nil {
		http.Error(w, "backup failed", 503)
		return
	}
	paths := changedFiles(s.Files, before.Files, req.Path)
	if len(paths) > 0 {
		next := h.history
		next.Snapshots = append(next.Snapshots, before)
		next.Restore = &restoreIntent{ID: req.ID, Changes: paths}
		if h.saveHistory(next) != nil || h.finishRestore() != nil {
			http.Error(w, "restore pending; retry after recovery", 503)
			return
		}
	}
	writeJSON(w, map[string]int{"changed": len(paths)})
}

func (h *Handler) finishRestore() error {
	op := h.history.Restore
	if op == nil {
		return nil
	}
	s := h.findSnap(op.ID)
	if s == nil {
		return fmt.Errorf("restore manifest unavailable")
	}
	for _, p := range op.Changes {
		v := s.Files[p]
		current, _ := h.store.GetHash(p)
		if current == v.Hash {
			continue
		}
		if v.Hash != "" {
			if err := h.verifyBlob(v.Hash); err != nil {
				return err
			}
		}
		if err := h.setVersion(p, v); err != nil {
			return err
		}
	}
	next := h.history
	next.Restore = nil
	return h.saveHistory(next)
}

func (h *Handler) setVersion(path string, v version) error {
	action := "modified"
	if v.Hash == "" {
		action = "deleted"
	}
	if err := h.commit(changelog.Entry{TS: nowUnix(), Path: path, Action: action, Hash: v.Hash, Modified: v.Modified}); err != nil {
		return err
	}
	h.sse.Publish(sse.Event{Path: path, Action: action, Hash: v.Hash})
	return nil
}

var oldCopy = regexp.MustCompile(`\.conflict\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d+`)

func originOf(e changelog.Entry) string {
	if e.Original != "" {
		return e.Original
	}
	return oldCopy.ReplaceAllString(e.Path, "")
}

func (h *Handler) searchHistory(w http.ResponseWriter, r *http.Request) {
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	paths := map[string]bool{}
	if q != "" {
		entries, err := h.changelog.Since(-1)
		if err != nil {
			http.Error(w, "log unavailable", 503)
			return
		}
		add := func(p string) {
			if !strings.Contains(p, ".conflict.") && strings.Contains(strings.ToLower(p), q) {
				paths[p] = true
			}
		}
		for _, e := range entries {
			add(originOf(e))
		}
		for _, s := range h.history.Snapshots {
			for p := range s.Files {
				add(p)
			}
		}
	}
	matches := make([]string, 0, len(paths))
	for p := range paths {
		matches = append(matches, p)
	}
	sort.Strings(matches)
	start, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	if start < 0 || start > len(matches) {
		start = len(matches)
	}
	end := min(start+5, len(matches))
	writeJSON(w, map[string]any{"paths": matches[start:end], "more": end < len(matches)})
}

func (h *Handler) noteHistory(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if !validPath(p) {
		http.Error(w, "invalid path", 400)
		return
	}
	revisions, err := h.revisions(p)
	if err != nil {
		http.Error(w, "history unavailable", 503)
		return
	}
	writeJSON(w, revisions)
}

func (h *Handler) revisions(p string) ([]revision, error) {
	revisions := []revision{}
	entries, err := h.changelog.Since(-1)
	if err != nil {
		return nil, err
	}
	for i := len(entries) - 1; i >= 0; i-- {
		e := entries[i]
		if e.Hash == "" || originOf(e) != p {
			continue
		}
		kind := "同步版本"
		if e.Path != p {
			kind = "冲突时保留"
		}
		revisions = append(revisions, revision{version{e.Hash, e.Modified}, kind, e.TS * 1000, ""})
	}
	for _, s := range h.history.Snapshots {
		if v, ok := s.Files[p]; ok {
			revisions = append(revisions, revision{v, "全仓快照", s.Time, s.Name})
		}
	}
	sort.SliceStable(revisions, func(i, j int) bool { return revisions[i].Time > revisions[j].Time })
	return revisions, nil
}

func (h *Handler) verifyBlob(hash string) error {
	if hash == "" {
		return nil
	}
	data, err := h.store.ReadBlob(hash)
	if err != nil {
		return err
	}
	if sha256hex(data) != hash {
		return errors.New("stored content does not match its hash")
	}
	return nil
}

// Check the reviewed head and persist the losing version before replacing the canonical file.
func (h *Handler) resolveConflict(w http.ResponseWriter, r *http.Request, data []byte) {
	p := r.PathValue("path")
	q := r.URL.Query()
	if !validPath(p) || strings.Contains(p, ".conflict.") {
		http.Error(w, "invalid path", 400)
		return
	}
	seq, err := strconv.ParseInt(q.Get("seq"), 10, 64)
	e, _ := h.changelog.Latest(p)
	head, _ := h.store.GetHash(p)
	if err != nil || seq != e.Seq || head != q.Get("remote") {
		http.Error(w, "server version changed", 409)
		return
	}
	local := version{Hash: q.Get("local"), Modified: editTime(r)}
	if (local.Hash == "" && len(data) != 0) || (local.Hash != "" && sha256hex(data) != local.Hash) {
		http.Error(w, "local version changed", 409)
		return
	}
	if local.Hash != "" {
		if _, err = h.store.PutBlob(data); err != nil {
			http.Error(w, "save failed", 503)
			return
		}
	}
	remote := version{head, e.Modified}
	winner, loser := remote, local
	switch q.Get("keep") {
	case "local":
		winner, loser = local, remote
	case "server":
	default:
		http.Error(w, "invalid choice", 400)
		return
	}
	if err = h.verifyBlob(loser.Hash); err != nil {
		http.Error(w, "retained body unavailable", 503)
		return
	}
	if loser.Hash != winner.Hash {
		action := "modified"
		if loser.Hash == "" {
			action = "deleted"
		}
		if err = h.commit(changelog.Entry{TS: nowUnix(), Path: conflictName(p), Original: p, Action: action, Hash: loser.Hash, Modified: loser.Modified}); err != nil {
			http.Error(w, "history not saved", 503)
			return
		}
	}
	if winner.Hash != head {
		if err = h.setVersion(p, winner); err != nil {
			http.Error(w, "resolution not saved", 503)
			return
		}
	}
	writeJSON(w, winner)
}

func (h *Handler) restoreVersion(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path, Hash string
		Cursor     *int64
	}
	if !readJSON(w, r, &req) || !h.matchesCursor(w, req.Cursor) {
		return
	}
	if !validPath(req.Path) || strings.Contains(req.Path, ".conflict.") || req.Hash == "" {
		http.Error(w, "invalid version", 400)
		return
	}
	revisions, err := h.revisions(req.Path)
	if err != nil {
		http.Error(w, "history unavailable", 503)
		return
	}
	for _, rev := range revisions {
		if rev.Hash != req.Hash {
			continue
		}
		if err = h.verifyBlob(rev.Hash); err != nil {
			http.Error(w, "version unavailable", 503)
			return
		}
		if current, _ := h.store.GetHash(req.Path); current != rev.Hash {
			if err = h.setVersion(req.Path, rev.version); err != nil {
				http.Error(w, "restore failed", 503)
				return
			}
		}
		writeJSON(w, rev.version)
		return
	}
	http.NotFound(w, r)
}

func (h *Handler) archiveCopy(w http.ResponseWriter, r *http.Request, data []byte) {
	p := r.PathValue("path")
	hash := r.URL.Query().Get("hash")
	if !validPath(p) || strings.Contains(p, ".conflict.") {
		http.Error(w, "invalid path", 400)
		return
	}
	if sha256hex(data) != hash {
		http.Error(w, "invalid copy", 400)
		return
	}
	if _, err := h.store.PutBlob(data); err != nil || h.verifyBlob(hash) != nil {
		http.Error(w, "archive failed verification", 503)
		return
	}
	revisions, err := h.revisions(p)
	if err != nil {
		http.Error(w, "history unavailable", 503)
		return
	}
	for _, rev := range revisions {
		if rev.Kind == "冲突时保留" && rev.Hash == hash {
			writeJSON(w, rev.version)
			return
		}
	}
	err = h.commit(changelog.Entry{Path: conflictName(p), Original: p, TS: nowUnix(), Modified: editTime(r), Hash: hash, Action: "modified"})
	if err != nil {
		http.Error(w, "archive failed", 503)
		return
	}
	writeJSON(w, version{Hash: hash})
}
