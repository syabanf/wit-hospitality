package storage

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Local keeps each object as a file under Dir, with its content type in a .type file beside it.
type Local struct{ Dir string }

// Kind names the storage for logs.
func (Local) Kind() string { return "local" }

func (l Local) path(key string) (string, error) {
	if key == "" || strings.ContainsAny(key, `/\`) || strings.HasPrefix(key, ".") {
		return "", ErrNotFound
	}
	return filepath.Join(l.Dir, key), nil
}

// Put writes the object.
func (l Local) Put(_ context.Context, key, contentType string, data []byte) error {
	p, err := l.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(l.Dir, 0o750); err != nil {
		return err
	}
	if err := os.WriteFile(p, data, 0o640); err != nil {
		return err
	}
	return os.WriteFile(p+".type", []byte(contentType), 0o640)
}

// Get opens the object.
func (l Local) Get(_ context.Context, key string) (io.ReadCloser, string, error) {
	p, err := l.path(key)
	if err != nil {
		return nil, "", err
	}
	f, err := os.Open(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, "", ErrNotFound
	}
	if err != nil {
		return nil, "", err
	}
	kind, err := os.ReadFile(p + ".type")
	if err != nil {
		_ = f.Close()
		return nil, "", err
	}
	return f, string(kind), nil
}
