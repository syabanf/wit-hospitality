package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/guest/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// cleanItem is the mock's cleanItem: the villa in scope, the unit in that villa, and a stay that
// names the guest. It returns the input with the stay's guest filled in, and the villa. The
// handlers validate the fields first.
func (d Deps) cleanItem(ctx context.Context, p auth.Principal, in domain.LostItemInput) (domain.LostItemInput, domain.VillaRef, error) {
	villa, err := d.villaInScope(ctx, p, in.VillaID)
	if err != nil {
		return in, villa, err
	}
	if in.UnitID != nil && *in.UnitID != "" {
		unit, err := d.Repo.Unit(ctx, *in.UnitID)
		if err != nil {
			return in, villa, err
		}
		if unit.VillaID != in.VillaID {
			return in, villa, errs.Newf(errs.CodeValidation, "%s is not in that villa.", unit.Code)
		}
	}
	if in.BookingID != nil && *in.BookingID != "" {
		stay, err := d.Repo.Stay(ctx, *in.BookingID)
		if err != nil {
			return in, villa, err
		}
		if in.GuestID != nil && *in.GuestID != "" && *in.GuestID != stay.GuestID {
			return in, villa, errs.Newf(errs.CodeValidation, "%s is booked by another guest.", stay.Code)
		}
		in.GuestID = &stay.GuestID
		return in, villa, nil
	}
	if in.GuestID != nil && *in.GuestID != "" {
		if _, err := d.Repo.Guest(ctx, *in.GuestID); err != nil {
			return in, villa, err
		}
	}
	return in, villa, nil
}

func (d Deps) itemEvent(ctx context.Context, eventType string, i domain.LostItem) error {
	return d.emit(ctx, eventType, "lost_item", i.ID, i.Version, i.State())
}

// LogLostItem logs a find in the finder's name; it needs guest/create and the villa in scope.
type LogLostItem struct{ Deps }

// Handle logs the item.
func (h LogLostItem) Handle(ctx context.Context, p auth.Principal, in domain.LostItemInput) (domain.LostItem, error) {
	if err := h.Authz.Require(ctx, p.Role, guestCreate...); err != nil {
		return domain.LostItem{}, err
	}
	return h.Find(ctx, p, in)
}

// Find logs the item without the guest/create check: the mock's logFind, which housekeeping
// reaches through guest.LostFound after checking its own module.
func (h LogLostItem) Find(ctx context.Context, p auth.Principal, in domain.LostItemInput) (domain.LostItem, error) {
	if err := domain.ValidateLostItem(in, h.today()); err != nil {
		return domain.LostItem{}, err
	}
	var item domain.LostItem
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		clean, villa, err := h.cleanItem(ctx, p, in)
		if err != nil {
			return err
		}
		n, err := h.Repo.Next(ctx, "lostItem")
		if err != nil {
			return err
		}
		item = domain.LostItem{ID: fmt.Sprintf("lf-%d", n), Number: fmt.Sprintf("LF-%03d", n), FoundBy: p.Name, Status: "found",
			History: []domain.LostEvent{{Status: "found", By: p.Name, At: h.now(), Note: ""}}}
		item.Apply(clean)
		if err := h.Repo.InsertLostItem(ctx, &item); err != nil {
			return err
		}
		if err := h.itemEvent(ctx, guest.EventLostItemLogged, item); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "lost-item", EntityID: item.Number, Summary: fmt.Sprintf("Logged %s found at %s", item.Description, villa.Name)})
	})
	return item, err
}

// UpdateLostItem edits an item's details; it needs guest/edit and both villas in scope.
type UpdateLostItem struct{ Deps }

// Handle edits the item.
func (h UpdateLostItem) Handle(ctx context.Context, p auth.Principal, id string, in domain.LostItemInput) (domain.LostItem, error) {
	if err := h.Authz.Require(ctx, p.Role, guestEdit...); err != nil {
		return domain.LostItem{}, err
	}
	if err := domain.ValidateLostItem(in, h.today()); err != nil {
		return domain.LostItem{}, err
	}
	var item domain.LostItem
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if item, err = h.Repo.LostItem(ctx, id); err != nil {
			return err
		}
		if _, err := h.villaInScope(ctx, p, item.VillaID); err != nil {
			return err
		}
		clean, _, err := h.cleanItem(ctx, p, in)
		if err != nil {
			return err
		}
		item.Apply(clean)
		if err := h.Repo.UpdateLostItem(ctx, &item); err != nil {
			return err
		}
		if err := h.itemEvent(ctx, guest.EventLostItemUpdated, item); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "lost-item", EntityID: item.Number, Summary: "Edited " + item.Number})
	})
	return item, err
}

// MoveLostItem changes an item's status along LOST_TRANSITIONS; it needs guest/edit and the villa
// in scope. A refused move is LOST_ITEM_INVALID_STATE.
type MoveLostItem struct{ Deps }

// Handle moves the item.
func (h MoveLostItem) Handle(ctx context.Context, p auth.Principal, id string, move domain.LostMove) (domain.LostItem, error) {
	if err := h.Authz.Require(ctx, p.Role, guestEdit...); err != nil {
		return domain.LostItem{}, err
	}
	var item domain.LostItem
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if item, err = h.Repo.LostItem(ctx, id); err != nil {
			return err
		}
		if _, err := h.villaInScope(ctx, p, item.VillaID); err != nil {
			return err
		}
		settings, err := h.Repo.Settings(ctx)
		if err != nil {
			return err
		}
		if err := domain.ValidateLostMove(item, move, h.today(), settings); err != nil {
			return err
		}
		before := item.Status
		item.Move(move, p.Name, h.now())
		if err := h.Repo.UpdateLostItem(ctx, &item); err != nil {
			return err
		}
		if err := h.itemEvent(ctx, guest.EventLostItemMoved, item); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{
			Action: audit.Status, Entity: "lost-item", EntityID: item.Number,
			Summary: fmt.Sprintf("%s %s to %s", item.Number, strings.ToLower(domain.LostStatusLabel[before]), strings.ToLower(domain.LostStatusLabel[move.To])),
			Before:  map[string]any{"status": before}, After: map[string]any{"status": move.To},
		})
	})
	return item, err
}

// SaveLostFoundSettings sets the holding period; it needs guest/edit and approve in the guest
// module.
type SaveLostFoundSettings struct{ Deps }

// Handle saves the settings.
func (h SaveLostFoundSettings) Handle(ctx context.Context, p auth.Principal, s domain.LostFoundSettings) (domain.LostFoundSettings, error) {
	if err := h.Authz.Require(ctx, p.Role, guestEdit...); err != nil {
		return s, err
	}
	if err := h.requireApprove(ctx, p, "change the holding period"); err != nil {
		return s, err
	}
	if err := domain.ValidateLostFoundSettings(s); err != nil {
		return s, err
	}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		before, err := h.Repo.Settings(ctx)
		if err != nil {
			return err
		}
		version, err := h.Repo.SaveSettings(ctx, s)
		if err != nil {
			return err
		}
		if err := h.emit(ctx, guest.EventSettingsSaved, "lost_found_settings", "holding", version, guest.SettingsSaved{HoldDays: s.HoldDays}); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{
			Action: audit.Update, Entity: "lost-found-settings", EntityID: "holding",
			Summary: fmt.Sprintf("Set the lost and found holding period to %d days", s.HoldDays),
			Before:  map[string]any{"holdDays": before.HoldDays}, After: map[string]any{"holdDays": s.HoldDays},
		})
	})
	return s, err
}
