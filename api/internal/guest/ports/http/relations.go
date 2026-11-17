package http

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/guest/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/guest/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
)

// RelationsCommands are the complaint, incident and safe box write handlers.
type RelationsCommands struct {
	LogComplaint       command.LogComplaint
	UpdateComplaint    command.UpdateComplaint
	NoteComplaint      command.NoteComplaint
	MoveComplaint      command.MoveComplaint
	ResolveComplaint   command.ResolveComplaint
	DecideCompensation command.DecideCompensation
	LogIncident        command.LogIncident
	UpdateIncident     command.UpdateIncident
	FollowUpIncident   command.FollowUpIncident
	ChargeIncident     command.ChargeIncident
	CloseIncident      command.CloseIncident
	AddSafeBox         command.AddSafeBox
	UpdateSafeBox      command.UpdateSafeBox
	OpenBox            command.OpenBox
	AccessBox          command.AccessBox
	CloseBox           command.CloseBox
}

// onID runs a command on the record named in the path.
func onID[In, Out any](h Handler, run func(r *http.Request, p auth.Principal, id string, in In) (Out, error)) http.HandlerFunc {
	return write(h.Log, http.StatusOK, func(r *http.Request, p auth.Principal, in In) (Out, error) {
		return run(r, p, chi.URLParam(r, "id"), in)
	})
}

// relationRoutes registers the guest relations routes under /api/v1.
func (h Handler) relationRoutes(r chi.Router) {
	c, q, log := h.Commands.Relations, h.Queries, h.Log

	r.Get("/complaints", list(log, func(r *http.Request) ([]domain.Complaint, error) { return q.Complaints(r.Context()) }))
	r.Post("/complaints", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.ComplaintInput) (domain.Complaint, error) {
		return c.LogComplaint.Handle(r.Context(), p, in)
	}))
	r.Patch("/complaints/{id}", onID(h, func(r *http.Request, p auth.Principal, id string, in domain.ComplaintInput) (domain.Complaint, error) {
		return c.UpdateComplaint.Handle(r.Context(), p, id, in)
	}))
	r.Post("/complaints/{id}/notes", onID(h, func(r *http.Request, p auth.Principal, id string, in command.NoteBody) (domain.Complaint, error) {
		return c.NoteComplaint.Handle(r.Context(), p, id, in)
	}))
	r.Post("/complaints/{id}/move", onID(h, func(r *http.Request, p auth.Principal, id string, in command.MoveBody) (domain.Complaint, error) {
		return c.MoveComplaint.Handle(r.Context(), p, id, in)
	}))
	r.Post("/complaints/{id}/resolve", onID(h, func(r *http.Request, p auth.Principal, id string, in domain.ResolveInput) (domain.Complaint, error) {
		return c.ResolveComplaint.Handle(r.Context(), p, id, in)
	}))
	r.Post("/complaints/{id}/compensation", onID(h, func(r *http.Request, p auth.Principal, id string, in domain.CompensationDecision) (domain.Complaint, error) {
		return c.DecideCompensation.Handle(r.Context(), p, id, in)
	}))

	r.Get("/incidents", list(log, func(r *http.Request) ([]domain.Incident, error) { return q.Incidents(r.Context()) }))
	r.Post("/incidents", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.IncidentInput) (domain.Incident, error) {
		return c.LogIncident.Handle(r.Context(), p, in)
	}))
	r.Patch("/incidents/{id}", onID(h, func(r *http.Request, p auth.Principal, id string, in domain.IncidentInput) (domain.Incident, error) {
		return c.UpdateIncident.Handle(r.Context(), p, id, in)
	}))
	r.Post("/incidents/{id}/follow-ups", onID(h, func(r *http.Request, p auth.Principal, id string, in command.NoteBodyText) (domain.Incident, error) {
		return c.FollowUpIncident.Handle(r.Context(), p, id, in)
	}))
	r.Post("/incidents/{id}/charge", onID(h, func(r *http.Request, p auth.Principal, id string, in domain.ChargeInput) (domain.Incident, error) {
		return c.ChargeIncident.Handle(r.Context(), p, id, in)
	}))
	r.Post("/incidents/{id}/close", onID(h, func(r *http.Request, p auth.Principal, id string, in command.NoteBodyText) (domain.Incident, error) {
		return c.CloseIncident.Handle(r.Context(), p, id, in)
	}))

	r.Get("/safe-boxes", list(log, func(r *http.Request) ([]domain.SafeBox, error) { return q.SafeBoxes(r.Context()) }))
	r.Post("/safe-boxes", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.SafeBoxInput) (domain.SafeBox, error) {
		return c.AddSafeBox.Handle(r.Context(), p, in)
	}))
	r.Patch("/safe-boxes/{id}", onID(h, func(r *http.Request, p auth.Principal, id string, in domain.SafeBoxInput) (domain.SafeBox, error) {
		return c.UpdateSafeBox.Handle(r.Context(), p, id, in)
	}))
	r.Get("/safe-box-rentals", list(log, func(r *http.Request) ([]domain.BoxRental, error) { return q.BoxRentals(r.Context()) }))
	r.Post("/safe-box-rentals", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.OpenBoxInput) (domain.BoxRental, error) {
		return c.OpenBox.Handle(r.Context(), p, in)
	}))
	r.Post("/safe-box-rentals/{id}/access", onID(h, func(r *http.Request, p auth.Principal, id string, in domain.BoxAccessInput) (domain.BoxRental, error) {
		return c.AccessBox.Handle(r.Context(), p, id, in)
	}))
	r.Post("/safe-box-rentals/{id}/close", onID(h, func(r *http.Request, p auth.Principal, id string, in domain.CloseBoxInput) (domain.BoxRental, error) {
		return c.CloseBox.Handle(r.Context(), p, id, in)
	}))
}

// Complaints is the in-process guest.Complaints.
func (h Handler) Complaints() guest.Complaints { return h.Commands.Relations.LogComplaint }

// complaintRoute serves POST /internal/v1/complaints/stay for guest.HTTPClient.FileFromStay.
func (h Handler) complaintRoute(r chi.Router) {
	c := h.Complaints()
	r.Post("/complaints/stay", read(h.Log, func(r *http.Request) (guest.Filed, error) {
		var in guest.StayComplaint
		if err := httpx.Decode(r, &in); err != nil {
			return guest.Filed{}, err
		}
		return c.FileFromStay(r.Context(), in)
	}))
}
