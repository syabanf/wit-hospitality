package storage

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// S3 keeps objects in a bucket of an S3-compatible service (AWS S3, MinIO, R2), addressed path
// style (Endpoint/Bucket/key) and signed with AWS Signature Version 4.
type S3 struct {
	Endpoint  string
	Bucket    string
	Region    string
	AccessKey string
	SecretKey string
	Client    *http.Client
	// Now is the signing clock; nil uses time.Now.
	Now func() time.Time
}

// Kind names the storage for logs.
func (S3) Kind() string { return "s3" }

func (s S3) client() *http.Client {
	if s.Client != nil {
		return s.Client
	}
	return &http.Client{Timeout: 30 * time.Second}
}

func (s S3) objectURL(key string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimRight(s.Endpoint, "/"))
	if err != nil {
		return nil, err
	}
	u.Path += "/" + s.Bucket + "/" + key
	u.RawPath = u.EscapedPath()
	return u, nil
}

// Put uploads the object.
func (s S3) Put(ctx context.Context, key, contentType string, data []byte) error {
	res, err := s.do(ctx, http.MethodPut, key, contentType, data)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("s3 put %s: %s %s", key, res.Status, body)
	}
	return nil
}

// Get downloads the object.
func (s S3) Get(ctx context.Context, key string) (io.ReadCloser, string, error) {
	res, err := s.do(ctx, http.MethodGet, key, "", nil)
	if err != nil {
		return nil, "", err
	}
	if res.StatusCode == http.StatusNotFound {
		res.Body.Close()
		return nil, "", ErrNotFound
	}
	if res.StatusCode/100 != 2 {
		res.Body.Close()
		return nil, "", fmt.Errorf("s3 get %s: %s", key, res.Status)
	}
	return res.Body, res.Header.Get("Content-Type"), nil
}

func (s S3) do(ctx context.Context, method, key, contentType string, data []byte) (*http.Response, error) {
	u, err := s.objectURL(key)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	s.sign(req, data)
	return s.client().Do(req)
}

func hmacSHA256(key []byte, msg string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(msg))
	return h.Sum(nil)
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// sign adds the Signature Version 4 headers: host, x-amz-content-sha256 and x-amz-date are signed.
func (s S3) sign(req *http.Request, payload []byte) {
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	t := now().UTC()
	amzDate, day := t.Format("20060102T150405Z"), t.Format("20060102")
	payloadHash := sha256Hex(payload)
	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)
	signed := "host;x-amz-content-sha256;x-amz-date"
	canonical := strings.Join([]string{
		req.Method,
		req.URL.EscapedPath(),
		req.URL.RawQuery,
		"host:" + req.URL.Host + "\nx-amz-content-sha256:" + payloadHash + "\nx-amz-date:" + amzDate + "\n",
		signed,
		payloadHash,
	}, "\n")
	scope := day + "/" + s.Region + "/s3/aws4_request"
	toSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + sha256Hex([]byte(canonical))
	key := hmacSHA256(hmacSHA256(hmacSHA256(hmacSHA256([]byte("AWS4"+s.SecretKey), day), s.Region), "s3"), "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(key, toSign))
	req.Header.Set("Authorization", fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s", s.AccessKey, scope, signed, signature))
}
