package http

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

// signatureInput is the body the guest's pages send: the signature the files context stored.
type signatureInput struct {
	Signature *domain.Attachment `json:"signature"`
}

// frontDeskRoutes serves the registration card, early check-in, keys and wake-up calls
// (docs/contracts/front-desk-sop-contract.md), at the desk and on the guest's two pages.
func (h Handler) frontDeskRoutes(r chi.Router) {
	c, log := h.Commands.FrontDesk, h.Log
	id := func(r *http.Request) string { return chi.URLParam(r, "id") }
	r.Post("/bookings/{id}/registration-card", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.CardInput) (domain.Booking, error) {
		return c.SignCard.Handle(r.Context(), p, id(r), in)
	}))
	r.Post("/bookings/{id}/early-checkin", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in command.EarlyCheckinInput) (command.EarlyCheckinGiven, error) {
		return c.EarlyCheckIn.Handle(r.Context(), p, id(r), in)
	}))
	r.Post("/bookings/{id}/keys", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.IssueKeyInput) (domain.Booking, error) {
		return c.IssueKey.Handle(r.Context(), p, id(r), in)
	}))
	r.Post("/bookings/{id}/keys/{keyId}/return", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.ReturnKeyInput) (domain.Booking, error) {
		return c.ReturnKey.Handle(r.Context(), p, id(r), chi.URLParam(r, "keyId"), in)
	}))
	r.Post("/bookings/{id}/wake-up-calls", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.WakeUpInput) (domain.Booking, error) {
		return c.BookWakeUp.Handle(r.Context(), p, id(r), in)
	}))
	r.Post("/bookings/{id}/wake-up-calls/{callId}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.OutcomeInput) (domain.Booking, error) {
		return c.WakeUpOutcome.Handle(r.Context(), p, id(r), chi.URLParam(r, "callId"), in)
	}))

	// The online check-in link is public: the token is the credential.
	r.Post("/checkin/{token}/registration-card", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		var in signatureInput
		if err := httpx.Decode(r, &in); err != nil {
			return err
		}
		out, err := h.Commands.CheckinLink.SignCard(r.Context(), chi.URLParam(r, "token"), in.Signature)
		if err != nil {
			return err
		}
		httpx.OK(w, out)
		return nil
	}))
}

// stayFrontDeskRoutes adds the guest's card and wake-up calls to the stay page's routes.
func (h Handler) stayFrontDeskRoutes(r chi.Router) {
	page := h.Commands.StayPage
	r.Post("/registration-card", stayCall(h.Log, func(r *http.Request, token string, in signatureInput) (any, error) {
		return page.SignCard(r.Context(), token, in.Signature)
	}))
	r.Post("/wake-up-calls", stayCall(h.Log, func(r *http.Request, token string, in domain.WakeUpInput) (any, error) {
		return page.BookWakeUp(r.Context(), token, in)
	}))
}
