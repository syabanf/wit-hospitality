// Package storage is the files context's port to where uploaded bytes live: a local directory or
// an S3-compatible bucket, chosen by FILES_STORAGE.
package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
)

// ErrNotFound is a key the storage does not hold.
var ErrNotFound = errors.New("file not found")

// Storage keeps one object per key with its content type.
type Storage interface {
	Put(ctx context.Context, key, contentType string, data []byte) error
	// Get opens the object; the caller closes it.
	Get(ctx context.Context, key string) (io.ReadCloser, string, error)
	Kind() string
}

// FromEnv builds the storage the environment names: FILES_STORAGE=local (default) with FILES_DIR,
// or FILES_STORAGE=s3 with S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID and
// S3_SECRET_ACCESS_KEY.
func FromEnv() (Storage, error) {
	switch kind := os.Getenv("FILES_STORAGE"); kind {
	case "", "local":
		dir := os.Getenv("FILES_DIR")
		if dir == "" {
			dir = os.TempDir() + "/wit-files"
		}
		return Local{Dir: dir}, nil
	case "s3":
		s := S3{
			Endpoint: os.Getenv("S3_ENDPOINT"), Bucket: os.Getenv("S3_BUCKET"), Region: os.Getenv("S3_REGION"),
			AccessKey: os.Getenv("S3_ACCESS_KEY_ID"), SecretKey: os.Getenv("S3_SECRET_ACCESS_KEY"),
		}
		if s.Region == "" {
			s.Region = "us-east-1"
		}
		if s.Endpoint == "" || s.Bucket == "" || s.AccessKey == "" || s.SecretKey == "" {
			return nil, errors.New("configuration: FILES_STORAGE=s3 needs S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY")
		}
		return s, nil
	default:
		return nil, fmt.Errorf("configuration: FILES_STORAGE must be local or s3, not %q", kind)
	}
}
