package main_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/PeoneEr/self-hosted-vault-sync-server/internal/changelog"
	"github.com/PeoneEr/self-hosted-vault-sync-server/internal/handler"
	"github.com/PeoneEr/self-hosted-vault-sync-server/internal/sse"
	"github.com/PeoneEr/self-hosted-vault-sync-server/internal/store"
	"github.com/PeoneEr/self-hosted-vault-sync-server/internal/tokens"
)

func TestReviewSameSecondCursor(t *testing.T) {
	c := changelog.New(filepath.Join(t.TempDir(), "changes"))
	if err := c.Append(changelog.Entry{TS: 100, Path: "a.md", Action: "modified"}); err != nil {
		t.Fatal(err)
	}
	first, err := c.Since(0)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Append(changelog.Entry{TS: 100, Path: "b.md", Action: "modified"}); err != nil {
		t.Fatal(err)
	}
	next, err := c.Since(first[0].TS)
	if err != nil {
		t.Fatal(err)
	}
	if len(next) != 0 {
		t.Fatal("legacy timestamp contract changed")
	}
	page, err := c.PageAfter(1, 256)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Changes) != 1 || page.Changes[0].Path != "b.md" || page.Cursor != 2 {
		t.Fatalf("same-second event missing: %+v", page)
	}
}

func reviewHandler(t *testing.T, logPath string) (*handler.Handler, *store.Store, *tokens.Store, *sse.Broker) {
	t.Helper()
	root := t.TempDir()
	s := store.New(filepath.Join(root, "vault"))
	if logPath == "" {
		logPath = filepath.Join(root, "changes")
	}
	ts, err := tokens.New(filepath.Join(root, "tokens.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = ts.Bootstrap("review-only"); err != nil {
		t.Fatal(err)
	}
	b := sse.NewBroker()
	return handler.New(s, changelog.New(logPath), b, ts), s, ts, b
}

func reviewPut(h http.Handler, path, base string, data []byte) *httptest.ResponseRecorder {
	r := httptest.NewRequest("PUT", "/file/"+path, bytes.NewReader(data))
	r.Header.Set("Authorization", "Bearer review-only")
	r.Header.Set("X-Base-Hash", base)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestReviewConcurrentBase(t *testing.T) {
	h, s, _, _ := reviewHandler(t, "")
	const workers = 8
	for attempt := 0; attempt < 10; attempt++ {
		path := fmt.Sprintf("note-%d.md", attempt)
		reviewPut(h, path, "", []byte("base"))
		base, _ := s.GetHash(path)
		start := make(chan struct{})
		var wg sync.WaitGroup
		results := make(chan bool, workers)
		for i := 0; i < workers; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				payload := bytes.Repeat([]byte{byte('a' + i)}, 4<<20)
				<-start
				w := reviewPut(h, path, base, payload)
				results <- w.Code == 200 && w.Header().Get("X-Conflict") == "false"
			}(i)
		}
		close(start)
		wg.Wait()
		close(results)
		n := 0
		for ok := range results {
			if ok {
				n++
			}
		}
		if n != 1 {
			t.Fatalf("expected one accepted same-base writer, got %d", n)
		}
	}
}

func TestReviewChangelogWriteFailure(t *testing.T) {
	h, s, _, _ := reviewHandler(t, t.TempDir())
	w := reviewPut(h, "a.md", "", []byte("accepted but not journaled"))
	_, exists := s.GetHash("a.md")
	if w.Code != 503 || exists {
		t.Fatalf("must fail closed: status=%d stored=%t", w.Code, exists)
	}
}

func TestReviewRevokedSSE(t *testing.T) {
	for _, endpoint := range []string{"/devices/", "/admin/api/devices/"} {
		t.Run(endpoint, func(t *testing.T) { reviewRevokedSSE(t, endpoint) })
	}
}

func reviewRevokedSSE(t *testing.T, endpoint string) {
	h, _, ts, b := reviewHandler(t, "")
	h.WithAdmin("review-admin-only")
	id, token, err := ts.Issue("revoked-device")
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/events", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	revoke := httptest.NewRequest("DELETE", endpoint+id, nil)
	credential := "review-only"
	if strings.HasPrefix(endpoint, "/admin/") {
		credential = "review-admin-only"
	}
	revoke.Header.Set("Authorization", "Bearer "+credential)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, revoke)
	if w.Code != 200 {
		t.Fatalf("revoke returned %d", w.Code)
	}
	if _, ok := ts.Verify(token); ok {
		t.Fatal("revoked token still verifies")
	}
	b.Publish(sse.Event{Path: "private-filename.md", Action: "modified"})
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		if strings.HasPrefix(sc.Text(), "data:") {
			t.Fatal("revoked stream still receives metadata")
		}
	}
	if ctx.Err() != nil {
		t.Fatal("revocation did not close stream promptly")
	}
}

func BenchmarkReviewChanges(b *testing.B) {
	for _, n := range []int{1000, 10000, 100000} {
		b.Run(fmt.Sprint(n), func(b *testing.B) {
			path := filepath.Join(b.TempDir(), "changes")
			f, err := os.Create(path)
			if err != nil {
				b.Fatal(err)
			}
			enc := json.NewEncoder(f)
			for i := 0; i < n; i++ {
				if err := enc.Encode(changelog.Entry{TS: int64(i + 1), Path: fmt.Sprintf("notes/%d.md", i%1000), Hash: strings.Repeat("a", 64), Action: "modified"}); err != nil {
					b.Fatal(err)
				}
			}
			f.Close()
			c := changelog.New(path)
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, err := c.Since(int64(n)); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func BenchmarkReviewCursor(b *testing.B) {
	for _, n := range []int{1000, 10000, 100000} {
		b.Run(fmt.Sprint(n), func(b *testing.B) {
			path := filepath.Join(b.TempDir(), "changes")
			f, err := os.Create(path)
			if err != nil {
				b.Fatal(err)
			}
			enc := json.NewEncoder(f)
			for i := 0; i < n; i++ {
				if err := enc.Encode(changelog.Entry{TS: int64(i + 1), Path: fmt.Sprintf("notes/%d.md", i%1000), Hash: strings.Repeat("a", 64), Action: "modified"}); err != nil {
					b.Fatal(err)
				}
			}
			f.Close()
			c := changelog.New(path)
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, err := c.PageAfter(int64(n), 256); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func TestReviewPendingMutationRecovery(t *testing.T) {
	for _, alreadyLogged := range []bool{false, true} {
		t.Run(fmt.Sprint(alreadyLogged), func(t *testing.T) {
			dir := t.TempDir()
			s := store.New(filepath.Join(dir, "vault"))
			hash, err := s.PutBlob([]byte("recovered"))
			if err != nil {
				t.Fatal(err)
			}
			e := changelog.Entry{ID: "test-operation", Path: "a.md", Hash: hash, Action: "modified", TS: 100}
			cl := changelog.New(filepath.Join(dir, "changes"))
			if alreadyLogged {
				if err := cl.Append(e); err != nil {
					t.Fatal(err)
				}
			}
			data, _ := json.Marshal(e)
			if err := os.WriteFile(filepath.Join(s.Root(), "pending-change.json"), data, 0600); err != nil {
				t.Fatal(err)
			}
			ts, err := tokens.New(filepath.Join(dir, "tokens"))
			if err != nil {
				t.Fatal(err)
			}
			reopened := store.New(s.Root())
			h := handler.New(reopened, changelog.New(filepath.Join(dir, "changes")), sse.NewBroker(), ts)
			if err := h.ReadyError(); err != nil {
				t.Fatal(err)
			}
			got, err := reopened.ReadFile("a.md")
			if err != nil || string(got) != "recovered" {
				t.Fatalf("recovery failed: %q %v", got, err)
			}
			entries, err := changelog.New(filepath.Join(dir, "changes")).Since(0)
			if err != nil || len(entries) != 1 {
				t.Fatalf("replay must be exactly once: %d %v", len(entries), err)
			}
		})
	}
}

func TestReviewCorruptIndexFailsClosed(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.json"), []byte("{broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if store.New(dir).Err() == nil {
		t.Fatal("corrupt index silently accepted")
	}
}

func TestReviewChangelogTailAndRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "changes")
	c := changelog.New(path)
	if err := c.Append(changelog.Entry{Path: "a.md", Action: "modified", TS: 100}); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.WriteString(`{"ts":100,"path":"incomplete`)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.Close(); err != nil {
		t.Fatal(err)
	}
	c = changelog.New(path)
	if err = c.Append(changelog.Entry{Path: "b.md", Action: "modified", TS: 100}); err != nil {
		t.Fatal(err)
	}
	page, err := changelog.New(path).PageAfter(1, 256)
	if err != nil || len(page.Changes) != 1 || page.Changes[0].Path != "b.md" || page.Cursor != 2 {
		t.Fatalf("unstable cursor after partial tail recovery: %+v %v", page, err)
	}
}

func TestReviewPinnedVersion(t *testing.T) {
	h, s, _, _ := reviewHandler(t, "")
	reviewPut(h, "a.md", "", []byte("first"))
	hash, _ := s.GetHash("a.md")
	reviewPut(h, "a.md", hash, []byte("second"))
	r := httptest.NewRequest("GET", "/file/a.md?hash="+hash, nil)
	r.Header.Set("Authorization", "Bearer review-only")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || w.Body.String() != "first" {
		t.Fatalf("pinned version changed: %d %q", w.Code, w.Body.String())
	}
}

func TestReviewIndexFailureRecoveredBeforeReads(t *testing.T) {
	h, s, _, _ := reviewHandler(t, "")
	index := filepath.Join(s.Root(), "index.json")
	if err := os.Mkdir(index, 0700); err != nil {
		t.Fatal(err)
	}
	w := reviewPut(h, "a.md", "", []byte("committed after repair"))
	if w.Code != 503 {
		t.Fatalf("failed index save acknowledged: %d", w.Code)
	}
	if err := os.Remove(index); err != nil {
		t.Fatal(err)
	}
	if err := h.ReadyError(); err != nil {
		t.Fatal(err)
	}
	data, err := s.ReadFile("a.md")
	if err != nil || string(data) != "committed after repair" {
		t.Fatalf("recovery failed: %q %v", data, err)
	}
}
