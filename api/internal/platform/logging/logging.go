// Package logging builds the JSON slog logger every process uses. Each record carries the request
// id and user id found on the context, and attributes whose key looks secret are masked.
package logging

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
)

type ctxKey struct{}

// info is shared by every context derived from the request, so a user id the auth middleware
// learns later still reaches the access log written by an outer middleware.
type info struct {
	requestID string
	userID    string
}

func infoOf(ctx context.Context) *info {
	i, _ := ctx.Value(ctxKey{}).(*info)
	return i
}

// WithRequestID starts the request's log context.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, ctxKey{}, &info{requestID: id})
}

// RequestID returns the request id on ctx, or "".
func RequestID(ctx context.Context) string {
	if i := infoOf(ctx); i != nil {
		return i.requestID
	}
	return ""
}

// WithUserID records the signed-in user for every log record of the request.
func WithUserID(ctx context.Context, id string) context.Context {
	if i := infoOf(ctx); i != nil {
		i.userID = id
		return ctx
	}
	return context.WithValue(ctx, ctxKey{}, &info{userID: id})
}

// UserID returns the user id on ctx, or "".
func UserID(ctx context.Context) string {
	if i := infoOf(ctx); i != nil {
		return i.userID
	}
	return ""
}

var secretWords = []string{"password", "secret", "token", "authorization", "cookie", "hash"}

// Secret reports whether a key names something the logs must not show.
func Secret(key string) bool {
	k := strings.ToLower(key)
	for _, w := range secretWords {
		if strings.Contains(k, w) {
			return true
		}
	}
	return false
}

func mask(_ []string, a slog.Attr) slog.Attr {
	if Secret(a.Key) && a.Value.Kind() != slog.KindGroup {
		return slog.String(a.Key, "[masked]")
	}
	return a
}

type contextHandler struct{ slog.Handler }

func (h contextHandler) Handle(ctx context.Context, r slog.Record) error {
	if id := RequestID(ctx); id != "" {
		r.AddAttrs(slog.String("request_id", id))
	}
	if id := UserID(ctx); id != "" {
		r.AddAttrs(slog.String("user_id", id))
	}
	return h.Handler.Handle(ctx, r)
}

func (h contextHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return contextHandler{h.Handler.WithAttrs(attrs)}
}

func (h contextHandler) WithGroup(name string) slog.Handler {
	return contextHandler{h.Handler.WithGroup(name)}
}

// New returns a JSON logger on stdout tagged with the service name.
func New(service, level string) *slog.Logger { return NewTo(os.Stdout, service, level) }

// NewTo writes to w; tests pass io.Discard.
func NewTo(w io.Writer, service, level string) *slog.Logger {
	var lv slog.Level
	_ = lv.UnmarshalText([]byte(level))
	h := slog.NewJSONHandler(w, &slog.HandlerOptions{Level: lv, ReplaceAttr: mask})
	return slog.New(contextHandler{h}).With(slog.String("service", service))
}

// Discard drops everything.
func Discard() *slog.Logger { return NewTo(io.Discard, "test", "error") }
