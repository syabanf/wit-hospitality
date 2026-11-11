package projector

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
)

// ReadYourWrites holds a successful write's response until this process's read models have
// applied the events the write appended, for at most timeout. The front end reloads a list right
// after saving; without the wait it could read the list before the projector caught up.
func ReadYourWrites(p *Projector, timeout time.Duration, log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions || p == nil {
				next.ServeHTTP(w, r)
				return
			}
			ctx, collected := outbox.WithCollector(r.Context())
			buf := httpx.NewBuffer()
			next.ServeHTTP(buf, r.WithContext(ctx))
			if buf.Status < 400 {
				if events := collected.Events(); len(events) > 0 {
					if err := p.AwaitChain(ctx, logging.RequestID(ctx), events, timeout); err != nil {
						log.WarnContext(ctx, "answered before read models caught up", slog.String("error", err.Error()))
					}
				}
			}
			buf.FlushTo(w)
		})
	}
}
