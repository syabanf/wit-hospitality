package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
)

// Cookie names. Both are httpOnly, SameSite=Lax and scoped to the API path.
const (
	AccessCookie  = "wit_access"
	RefreshCookie = "wit_refresh"
	cookiePath    = "/api/v1"
)

// Cookies writes and clears the session cookies.
type Cookies struct {
	Secure bool
}

// Write sets both cookies, or the access cookie alone when the session kept its refresh token.
func (c Cookies) Write(w http.ResponseWriter, s Session, now time.Time) {
	http.SetCookie(w, &http.Cookie{Name: AccessCookie, Value: s.AccessToken, Path: cookiePath, HttpOnly: true, Secure: c.Secure, SameSite: http.SameSiteLaxMode, MaxAge: int(s.AccessExpires.Sub(now).Seconds())})
	if s.RefreshToken != "" {
		http.SetCookie(w, &http.Cookie{Name: RefreshCookie, Value: s.RefreshToken, Path: cookiePath, HttpOnly: true, Secure: c.Secure, SameSite: http.SameSiteLaxMode, MaxAge: int(s.RefreshExpires.Sub(now).Seconds())})
	}
}

// Clear removes both cookies.
func (c Cookies) Clear(w http.ResponseWriter) {
	for _, name := range []string{AccessCookie, RefreshCookie} {
		http.SetCookie(w, &http.Cookie{Name: name, Value: "", Path: cookiePath, HttpOnly: true, Secure: c.Secure, SameSite: http.SameSiteLaxMode, MaxAge: -1})
	}
}

// Middleware loads the principal from the access token (cookie or Bearer header). When the access
// token is missing or expired and a refresh cookie is present, it rotates the session through
// refresher and sets fresh cookies on the response. Requests without a session pass through
// anonymous; handlers that need one call Require.
func Middleware(issuer Issuer, refresher Refresher, cookies Cookies, clk clock.Clock, log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			now := clk.Now()
			token := ""
			if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
				token = strings.TrimPrefix(h, "Bearer ")
			} else if c, err := r.Cookie(AccessCookie); err == nil {
				token = c.Value
			}
			if token != "" {
				if p, err := issuer.Verify(token, now); err == nil {
					next.ServeHTTP(w, r.WithContext(attach(r.Context(), p)))
					return
				}
			}
			if rc, err := r.Cookie(RefreshCookie); err == nil && rc.Value != "" && refresher != nil {
				s, err := refresher.Refresh(r.Context(), rc.Value)
				if err == nil {
					cookies.Write(w, s, now)
					next.ServeHTTP(w, r.WithContext(attach(r.Context(), s.Principal)))
					return
				}
				if e, ok := errs.As(err); ok && (e.Code == errs.CodeUnauthenticated || e.Code == "USER_INACTIVE") {
					cookies.Clear(w)
				} else {
					log.WarnContext(r.Context(), "silent refresh failed", slog.String("error", err.Error()))
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

func attach(ctx context.Context, p Principal) context.Context {
	return logging.WithUserID(WithPrincipal(ctx, p), p.UserID)
}

// HTTPRefresher calls the identity service's internal refresh endpoint in split mode.
type HTTPRefresher struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

// Refresh posts the token to identity and returns the rotated session.
func (h HTTPRefresher) Refresh(ctx context.Context, refreshToken string) (Session, error) {
	body, _ := json.Marshal(map[string]string{"refreshToken": refreshToken})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.BaseURL+"/internal/v1/sessions/refresh", bytes.NewReader(body))
	if err != nil {
		return Session{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", h.Token)
	client := h.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return Session{}, err
	}
	defer res.Body.Close()
	var out struct {
		Data  *Session `json:"data"`
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return Session{}, fmt.Errorf("identity refresh: %s: %w", res.Status, err)
	}
	if out.Error != nil {
		return Session{}, errs.New(out.Error.Code, out.Error.Message)
	}
	if out.Data == nil {
		return Session{}, fmt.Errorf("identity refresh: empty answer (%s)", res.Status)
	}
	return *out.Data, nil
}
