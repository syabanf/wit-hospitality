package httpx

import (
	"sync"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// CodeRateLimited answers a caller that spent its allowance for the window.
const CodeRateLimited = "RATE_LIMITED"

// ErrRateLimited is RATE_LIMITED, as the public token pages word it.
func ErrRateLimited() error {
	return errs.New(CodeRateLimited, "Too many requests from this page. Wait a minute and try again.")
}

// Limiter is a fixed-window counter per key, held in the process: each replica counts on its own.
type Limiter struct {
	Window time.Duration
	Now    func() time.Time

	mu      sync.Mutex
	windows map[string]*window
}

type window struct {
	count   int
	resetAt time.Time
}

// Take spends one of key's limit for the current window and reports whether it was left.
func (l *Limiter) Take(key string, limit int) bool {
	now := time.Now()
	if l.Now != nil {
		now = l.Now()
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.windows == nil {
		l.windows = map[string]*window{}
	}
	w, ok := l.windows[key]
	if !ok || !now.Before(w.resetAt) {
		if len(l.windows) > 10000 {
			l.prune(now)
		}
		l.windows[key] = &window{count: 1, resetAt: now.Add(l.Window)}
		return true
	}
	w.count++
	return w.count <= limit
}

// prune drops the windows that ended, so idle keys do not pile up.
func (l *Limiter) prune(now time.Time) {
	for k, w := range l.windows {
		if !now.Before(w.resetAt) {
			delete(l.windows, k)
		}
	}
}
