package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/owners"
	"github.com/syabanf/wit-hospitality/api/internal/owners/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/ids"
)

// RequestStay is an owner asking to stay in their own villa; it needs portal/create.
type RequestStay struct{ Deps }

// Handle records the request.
func (h RequestStay) Handle(ctx context.Context, p auth.Principal, in domain.StayInput) (domain.StayRequest, error) {
	if err := h.Authz.Require(ctx, p.Role, portalCreate...); err != nil {
		return domain.StayRequest{}, err
	}
	var r domain.StayRequest
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Repo.Lock(ctx); err != nil {
			return err
		}
		c, err := h.Repo.Contract(ctx, in.ContractID)
		if err != nil {
			return err
		}
		list, err := h.Repo.Owners(ctx)
		if err != nil {
			return err
		}
		if owner, isInvestor := OwnedBy(list, p); isInvestor && (owner == nil || owner.ID != c.OwnerID) {
			return errs.Forbidden("You can ask for stays in your own villas only.")
		}
		requests, err := h.Repo.StayRequests(ctx)
		if err != nil {
			return err
		}
		if err := domain.ValidateStay(in, c, requests, h.today()); err != nil {
			return err
		}
		villa, err := h.Repo.Villa(ctx, c.VillaID)
		if err != nil {
			return err
		}
		n, err := h.Repo.Next(ctx, "ownerStay")
		if err != nil {
			return err
		}
		in.Note = strings.TrimSpace(in.Note)
		r = domain.StayRequest{StayInput: in, ID: fmt.Sprintf("osr-%d", n), Number: fmt.Sprintf("OSR-%03d", n), OwnerID: c.OwnerID, VillaID: c.VillaID,
			Status: domain.StayPending, RequestedOn: h.today()}
		if err := h.Repo.InsertStay(ctx, &r); err != nil {
			return err
		}
		if err := h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "owner-stay", EntityID: r.Number,
			Summary: fmt.Sprintf("Asked for an owner stay at %s, %s to %s", villa.Name, r.CheckIn, r.CheckOut)}); err != nil {
			return err
		}
		return h.emit(ctx, owners.EventStayRequested, "owner_stay", r.ID, r.Version, owners.StayRequested{Request: mustJSON(r)})
	})
	return r, err
}

// Decision is the body of POST /owner-stays/{id}/decide.
type Decision struct {
	Approve bool   `json:"approve"`
	UnitID  string `json:"unitId"`
	Note    string `json:"note"`
}

// DecideStay approves an owner stay onto a free unit of the villa, or declines it with a reason;
// it needs booking/approve. Approval publishes the owner block property adds.
type DecideStay struct{ Deps }

// Handle decides the request.
func (h DecideStay) Handle(ctx context.Context, p auth.Principal, id string, d Decision) (domain.StayRequest, error) {
	if err := h.Authz.Require(ctx, p.Role, bookingApprove...); err != nil {
		return domain.StayRequest{}, err
	}
	if err := assertOperator(p, "decide owner stays"); err != nil {
		return domain.StayRequest{}, err
	}
	var r domain.StayRequest
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Repo.Lock(ctx); err != nil {
			return err
		}
		var err error
		if r, err = h.Repo.StayRequest(ctx, id); err != nil {
			return err
		}
		villa, err := h.Repo.Villa(ctx, r.VillaID)
		if err != nil {
			return err
		}
		if err := inScope(p, villa); err != nil {
			return err
		}
		if r.Status != domain.StayPending {
			return errs.Newf("OWNER_STAY_DECIDED", "%s is already %s.", r.Number, r.Status)
		}
		var block *owners.StayBlock
		note := strings.TrimSpace(d.Note)
		if d.Approve {
			unit, err := h.Repo.Unit(ctx, d.UnitID)
			if err != nil {
				return err
			}
			if unit.VillaID != r.VillaID {
				return errs.Newf(errs.CodeValidation, "%s is not in %s.", unit.Code, villa.Name)
			}
			if unit.Status == "inactive" {
				return errs.Newf("UNIT_UNAVAILABLE", "%s is inactive.", unit.Code)
			}
			if held, found, err := h.Repo.Holder(ctx, unit.ID, r.CheckIn, r.CheckOut); err != nil {
				return err
			} else if found {
				return errs.Newf("BOOKING_OVERLAP", "%s is held by %s from %s to %s.", unit.Code, held.Label, held.From, held.To)
			}
			owner, err := h.Repo.Owner(ctx, r.OwnerID)
			if err != nil {
				return err
			}
			block = &owners.StayBlock{ID: ids.Random("blk"), UnitID: unit.ID, From: r.CheckIn, To: r.CheckOut, Reason: "owner", Note: fmt.Sprintf("Owner stay %s, %s", r.Number, owner.Name)}
			r.Status, r.UnitID, r.BlockID = domain.StayApproved, &block.UnitID, &block.ID
		} else {
			if len([]rune(note)) < 3 {
				return errs.New(errs.CodeValidation, "Say why the stay is declined.")
			}
			r.Status = domain.StayDeclined
		}
		today := h.today()
		r.DecidedBy, r.DecidedOn, r.DecisionNote = &p.Name, &today, note
		if err := h.Repo.UpdateStay(ctx, &r); err != nil {
			return err
		}
		action, verb := audit.Approve, "Approved"
		if !d.Approve {
			action, verb = audit.Reject, "Declined"
		}
		if err := h.record(ctx, p, audit.Line{Action: action, Entity: "owner-stay", EntityID: r.Number, Summary: fmt.Sprintf("%s owner stay %s", verb, r.Number),
			Before: map[string]any{"status": "pending"}, After: map[string]any{"status": r.Status}}); err != nil {
			return err
		}
		return h.emit(ctx, owners.EventStayDecided, "owner_stay", r.ID, r.Version, owners.StayDecided{Request: mustJSON(r), VillaID: villa.ID, LocationID: villa.LocationID, Block: block})
	})
	return r, err
}
