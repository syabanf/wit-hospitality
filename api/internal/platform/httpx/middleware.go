package httpx

import (
	"crypto/subtle"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/ids"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
)

// RequestID takes X-Request-ID from the caller or makes one, and echoes it.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if id == "" || len(id) > 64 {
			id = ids.Random("req")
		}
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r.WithContext(logging.WithRequestID(r.Context(), id)))
	})
}

// statusWriter remembers the status for the access log.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// Recover turns a panic into a 500 problem and logs the stack.
func Recover(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if p := recover(); p != nil {
					if p == http.ErrAbortHandler {
						panic(p)
					}
					log.ErrorContext(r.Context(), "panic", slog.String("panic", fmt.Sprint(p)), slog.String("stack", string(debug.Stack())))
					WriteError(w, r, log, errs.New(errs.CodeInternal, "Something went wrong on our side. Try again."))
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// AccessLog writes one line per request.
func AccessLog(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			sw := &statusWriter{ResponseWriter: w}
			next.ServeHTTP(sw, r)
			log.InfoContext(r.Context(), "http",
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.Int("status", sw.status),
				slog.Duration("duration", time.Since(start)))
		})
	}
}

// CORS allows the listed origins with credentials, which the front end's fetch sends.
func CORS(origins []string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" && slices.Contains(origins, origin) {
				h := w.Header()
				h.Set("Access-Control-Allow-Origin", origin)
				h.Set("Access-Control-Allow-Credentials", "true")
				h.Add("Vary", "Origin")
				if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
					h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
					h.Set("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key, X-Request-ID")
					h.Set("Access-Control-Max-Age", "600")
					w.WriteHeader(http.StatusNoContent)
					return
				}
				h.Set("Access-Control-Expose-Headers", "X-Request-ID")
			}
			next.ServeHTTP(w, r)
		})
	}
}

// InternalOnly guards service-to-service routes with a shared token.
func InternalOnly(token string, log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			got := r.Header.Get("X-Internal-Token")
			if token == "" || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
				WriteError(w, r, log, errs.Forbidden("Internal route."))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// NewRouter returns a chi router with the base middleware and JSON 404/405 answers.
func NewRouter(log *slog.Logger, origins []string) *chi.Mux {
	r := chi.NewRouter()
	r.Use(RequestID, Recover(log), AccessLog(log), CORS(origins))
	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		WriteError(w, r, log, errs.New(errs.CodeNotFound, "No route for "+r.Method+" "+r.URL.Path+"."))
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		WriteError(w, r, log, errs.New("METHOD_NOT_ALLOWED", r.Method+" is not allowed on "+r.URL.Path+"."))
	})
	return r
}

// Route is one registered method and pattern.
type Route struct {
	Method  string `json:"method"`
	Pattern string `json:"pattern"`
}

// ListRoutes walks the router; the contract script compares this list with the TS adapter.
func ListRoutes(r chi.Routes) []Route {
	var out []Route
	_ = chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		route = strings.TrimSuffix(strings.ReplaceAll(route, "/*/", "/"), "/")
		out = append(out, Route{Method: method, Pattern: route})
		return nil
	})
	slices.SortFunc(out, func(a, b Route) int {
		if c := strings.Compare(a.Pattern, b.Pattern); c != 0 {
			return c
		}
		return strings.Compare(a.Method, b.Method)
	})
	return out
}
