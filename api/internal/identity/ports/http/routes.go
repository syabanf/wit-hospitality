// Package http maps identity's commands and queries onto the contract paths the TypeScript HTTP
// adapter calls for the access and account ports (src/infrastructure/http/index.ts).
package http

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/identity/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/identity/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/identity/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Commands are identity's write handlers.
type Commands struct {
	Login           command.Login
	Refresh         command.Refresh
	Logout          command.Logout
	ChangePassword  command.ChangePassword
	CreateUser      command.CreateUser
	UpdateUser      command.UpdateUser
	SetUserActive   command.SetUserActive
	SavePermissions command.SavePermissions
	SaveProfile     command.SaveProfile
}

// Handler serves identity's routes.
type Handler struct {
	Commands Commands
	Queries  query.Queries
	Cookies  auth.Cookies
	Clock    clock.Clock
	Log      *slog.Logger
}

// Routes registers the public routes under /api/v1.
func (h Handler) Routes(r chi.Router) {
	handle := func(f httpx.HandlerFunc) http.HandlerFunc { return httpx.Handle(h.Log, f) }
	r.Get("/auth/session", handle(h.session))
	r.Post("/auth/login", handle(h.login))
	r.Post("/auth/logout", handle(h.logout))
	r.Post("/auth/refresh", handle(h.refresh))
	r.Post("/auth/password", handle(h.changePassword))
	r.Get("/users", handle(h.users))
	r.Post("/users", handle(h.createUser))
	r.Patch("/users/{id}", handle(h.patchUser))
	r.Get("/permissions", handle(h.permissions))
	r.Put("/permissions/{role}", handle(h.savePermissions))
	r.Get("/audit", handle(h.audit))
	r.Get("/me", handle(h.profile))
	r.Put("/me", handle(h.saveProfile))
}

// InternalRoutes registers service-to-service routes under /internal/v1. Split services call them
// to renew sessions and read the matrix; the gateway does not expose them.
func (h Handler) InternalRoutes(r chi.Router) {
	handle := func(f httpx.HandlerFunc) http.HandlerFunc { return httpx.Handle(h.Log, f) }
	r.Post("/sessions/refresh", handle(func(w http.ResponseWriter, r *http.Request) error {
		var in struct {
			RefreshToken string `json:"refreshToken"`
		}
		if err := httpx.Decode(r, &in); err != nil {
			return err
		}
		s, err := h.Commands.Refresh.Refresh(r.Context(), in.RefreshToken)
		if err != nil {
			return err
		}
		httpx.OK(w, s)
		return nil
	}))
	r.Get("/permissions", handle(func(w http.ResponseWriter, r *http.Request) error {
		p, err := h.Queries.Store.Permissions(r.Context())
		if err != nil {
			return err
		}
		httpx.OK(w, p)
		return nil
	}))
}

func (h Handler) session(w http.ResponseWriter, r *http.Request) error {
	u, err := h.Queries.Session(r.Context())
	if err != nil {
		return err
	}
	if u == nil {
		httpx.OK(w, nil)
		return nil
	}
	httpx.OK(w, u)
	return nil
}

func (h Handler) login(w http.ResponseWriter, r *http.Request) error {
	var in domain.LoginInput
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	s, u, err := h.Commands.Login.Handle(r.Context(), in, r.UserAgent())
	if err != nil {
		return err
	}
	h.Cookies.Write(w, s, h.Clock.Now())
	httpx.OK(w, u)
	return nil
}

func (h Handler) logout(w http.ResponseWriter, r *http.Request) error {
	var p *auth.Principal
	if v, ok := auth.FromContext(r.Context()); ok {
		p = &v
	}
	token := ""
	if c, err := r.Cookie(auth.RefreshCookie); err == nil {
		token = c.Value
	}
	if err := h.Commands.Logout.Handle(r.Context(), p, token); err != nil {
		return err
	}
	h.Cookies.Clear(w)
	httpx.NoContent(w)
	return nil
}

// refresh renews the session from the refresh cookie and answers with the user. The middleware
// renews sessions on its own; this route serves clients that want to renew ahead of expiry.
func (h Handler) refresh(w http.ResponseWriter, r *http.Request) error {
	c, err := r.Cookie(auth.RefreshCookie)
	if err != nil || c.Value == "" {
		return errs.Unauthenticated()
	}
	s, err := h.Commands.Refresh.Refresh(r.Context(), c.Value)
	if err != nil {
		h.Cookies.Clear(w)
		return err
	}
	h.Cookies.Write(w, s, h.Clock.Now())
	u, err := h.Queries.Store.User(r.Context(), s.Principal.UserID)
	if err != nil {
		return err
	}
	httpx.OK(w, u)
	return nil
}

func (h Handler) changePassword(w http.ResponseWriter, r *http.Request) error {
	p, err := auth.Require(r.Context())
	if err != nil {
		return err
	}
	var in domain.PasswordChange
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	if err := h.Commands.ChangePassword.Handle(r.Context(), p, in); err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}

func (h Handler) users(w http.ResponseWriter, r *http.Request) error {
	list, err := h.Queries.Users(r.Context())
	if err != nil {
		return err
	}
	httpx.OK(w, list)
	return nil
}

func (h Handler) createUser(w http.ResponseWriter, r *http.Request) error {
	p, err := auth.Require(r.Context())
	if err != nil {
		return err
	}
	var in domain.UserInput
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	u, err := h.Commands.CreateUser.Handle(r.Context(), p, in)
	if err != nil {
		return err
	}
	httpx.Created(w, u)
	return nil
}

// patchUser serves two adapter calls on one path: updateUser sends the whole form, setUserActive
// sends `{ status }` alone.
func (h Handler) patchUser(w http.ResponseWriter, r *http.Request) error {
	p, err := auth.Require(r.Context())
	if err != nil {
		return err
	}
	var raw map[string]json.RawMessage
	if err := httpx.Decode(r, &raw); err != nil {
		return err
	}
	id := chi.URLParam(r, "id")
	if status, only := raw["status"]; only && len(raw) == 1 {
		var s string
		if err := json.Unmarshal(status, &s); err != nil || (s != domain.StatusActive && s != domain.StatusInactive) {
			return errs.Invalid("status", "Pick a status.")
		}
		u, err := h.Commands.SetUserActive.Handle(r.Context(), p, id, s == domain.StatusActive)
		if err != nil {
			return err
		}
		httpx.OK(w, u)
		return nil
	}
	body, _ := json.Marshal(raw)
	var in domain.UserInput
	if err := json.Unmarshal(body, &in); err != nil {
		return errs.New(errs.CodeValidation, "The request body does not match the users form.")
	}
	u, err := h.Commands.UpdateUser.Handle(r.Context(), p, id, in)
	if err != nil {
		return err
	}
	httpx.OK(w, u)
	return nil
}

func (h Handler) permissions(w http.ResponseWriter, r *http.Request) error {
	p, err := h.Queries.Permissions(r.Context())
	if err != nil {
		return err
	}
	httpx.OK(w, p)
	return nil
}

func (h Handler) savePermissions(w http.ResponseWriter, r *http.Request) error {
	p, err := auth.Require(r.Context())
	if err != nil {
		return err
	}
	var in map[rbac.Module][]rbac.Action
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	all, err := h.Commands.SavePermissions.Handle(r.Context(), p, rbac.Role(chi.URLParam(r, "role")), in)
	if err != nil {
		return err
	}
	httpx.OK(w, all)
	return nil
}

func (h Handler) audit(w http.ResponseWriter, r *http.Request) error {
	list, err := h.Queries.Audit(r.Context())
	if err != nil {
		return err
	}
	httpx.OK(w, list)
	return nil
}

func (h Handler) profile(w http.ResponseWriter, r *http.Request) error {
	p, err := h.Queries.Profile(r.Context())
	if err != nil {
		return err
	}
	httpx.OK(w, p)
	return nil
}

func (h Handler) saveProfile(w http.ResponseWriter, r *http.Request) error {
	p, err := auth.Require(r.Context())
	if err != nil {
		return err
	}
	var in domain.Profile
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	out, err := h.Commands.SaveProfile.Handle(r.Context(), p, in)
	if err != nil {
		return err
	}
	httpx.OK(w, out)
	return nil
}
