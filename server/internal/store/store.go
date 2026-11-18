package store

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"

	"github.com/PeoneEr/self-hosted-vault-sync-server/internal/atomicfile"
)

// Store manages vault files using content-addressable blob storage.
// Files are stored as blobs/{sha256[:2]}/{sha256[2:]} with a path→hash
// index in index.json. This decouples storage from filesystem naming
// constraints (no 255-byte filename limit regardless of vault path length).
type Store struct {
	root string
	mu   sync.RWMutex
	idx  map[string]string // vault path → content sha256hex
	err  error
}

func New(root string) *Store {
	s := &Store{root: filepath.Clean(root), idx: make(map[string]string)}
	s.err = os.MkdirAll(filepath.Join(root, "blobs"), 0755)
	if s.err == nil {
		s.err = s.loadIndex()
	}
	return s
}

func (s *Store) Err() error   { return s.err }
func (s *Store) Root() string { return s.root }

func (s *Store) blobPath(contentHash string) string {
	return filepath.Join(s.root, "blobs", contentHash[:2], contentHash[2:])
}

func (s *Store) indexPath() string {
	return filepath.Join(s.root, "index.json")
}

func (s *Store) loadIndex() error {
	data, err := os.ReadFile(s.indexPath())
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := json.Unmarshal(data, &s.idx); err != nil {
		return err
	}
	if s.idx == nil {
		return fmt.Errorf("invalid null index")
	}
	for _, hash := range s.idx {
		if len(hash) != 64 {
			return fmt.Errorf("invalid content hash in index")
		}
		for _, c := range hash {
			if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
				return fmt.Errorf("invalid content hash in index")
			}
		}
	}
	return nil
}

func (s *Store) saveIndex() error {
	data, err := json.Marshal(s.idx)
	if err != nil {
		return err
	}
	return atomicfile.Write(s.indexPath(), data, 0600)
}

func (s *Store) GetHash(path string) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	h, ok := s.idx[path]
	return h, ok
}

func (s *Store) ReadFile(path string) ([]byte, error) {
	s.mu.RLock()
	h, ok := s.idx[path]
	s.mu.RUnlock()
	if !ok {
		return nil, os.ErrNotExist
	}
	return os.ReadFile(s.blobPath(h))
}

func (s *Store) ReadBlob(hash string) ([]byte, error) {
	if len(hash) != 64 {
		return nil, fmt.Errorf("invalid content hash")
	}
	for _, c := range hash {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return nil, fmt.Errorf("invalid content hash")
		}
	}
	return os.ReadFile(s.blobPath(hash))
}

func (s *Store) WriteFile(path string, data []byte) error {
	h, err := s.PutBlob(data)
	if err != nil {
		return err
	}
	return s.SetHash(path, h)
}

// PutBlob prepares immutable content before committing its metadata.
func (s *Store) PutBlob(data []byte) (string, error) {
	if s.err != nil {
		return "", s.err
	}
	h := sha256hex(data)
	bp := s.blobPath(h)
	if _, err := os.Stat(bp); err == nil {
		return h, nil
	}
	if err := os.MkdirAll(filepath.Dir(bp), 0755); err != nil {
		return "", err
	}
	if err := atomicfile.SyncDir(filepath.Join(s.root, "blobs")); err != nil {
		return "", err
	}
	if err := atomicfile.Write(bp, data, 0600); err != nil {
		return "", err
	}
	return h, nil
}

// SetHash installs an already prepared blob; empty hash means deletion.
func (s *Store) SetHash(path, h string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return s.err
	}
	old, existed := s.idx[path]
	if h == "" {
		delete(s.idx, path)
	} else {
		s.idx[path] = h
	}
	if err := s.saveIndex(); err != nil {
		if existed {
			s.idx[path] = old
		} else {
			delete(s.idx, path)
		}
		return err
	}
	return nil
}

func (s *Store) DeleteFile(path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.idx[path]; !ok {
		return os.ErrNotExist
	}
	old := s.idx[path]
	delete(s.idx, path)
	if err := s.saveIndex(); err != nil {
		s.idx[path] = old
		return err
	}
	return nil
}

func (s *Store) ListAll() ([]string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	paths := make([]string, 0, len(s.idx))
	for p := range s.idx {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	return paths, nil
}

func sha256hex(data []byte) string {
	sum := sha256.Sum256(data)
	return fmt.Sprintf("%x", sum)
}
