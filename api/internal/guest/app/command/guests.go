package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/guest/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

func (d Deps) guestEvent(ctx context.Context, eventType string, g domain.Guest) error {
	return d.emit(ctx, eventType, "guest", g.ID, g.Version, guest.GuestEvent{Guest: g.Summary()})
}

// CreateGuest adds a profile; it needs guest/create or booking/create.
type CreateGuest struct{ Deps }

// Handle creates the guest.
func (h CreateGuest) Handle(ctx context.Context, p auth.Principal, in domain.GuestInput) (domain.Guest, error) {
	if err := h.Authz.Require(ctx, p.Role, profileCreate...); err != nil {
		return domain.Guest{}, err
	}
	if err := domain.ValidateGuest(in); err != nil {
		return domain.Guest{}, err
	}
	var g domain.Guest
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		n, err := h.Repo.Next(ctx, "guest")
		if err != nil {
			return err
		}
		g = domain.NewGuest(fmt.Sprintf("g-%02d", n), h.today(), in)
		if err := h.Repo.InsertGuest(ctx, &g); err != nil {
			return err
		}
		if err := h.guestEvent(ctx, guest.EventGuestCreated, g); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "guest", EntityID: g.ID, Summary: "Added guest " + g.Name})
	})
	return g, err
}

// UpdateGuest edits a profile; it needs guest/edit or booking/edit.
type UpdateGuest struct{ Deps }

// Handle edits the guest.
func (h UpdateGuest) Handle(ctx context.Context, p auth.Principal, id string, in domain.GuestInput) (domain.Guest, error) {
	if err := h.Authz.Require(ctx, p.Role, profileEdit...); err != nil {
		return domain.Guest{}, err
	}
	if err := domain.ValidateGuest(in); err != nil {
		return domain.Guest{}, err
	}
	var g domain.Guest
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if g, err = h.Repo.Guest(ctx, id); err != nil {
			return err
		}
		before := map[string]any{"vipLevel": g.VipLevel, "nationality": g.Nationality, "idNumber": g.IDNumber}
		g.Apply(in)
		if err := h.Repo.UpdateGuest(ctx, &g); err != nil {
			return err
		}
		if err := h.guestEvent(ctx, guest.EventGuestUpdated, g); err != nil {
			return err
		}
		after := map[string]any{"vipLevel": g.VipLevel, "nationality": g.Nationality, "idNumber": g.IDNumber}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "guest", EntityID: id, Summary: "Edited guest " + g.Name, Before: before, After: after})
	})
	return g, err
}

// SetBlacklist puts a guest on the blacklist with a reason, or takes them off when reason is nil.
// It needs guest/edit and approve in the guest module.
type SetBlacklist struct{ Deps }

// Handle changes the blacklist.
func (h SetBlacklist) Handle(ctx context.Context, p auth.Principal, id string, reason *string) (domain.Guest, error) {
	if err := h.Authz.Require(ctx, p.Role, guestEdit...); err != nil {
		return domain.Guest{}, err
	}
	if err := h.requireApprove(ctx, p, "change the blacklist"); err != nil {
		return domain.Guest{}, err
	}
	var g domain.Guest
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if g, err = h.Repo.Guest(ctx, id); err != nil {
			return err
		}
		var before any
		if g.Blacklist != nil {
			before = g.Blacklist.Reason
		}
		if err := g.SetBlacklist(reason, p.Name, h.today()); err != nil {
			return err
		}
		if err := h.Repo.UpdateGuest(ctx, &g); err != nil {
			return err
		}
		if err := h.guestEvent(ctx, guest.EventGuestUpdated, g); err != nil {
			return err
		}
		line := audit.Line{Action: audit.Update, Entity: "guest", EntityID: id, Summary: fmt.Sprintf("Took %s off the blacklist", g.Name), Before: map[string]any{"blacklist": before}, After: map[string]any{"blacklist": nil}}
		if g.Blacklist != nil {
			line.Action, line.Summary = audit.Status, fmt.Sprintf("Blacklisted %s: %s", g.Name, g.Blacklist.Reason)
			line.After = map[string]any{"blacklist": g.Blacklist.Reason}
		}
		return h.record(ctx, p, line)
	})
	return g, err
}

// MergeGuests folds the dropped profile into the kept one; it needs guest/edit and approve in the
// guest module. Guest moves its own lost items and Immigration reports and its copies of stays and
// group leads; guest.merged.v1 tells reservation and the other contexts to move theirs.
type MergeGuests struct{ Deps }

// Handle merges dropID into keepID.
func (h MergeGuests) Handle(ctx context.Context, p auth.Principal, keepID, dropID string) (domain.Guest, error) {
	if err := h.Authz.Require(ctx, p.Role, guestEdit...); err != nil {
		return domain.Guest{}, err
	}
	if err := h.requireApprove(ctx, p, "merge guest profiles"); err != nil {
		return domain.Guest{}, err
	}
	if keepID == dropID {
		return domain.Guest{}, errs.New(errs.CodeValidation, "Pick two different profiles.")
	}
	var keep domain.Guest
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if keep, err = h.Repo.Guest(ctx, keepID); err != nil {
			return err
		}
		drop, err := h.Repo.Guest(ctx, dropID)
		if err != nil {
			return err
		}
		stays, groups, err := h.Repo.MoveGuestReferences(ctx, dropID, keepID)
		if err != nil {
			return err
		}
		items, err := h.Repo.MoveLostItems(ctx, dropID, keepID)
		if err != nil {
			return err
		}
		reports, err := h.Repo.MoveReports(ctx, dropID, keepID)
		if err != nil {
			return err
		}
		keep.Merge(drop)
		if err := h.Repo.UpdateGuest(ctx, &keep); err != nil {
			return err
		}
		if err := h.Repo.DeleteGuest(ctx, dropID); err != nil {
			return err
		}
		if err := h.guestEvent(ctx, guest.EventGuestUpdated, keep); err != nil {
			return err
		}
		merged := guest.GuestMerged{KeepID: keepID, DropID: dropID, Guest: keep.Summary(), MovedLostItems: items, MovedReportsFor: reports}
		if err := h.emit(ctx, guest.EventGuestMerged, "guest", dropID, drop.Version+1, merged); err != nil {
			return err
		}
		moved := map[string]any{"stays": stays, "groups": groups, "items": len(items)}
		return h.record(ctx, p, audit.Line{
			Action: audit.Update, Entity: "guest", EntityID: keepID,
			Summary: fmt.Sprintf("Merged %s (%s) into %s: %d stays, %d groups, %d lost items moved", drop.Name, dropID, keep.Name, stays, groups, len(items)),
			Before:  map[string]any{"dropped": dropID}, After: moved,
		})
	})
	return keep, err
}
