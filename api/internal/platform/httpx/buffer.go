package httpx

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"

	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
)

// Buffer holds a response until a middleware decides to send it.
type Buffer struct {
	header http.Header
	Status int
	Body   bytes.Buffer
}

// NewBuffer returns an empty buffer.
func NewBuffer() *Buffer { return &Buffer{header: http.Header{}} }

// Header returns the buffered headers.
func (b *Buffer) Header() http.Header { return b.header }

// WriteHeader records the status.
func (b *Buffer) WriteHeader(code int) {
	if b.Status == 0 {
		b.Status = code
	}
}

// Write buffers the body.
func (b *Buffer) Write(p []byte) (int, error) {
	if b.Status == 0 {
		b.Status = http.StatusOK
	}
	return b.Body.Write(p)
}

// FlushTo sends the buffered response.
func (b *Buffer) FlushTo(w http.ResponseWriter) {
	for k, v := range b.header {
		w.Header()[k] = v
	}
	if b.Status == 0 {
		b.Status = http.StatusOK
	}
	w.WriteHeader(b.Status)
	_, _ = w.Write(b.Body.Bytes())
}

type idempotencyKey struct{}

// IdempotencyKey returns the Idempotency-Key of the write on ctx, "" when the client sent none. A
// handler that calls another service passes a key derived from it, so a retry does not repeat
// the work there either.
func IdempotencyKey(ctx context.Context) string {
	k, _ := ctx.Value(idempotencyKey{}).(string)
	return k
}

// WithIdempotencyKey carries the write's Idempotency-Key on ctx.
func WithIdempotencyKey(ctx context.Context, key string) context.Context {
	return context.WithValue(ctx, idempotencyKey{}, key)
}

func isWrite(method string) bool {
	return method == http.MethodPost || method == http.MethodPut || method == http.MethodPatch || method == http.MethodDelete
}

// Idempotency replays the stored answer when a client repeats a write with the same
// Idempotency-Key header, and refuses the key reused for a different request. Only answers below
// 500 are stored; the front end does not send the header today, so writes without it pass through.
func Idempotency(d *db.DB, log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := r.Header.Get("Idempotency-Key")
			if key == "" || !isWrite(r.Method) || d == nil {
				next.ServeHTTP(w, r)
				return
			}
			body, err := io.ReadAll(io.LimitReader(r.Body, MaxBody+1))
			if err != nil {
				WriteError(w, r, log, errs.New(errs.CodeValidation, "The request body could not be read."))
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			sum := sha256.Sum256(append([]byte(r.Method+" "+r.URL.Path+"\n"), body...))
			hash := hex.EncodeToString(sum[:])
			user := logging.UserID(r.Context())
			ctx := r.Context()
			var storedHash string
			var status int
			var response []byte
			err = d.Pool.QueryRow(ctx, `SELECT request_hash, status, response FROM platform.idempotency_keys WHERE user_id = $1 AND key = $2`, user, key).Scan(&storedHash, &status, &response)
			if err == nil {
				if storedHash != hash {
					WriteError(w, r, log, errs.New("IDEMPOTENCY_CONFLICT", "This Idempotency-Key was used for a different request."))
					return
				}
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.Header().Set("Idempotent-Replay", "true")
				w.WriteHeader(status)
				_, _ = w.Write(response)
				return
			}
			if !db.NoRows(err) {
				WriteError(w, r, log, err)
				return
			}
			buf := NewBuffer()
			next.ServeHTTP(buf, r.WithContext(WithIdempotencyKey(ctx, key)))
			if buf.Status < 500 {
				if _, err := d.Pool.Exec(context.WithoutCancel(ctx), `
					INSERT INTO platform.idempotency_keys (user_id, key, method, path, request_hash, status, response)
					VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
					user, key, r.Method, r.URL.Path, hash, buf.Status, buf.Body.Bytes()); err != nil {
					log.WarnContext(ctx, "store idempotency key", slog.String("error", err.Error()))
				}
			}
			buf.FlushTo(w)
		})
	}
}
