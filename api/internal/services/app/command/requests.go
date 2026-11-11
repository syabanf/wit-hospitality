package command

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/services"
	"github.com/syabanf/wit-hospitality/api/internal/services/domain"
)

// requestPlace checks the unit and the stay a request names: the unit known and in scope, the
// booking known to reservation.
func (d Deps) requestPlace(ctx context.Context, p auth.Principal, in domain.ServiceRequestInput) (domain.Place, error) {
	pl, err := d.place(ctx, in.UnitID)
	if err != nil {
		return pl, err
	}
	if err := inScope(p, pl.Villa); err != nil {
		return pl, err
	}
	if in.BookingID != nil && *in.BookingID != "" {
		if _, err := d.Stays.Stay(ctx, *in.BookingID); err != nil {
			return pl, err
		}
	}
	return pl, nil
}

func (d Deps) requestEvent(ctx context.Context, r domain.ServiceRequest, v domain.Villa) error {
	return d.emit(ctx, services.EventRequestSaved, "service_request", r.ID, r.Version,
		services.RequestSaved{Request: mustJSON(r), VillaID: v.ID, LocationID: v.LocationID})
}

// CreateRequest is POST /service-requests.
type CreateRequest struct{ Deps }

// Handle logs the request, open and unassigned, at the current time.
func (h CreateRequest) Handle(ctx context.Context, p auth.Principal, in domain.ServiceRequestInput) (domain.ServiceRequest, error) {
	if err := h.Authz.Require(ctx, p.Role, servicesCreate...); err != nil {
		return domain.ServiceRequest{}, err
	}
	if err := domain.ValidateServiceRequest(in); err != nil {
		return domain.ServiceRequest{}, err
	}
	var out domain.ServiceRequest
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		pl, err := h.requestPlace(ctx, p, in)
		if err != nil {
			return err
		}
		n, err := h.Repo.Next(ctx, "request")
		if err != nil {
			return err
		}
		out = domain.ServiceRequest{ID: "rq-" + strconv.FormatInt(n, 10), Number: "RQ-" + strconv.FormatInt(100+n, 10), Status: domain.RequestOpen,
			RequestedOn: h.today(), RequestedAt: h.minute()}
		out.Apply(in)
		if err := h.Repo.InsertRequest(ctx, &out, pl.Villa.ID); err != nil {
			return err
		}
		if err := h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "service-request", EntityID: out.Number,
			Summary: fmt.Sprintf("Logged %s %s for %s", out.Number, strings.ToLower(domain.ServiceKindLabel[out.Kind]), pl.Unit.Code)}); err != nil {
			return err
		}
		return h.requestEvent(ctx, out, pl.Villa)
	})
	return out, err
}

// RequestPatch is the body of PATCH /service-requests/{id}: the full input for an edit, or only
// assignee, or only transactionId, as the console's update, assign and linkTransaction send.
type RequestPatch struct {
	Input         *domain.ServiceRequestInput
	Assignee      *string
	TransactionID *string
}

// UpdateRequest is PATCH /service-requests/{id}.
type UpdateRequest struct{ Deps }

// Handle edits an open or in-progress request, names who takes it, or links the cash entry its
// charge became.
func (h UpdateRequest) Handle(ctx context.Context, p auth.Principal, id string, patch RequestPatch) (domain.ServiceRequest, error) {
	if err := h.Authz.Require(ctx, p.Role, servicesEdit...); err != nil {
		return domain.ServiceRequest{}, err
	}
	var out domain.ServiceRequest
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		r, err := h.Repo.Request(ctx, id)
		if err != nil {
			return err
		}
		pl, err := h.place(ctx, r.UnitID)
		if err != nil {
			return err
		}
		if err := inScope(p, pl.Villa); err != nil {
			return err
		}
		switch {
		case patch.Input != nil:
			if err := r.CanEdit(); err != nil {
				return err
			}
			if err := domain.ValidateServiceRequest(*patch.Input); err != nil {
				return err
			}
			if pl, err = h.requestPlace(ctx, p, *patch.Input); err != nil {
				return err
			}
			r.Apply(*patch.Input)
		case patch.Assignee != nil:
			r.Assignee = strings.TrimSpace(*patch.Assignee)
		case patch.TransactionID != nil:
			r.TransactionID = patch.TransactionID
		}
		if err := h.Repo.UpdateRequest(ctx, &r, pl.Villa.ID); err != nil {
			return err
		}
		out = r
		return h.requestEvent(ctx, r, pl.Villa)
	})
	return out, err
}

// StepRequest is POST /service-requests/{id}/start, done and cancel.
type StepRequest struct{ Deps }

// Handle moves the request on the board.
func (h StepRequest) Handle(ctx context.Context, p auth.Principal, id, to string) (domain.ServiceRequest, error) {
	if err := h.Authz.Require(ctx, p.Role, servicesEdit...); err != nil {
		return domain.ServiceRequest{}, err
	}
	var out domain.ServiceRequest
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		r, err := h.Repo.Request(ctx, id)
		if err != nil {
			return err
		}
		pl, err := h.place(ctx, r.UnitID)
		if err != nil {
			return err
		}
		if err := inScope(p, pl.Villa); err != nil {
			return err
		}
		from := r.Status
		if err := r.Transition(to, h.today()); err != nil {
			return err
		}
		if err := h.Repo.UpdateRequest(ctx, &r, pl.Villa.ID); err != nil {
			return err
		}
		out = r
		if err := h.record(ctx, p, audit.Line{Action: audit.Status, Entity: "service-request", EntityID: r.Number,
			Summary: fmt.Sprintf("Moved %s to %s", r.Number, strings.Replace(to, "_", " ", 1)), Before: map[string]any{"status": from}, After: map[string]any{"status": to}}); err != nil {
			return err
		}
		return h.requestEvent(ctx, r, pl.Villa)
	})
	return out, err
}
