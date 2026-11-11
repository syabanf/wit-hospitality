// Package http maps the inventory context onto the contract paths the TypeScript HTTP adapter
// calls for the stock port, including the minibar check on a booking.
package http

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/inventory/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
)

// Commands are the inventory write handlers.
type Commands struct {
	CreateItem     command.CreateItem
	UpdateItem     command.UpdateItem
	Receive        command.Receive
	CorrectReceipt command.CorrectReceipt
	CancelReceipt  command.CancelReceipt
	Move           command.Move
	TakeCount      command.TakeCount
	SaveKit        command.SaveKit
	LinkMinibar    command.LinkMinibar
	MinibarCheck   command.MinibarCheck
}

// Handler serves the inventory routes.
type Handler struct {
	Commands Commands
	Queries  query.Queries
	Log      *slog.Logger
}

func list[T any](log *slog.Logger, read func(r *http.Request) ([]T, error)) http.HandlerFunc {
	return httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		out, err := read(r)
		if err != nil {
			return err
		}
		if out == nil {
			out = []T{}
		}
		httpx.OK(w, out)
		return nil
	})
}

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

// Routes registers the routes under /api/v1.
func (h Handler) Routes(r chi.Router) {
	c, q, log := h.Commands, h.Queries, h.Log
	id := func(r *http.Request) string { return chi.URLParam(r, "id") }

	r.Get("/stock/items", list(log, func(r *http.Request) ([]domain.Item, error) { return q.Items(r.Context()) }))
	r.Post("/stock/items", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.ItemInput) (domain.Item, error) {
		return c.CreateItem.Handle(r.Context(), p, in)
	}))
	r.Patch("/stock/items/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.ItemInput) (domain.Item, error) {
		return c.UpdateItem.Handle(r.Context(), p, id(r), in)
	}))

	r.Get("/stock/movements", list(log, func(r *http.Request) ([]domain.Movement, error) { return q.Movements(r.Context()) }))
	r.Post("/stock/movements", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.MoveInput) ([]domain.Movement, error) {
		return c.Move.Handle(r.Context(), p, in)
	}))

	r.Get("/stock/receipts", list(log, func(r *http.Request) ([]domain.StockReceipt, error) { return q.Receipts(r.Context()) }))
	r.Post("/stock/receipts", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.ReceiptInput) (domain.StockReceipt, error) {
		return c.Receive.Handle(r.Context(), p, in)
	}))
	r.Put("/stock/receipts/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in command.ReceiptCorrection) (domain.StockReceipt, error) {
		return c.CorrectReceipt.Handle(r.Context(), p, id(r), in)
	}))
	r.Post("/stock/receipts/{id}/cancel", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in command.CancelInput) (domain.StockReceipt, error) {
		return c.CancelReceipt.Handle(r.Context(), p, id(r), in)
	}))

	r.Get("/stock/counts", list(log, func(r *http.Request) ([]domain.Count, error) { return q.Counts(r.Context()) }))
	r.Post("/stock/counts", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.CountInput) (domain.Count, error) {
		return c.TakeCount.Handle(r.Context(), p, in)
	}))

	r.Get("/stock/kits", list(log, func(r *http.Request) ([]domain.Kit, error) { return q.Kits(r.Context()) }))
	r.Put("/stock/kits/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in command.KitInput) (domain.Kit, error) {
		return c.SaveKit.Handle(r.Context(), p, id(r), in)
	}))

	r.Get("/stock/minibar-links", list(log, func(r *http.Request) ([]domain.MinibarLink, error) { return q.Links(r.Context()) }))
	r.Put("/stock/minibar-links/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in command.LinkInput) ([]domain.MinibarLink, error) {
		return c.LinkMinibar.Handle(r.Context(), p, id(r), in)
	}))

	r.Post("/bookings/{id}/minibar-checks", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.MinibarCheckInput) (command.ServiceOrder, error) {
		return c.MinibarCheck.Handle(r.Context(), p, id(r), in)
	}))
}
