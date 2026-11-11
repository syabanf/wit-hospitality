// Package http maps the services context onto the contract paths the TypeScript HTTP adapter
// calls for the service request and order ports.
package http

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
	"github.com/syabanf/wit-hospitality/api/internal/services/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/services/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/services/domain"
)

// Commands are the services write handlers.
type Commands struct {
	SaveMenuItem  command.SaveMenuItem
	SavePartner   command.SavePartner
	PlaceOrder    command.PlaceOrder
	StepOrder     command.StepOrder
	AssignOrder   command.AssignOrder
	Room          command.Room
	CreateRequest command.CreateRequest
	UpdateRequest command.UpdateRequest
	StepRequest   command.StepRequest
}

// Handler serves the services routes.
type Handler struct {
	Commands Commands
	Queries  query.Queries
	Log      *slog.Logger
}

// orderActions is ORDER_ACTION in the HTTP adapter: path segment to order status.
var orderActions = map[string]string{
	"accept": domain.OrderConfirmed, "prepare": domain.OrderPreparing, "deliver": domain.OrderDelivered,
	"cancel": domain.OrderCancelled, "void": domain.OrderVoided,
}

// requestActions maps the request transition paths to statuses.
var requestActions = map[string]string{"start": domain.RequestInProgress, "done": domain.RequestDone, "cancel": domain.RequestCancelled}

func (h Handler) list(table string) http.HandlerFunc {
	return httpx.Handle(h.Log, func(w http.ResponseWriter, r *http.Request) error {
		out, err := h.Queries.List(r.Context(), table)
		if err != nil {
			return err
		}
		if out == nil {
			out = []json.RawMessage{}
		}
		httpx.OK(w, out)
		return nil
	})
}

// write decodes the body, runs the command as the signed-in user and answers with status.
func write[In, Out any](log *slog.Logger, status int, run func(r *http.Request, p auth.Principal, in In) (Out, error)) http.HandlerFunc {
	return httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		p, err := auth.Require(r.Context())
		if err != nil {
			return err
		}
		var in In
		if err := httpx.Decode(r, &in); err != nil {
			return err
		}
		out, err := run(r, p, in)
		if err != nil {
			return err
		}
		httpx.JSON(w, status, out)
		return nil
	})
}

// public answers a token page without a session.
func public[Out any](log *slog.Logger, run func(r *http.Request) (Out, error)) http.HandlerFunc {
	return httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		out, err := run(r)
		if err != nil {
			return err
		}
		httpx.OK(w, out)
		return nil
	})
}

// note reads the optional { note } a board step carries.
func note(r *http.Request) (string, error) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, httpx.MaxBody+1))
	if err != nil || len(raw) == 0 {
		return "", err
	}
	var in struct {
		Note string `json:"note"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return "", errs.New(errs.CodeValidation, "The request body is not valid JSON.")
	}
	return in.Note, nil
}

// Routes registers the routes under /api/v1.
func (h Handler) Routes(r chi.Router) {
	c, log := h.Commands, h.Log
	id := func(r *http.Request) string { return chi.URLParam(r, "id") }
	token := func(r *http.Request) string { return chi.URLParam(r, "token") }

	r.Get("/menu-items", h.list(query.MenuItems))
	r.Post("/menu-items", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.MenuItemInput) (domain.MenuItem, error) {
		return c.SaveMenuItem.Handle(r.Context(), p, "", in)
	}))
	r.Patch("/menu-items/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.MenuItemInput) (domain.MenuItem, error) {
		return c.SaveMenuItem.Handle(r.Context(), p, id(r), in)
	}))

	r.Get("/service-partners", h.list(query.Partners))
	r.Post("/service-partners", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.PartnerInput) (domain.ServicePartner, error) {
		return c.SavePartner.Handle(r.Context(), p, "", in)
	}))
	r.Patch("/service-partners/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.PartnerInput) (domain.ServicePartner, error) {
		return c.SavePartner.Handle(r.Context(), p, id(r), in)
	}))

	r.Get("/service-orders", h.list(query.Orders))
	r.Post("/service-orders", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.OrderInput) (domain.ServiceOrder, error) {
		return c.PlaceOrder.Handle(r.Context(), p, in)
	}))
	r.Patch("/service-orders/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in struct {
		Assignee string `json:"assignee"`
	}) (domain.ServiceOrder, error) {
		return c.AssignOrder.Handle(r.Context(), p, id(r), in.Assignee)
	}))
	for action, to := range orderActions {
		r.Post("/service-orders/{id}/"+action, httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
			p, err := auth.Require(r.Context())
			if err != nil {
				return err
			}
			n, err := note(r)
			if err != nil {
				return err
			}
			out, err := c.StepOrder.Handle(r.Context(), p, id(r), to, n)
			if err != nil {
				return err
			}
			httpx.OK(w, out)
			return nil
		}))
	}

	// The QR card's menu page is public: the token is the credential.
	r.Get("/order/{token}", public(log, func(r *http.Request) (command.PublicMenu, error) {
		return c.Room.View(r.Context(), token(r))
	}))
	r.Post("/order/{token}", public(log, func(r *http.Request) (command.PublicMenu, error) {
		var in domain.OrderInput
		if err := httpx.Decode(r, &in); err != nil {
			return command.PublicMenu{}, err
		}
		return c.Room.Place(r.Context(), token(r), in)
	}))
	r.Post("/order/{token}/pay", public(log, func(r *http.Request) (json.RawMessage, error) {
		return c.Room.Pay(r.Context(), token(r))
	}))

	r.Get("/service-requests", h.list(query.Requests))
	r.Post("/service-requests", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.ServiceRequestInput) (domain.ServiceRequest, error) {
		return c.CreateRequest.Handle(r.Context(), p, in)
	}))
	r.Patch("/service-requests/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in map[string]json.RawMessage) (domain.ServiceRequest, error) {
		patch, err := requestPatch(in)
		if err != nil {
			return domain.ServiceRequest{}, err
		}
		return c.UpdateRequest.Handle(r.Context(), p, id(r), patch)
	}))
	for action, to := range requestActions {
		r.Post("/service-requests/{id}/"+action, httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
			p, err := auth.Require(r.Context())
			if err != nil {
				return err
			}
			out, err := c.StepRequest.Handle(r.Context(), p, id(r), to)
			if err != nil {
				return err
			}
			httpx.OK(w, out)
			return nil
		}))
	}
}

// requestPatch tells the console's three PATCH bodies apart: the full form (it carries kind), an
// assignee, or a transaction id.
func requestPatch(in map[string]json.RawMessage) (command.RequestPatch, error) {
	bad := errs.New(errs.CodeValidation, "The request body is not valid JSON.")
	if _, ok := in["kind"]; ok {
		raw, _ := json.Marshal(in)
		var form domain.ServiceRequestInput
		if json.Unmarshal(raw, &form) != nil {
			return command.RequestPatch{}, bad
		}
		return command.RequestPatch{Input: &form}, nil
	}
	if raw, ok := in["assignee"]; ok {
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return command.RequestPatch{}, bad
		}
		return command.RequestPatch{Assignee: &s}, nil
	}
	if raw, ok := in["transactionId"]; ok {
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return command.RequestPatch{}, bad
		}
		return command.RequestPatch{TransactionID: &s}, nil
	}
	return command.RequestPatch{}, errs.New(errs.CodeValidation, "Send the request's fields, an assignee or a transaction id.")
}
