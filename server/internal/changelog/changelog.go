package changelog

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/PeoneEr/self-hosted-vault-sync-server/internal/atomicfile"
)

type Entry struct {
	TS     int64  `json:"ts"`
	Path   string `json:"path"`
	Hash   string `json:"hash"`
	Action string `json:"action"`
	Seq    int64  `json:"seq"`
	ID     string `json:"id,omitempty"`
}

type Page struct {
	Changes []Entry `json:"changes"`
	Cursor  int64   `json:"cursor"`
	HasMore bool    `json:"hasMore"`
}

// The append log is loaded once. Record positions are stable across restarts,
// including for legacy logs without explicit sequence numbers.
type Changelog struct {
	mu      sync.RWMutex
	path    string
	entries []Entry
	latest  map[string]Entry
	err     error
}

func New(path string) *Changelog {
	c := &Changelog{path: path, latest: make(map[string]Entry)}
	c.err = c.load()
	return c
}

func (c *Changelog) load() error {
	f, err := os.OpenFile(c.path, os.O_RDWR, 0600)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	reader := bufio.NewReader(f)
	var offset int64
	for {
		line, readErr := reader.ReadBytes('\n')
		if readErr == io.EOF {
			if len(line) > 0 {
				if err := f.Truncate(offset); err != nil {
					return err
				}
				return f.Sync()
			}
			return nil
		}
		if readErr != nil {
			return readErr
		}
		var e Entry
		if err := json.Unmarshal(line, &e); err != nil {
			return fmt.Errorf("invalid changelog record: %w", err)
		}
		e.Seq = int64(len(c.entries) + 1)
		c.entries = append(c.entries, e)
		c.latest[e.Path] = e
		offset += int64(len(line))
	}
}

func (c *Changelog) Err() error { c.mu.RLock(); defer c.mu.RUnlock(); return c.err }

func (c *Changelog) Append(e Entry) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil {
		return c.err
	}
	if e.ID != "" && len(c.entries) > 0 && c.entries[len(c.entries)-1].ID == e.ID {
		return nil
	}
	e.Seq = int64(len(c.entries) + 1)
	f, err := os.OpenFile(c.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	data, err := json.Marshal(e)
	if err == nil {
		_, err = f.Write(append(data, '\n'))
	}
	if err == nil {
		err = f.Sync()
	}
	if err != nil {
		if rollback := f.Truncate(info.Size()); rollback != nil {
			c.err = rollback
		} else if syncErr := f.Sync(); syncErr != nil {
			c.err = syncErr
		}
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		c.err = err
		return err
	}
	if err = atomicfile.SyncDir(filepath.Dir(c.path)); err != nil {
		c.err = err
		return err
	}
	c.entries = append(c.entries, e)
	c.latest[e.Path] = e
	return nil
}

// Since remains available for older clients. New clients use PageAfter.
func (c *Changelog) Since(ts int64) ([]Entry, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.err != nil {
		return nil, c.err
	}
	var result []Entry
	for _, e := range c.entries {
		if e.TS > ts {
			result = append(result, e)
		}
	}
	return result, nil
}

func (c *Changelog) PageAfter(cursor int64, limit int) (Page, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.err != nil {
		return Page{}, c.err
	}
	if cursor < 0 || cursor > int64(len(c.entries)) {
		return Page{}, fmt.Errorf("invalid cursor; reconnect and reconcile this vault")
	}
	if limit < 1 || limit > 256 {
		limit = 256
	}
	end := cursor + int64(limit)
	if end > int64(len(c.entries)) {
		end = int64(len(c.entries))
	}
	changes := append([]Entry{}, c.entries[cursor:end]...)
	return Page{Changes: changes, Cursor: end, HasMore: end < int64(len(c.entries))}, nil
}

func (c *Changelog) Latest(path string) (Entry, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, ok := c.latest[path]
	return e, ok
}

func (c *Changelog) Conflicts() []Entry {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := []Entry{}
	for _, e := range c.latest {
		if e.Action == "modified" && strings.Contains(e.Path, ".conflict.") {
			out = append(out, e)
		}
	}
	return out
}
