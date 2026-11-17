package http

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

// stayRoutes serves the guest's stay page. Every /stay route is public: the token is the
// credential, and each token spends its own allowance of reads and writes per window.
func (h Handler) stayRoutes(r chi.Router) {
	c, log := h.Commands, h.Log
	r.Post("/bookings/{id}/stay-link", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		p, err := auth.Require(r.Context())
		if err != nil {
			return err
		}
		out, err := c.IssueStayLink.Handle(r.Context(), p, chi.URLParam(r, "id"))
		if err != nil {
			return err
		}
		httpx.OK(w, out)
		return nil
	}))

	type empty struct{}
	r.Route("/stay/{token}", func(r chi.Router) {
		r.Use(h.limitStay)
		r.Get("/", stayCall(log, func(r *http.Request, token string, _ empty) (any, error) { return c.StayPage.View(r.Context(), token) }))
		r.Post("/clean", stayCall(log, func(r *http.Request, token string, in struct {
			Note string `json:"note"`
		}) (any, error) {
			return c.StayPage.AskClean(r.Context(), token, in.Note)
		}))
		r.Put("/service-window", stayCall(log, func(r *http.Request, token string, in domain.ServiceWindow) (any, error) {
			return c.StayPage.SetServiceWindow(r.Context(), token, in)
		}))
		r.Post("/orders", stayCall(log, func(r *http.Request, token string, in json.RawMessage) (any, error) {
			return c.StayPage.Order(r.Context(), token, in)
		}))
		r.Post("/requests", stayCall(log, func(r *http.Request, token string, in domain.GuestRequestInput) (any, error) {
			return c.StayPage.Request(r.Context(), token, in)
		}))
		r.Get("/late-checkout", stayCall(log, func(r *http.Request, token string, _ empty) (any, error) {
			return c.StayPage.QuoteLateCheckout(r.Context(), token, r.URL.Query().Get("until"))
		}))
		r.Post("/late-checkout", stayCall(log, func(r *http.Request, token string, in command.LateCheckoutInput) (any, error) {
			return c.StayPage.LateCheckOut(r.Context(), token, in.Until)
		}))
		r.Post("/complaints", stayCall(log, func(r *http.Request, token string, in command.StayComplaintInput) (any, error) {
			return c.StayPage.Complain(r.Context(), token, in)
		}))
		r.Put("/preferences", stayCall(log, func(r *http.Request, token string, in domain.Preferences) (any, error) {
			return c.StayPage.SetPreferences(r.Context(), token, in)
		}))
	})
}

// limitStay refuses a token past its reads or writes for the window (RATE_LIMITED).
func (h Handler) limitStay(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if h.Limiter != nil {
			key, limit := "r:", domain.GuestReadLimit
			if r.Method != http.MethodGet {
				key, limit = "w:", domain.GuestActionLimit
			}
			if !h.Limiter.Take(key+chi.URLParam(r, "token"), limit) {
				httpx.WriteError(w, r, h.Log, httpx.ErrRateLimited())
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// stayCall decodes the body of a write (none on a GET) and answers 200 with what run returns.
func stayCall[In any](log *slog.Logger, run func(r *http.Request, token string, in In) (any, error)) http.HandlerFunc {
	return httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		var in In
		if r.Method != http.MethodGet {
			if err := httpx.Decode(r, &in); err != nil {
				return err
			}
		}
		out, err := run(r, chi.URLParam(r, "token"), in)
		if err != nil {
			return err
		}
		httpx.OK(w, out)
		return nil
	})
}
