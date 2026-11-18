package handler

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/PeoneEr/self-hosted-vault-sync-server/internal/atomicfile"
	"github.com/PeoneEr/self-hosted-vault-sync-server/internal/changelog"
)

func (h *Handler) pendingPath() string { return filepath.Join(h.store.Root(), "pending-change.json") }

// ReadyError fails closed on corrupt metadata. A durable intent is rolled
// forward before any reader can observe a partially committed mutation.
func (h *Handler) ReadyError() error {
	if err := h.store.Err(); err != nil {
		return err
	}
	if err := h.changelog.Err(); err != nil {
		return err
	}
	if h.recoveryErr != nil {
		return h.recoveryErr
	}
	if err := h.recoverPending(); err != nil {
		return err
	}
	return h.finishRestore()
}

func (h *Handler) loadPending() {
	data, err := os.ReadFile(h.pendingPath())
	if os.IsNotExist(err) {
		return
	}
	if err != nil {
		h.recoveryErr = err
		return
	}
	var e changelog.Entry
	if err = json.Unmarshal(data, &e); err != nil {
		h.recoveryErr = err
		return
	}
	if e.ID == "" || !validPath(e.Path) || (e.Action != "deleted" && e.Action != "modified") || (e.Action == "modified" && len(e.Hash) != 64) {
		h.recoveryErr = fmt.Errorf("invalid pending mutation")
		return
	}
	h.pending = &e
}

func (h *Handler) recoverPending() error {
	if h.pending == nil {
		return nil
	}
	e := *h.pending
	if err := h.changelog.Append(e); err != nil {
		return err
	}
	hash := e.Hash
	if e.Action == "deleted" {
		hash = ""
	}
	if err := h.store.SetHash(e.Path, hash); err != nil {
		return err
	}
	if err := os.Remove(h.pendingPath()); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := atomicfile.SyncDir(h.store.Root()); err != nil {
		return err
	}
	h.pending = nil
	return nil
}

func (h *Handler) commit(e changelog.Entry) error {
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return err
	}
	e.ID = hex.EncodeToString(id)
	data, err := json.Marshal(e)
	if err != nil {
		return err
	}
	if err = atomicfile.Write(h.pendingPath(), data, 0600); err != nil {
		h.loadPending()
		return err
	}
	h.pending = &e
	return h.recoverPending()
}

// Caller holds mutationMu until response content is read or mutation completed.
func (h *Handler) ready(w http.ResponseWriter) bool {
	if err := h.ReadyError(); err != nil {
		http.Error(w, "storage unavailable; recover server storage before retrying", http.StatusServiceUnavailable)
		return false
	}
	return true
}

func validPath(path string) bool {
	if path == "" || len(path) > 1024 || strings.HasPrefix(path, "/") || strings.ContainsAny(path, "\\:") {
		return false
	}
	for _, r := range path {
		if r < 32 || r == 127 {
			return false
		}
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}
