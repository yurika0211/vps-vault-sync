package handler_test

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/PeoneEr/self-hosted-vault-sync-server/internal/changelog"
	"github.com/PeoneEr/self-hosted-vault-sync-server/internal/handler"
	"github.com/PeoneEr/self-hosted-vault-sync-server/internal/sse"
	"github.com/PeoneEr/self-hosted-vault-sync-server/internal/store"
	"github.com/stretchr/testify/require"
)

func TestInterruptedRestoreRecoversBeforeOtherRequests(t *testing.T) {
	dir := t.TempDir()
	ts := newTokens(t, dir)
	var files *store.Store
	var log *changelog.Changelog
	open := func() *handler.Handler {
		files = store.New(filepath.Join(dir, "vault"))
		log = changelog.New(filepath.Join(dir, "changes"))
		return handler.New(files, log, sse.NewBroker(), ts)
	}
	h := open()
	request := func(method, path string, data []byte, base string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, bytes.NewReader(data))
		req.Header.Set("Authorization", "Bearer "+testToken)
		req.Header.Set("X-Base-Hash", base)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w
	}
	for _, p := range []string{"a", "b"} {
		require.Equal(t, 200, request("PUT", "/file/"+p, []byte(p), "").Code)
	}
	snap := request("POST", "/history/snapshots", []byte(`{"name":"baseline","cursor":2}`), "")
	require.Equal(t, 200, snap.Code)
	var checkpoint struct{ ID string }
	require.NoError(t, json.Unmarshal(snap.Body.Bytes(), &checkpoint))
	var damaged string
	for _, p := range []string{"a", "b"} {
		hash, _ := files.GetHash(p)
		require.Equal(t, 200, request("PUT", "/file/"+p, []byte("changed"), hash).Code)
		if p == "b" {
			damaged = filepath.Join(files.Root(), "blobs", hash[:2], hash[2:])
		}
	}
	// The first path can be restored; the second blob is temporarily unavailable.
	require.NoError(t, os.Rename(damaged, damaged+".repair"))
	data, _ := json.Marshal(map[string]any{"id": checkpoint.ID, "cursor": log.Cursor()})
	require.Equal(t, 503, request("POST", "/history/restore", data, "").Code)
	require.Equal(t, 503, request("GET", "/file/a", nil, "").Code)
	require.NoError(t, os.Rename(damaged+".repair", damaged))
	h = open()
	require.NoError(t, h.ReadyError())
	for _, p := range []string{"a", "b"} {
		require.Equal(t, p, request("GET", "/file/"+p, nil, "").Body.String())
	}
	list := request("GET", "/history/snapshots", nil, "")
	var snapshots []struct{ Name string }
	require.NoError(t, json.Unmarshal(list.Body.Bytes(), &snapshots))
	require.Len(t, snapshots, 2)
	require.Equal(t, "恢复前 · baseline", snapshots[0].Name)
}
