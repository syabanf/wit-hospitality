package command

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

// restrictionOf is the mock's restrictionOf: a valid form on a known room type, and a unit rule
// only on a unit of that type.
func (d Deps) restrictionOf(c domain.Catalog, in domain.RestrictionInput, id string, p auth.Principal) (domain.Restriction, domain.UnitGroup, error) {
	if err := domain.RestrictionFields(in).Err(); err != nil {
		return domain.Restriction{}, domain.UnitGroup{}, err
	}
	g, ok := c.Group(in.GroupID)
	if !ok {
		return domain.Restriction{}, g, errs.NotFound("room type", in.GroupID)
	}
	if in.UnitID != nil && *in.UnitID != "" {
		if u, ok := c.Unit(*in.UnitID); !ok || u.Group() != g.ID {
			return domain.Restriction{}, g, errs.Newf(errs.CodeValidation, "That unit is not a room of %s.", g.Name)
		}
	}
	return domain.NewRestriction(id, in, p.Name, d.today()), g, nil
}

func describeRestriction(c domain.Catalog, r domain.Restriction) string {
	g, _ := c.Group(r.GroupID)
	unit := ""
	if u, ok := c.Unit(r.Unit()); ok {
		unit = " " + u.Code
	}
	return fmt.Sprintf("%s on %s%s, %s", domain.RestrictionLabel(r.Rule, r.Nights), g.Name, unit, domain.RestrictionWhen(r.Yearly, r.From, r.To, r.Weekdays))
}

func (d Deps) restrictionEvent(ctx context.Context, c domain.Catalog, r domain.Restriction) error {
	g, _ := c.Group(r.GroupID)
	v, _ := c.Villa(g.VillaID)
	return d.emit(ctx, reservation.EventRestrictionSaved, "restriction", r.ID, r.Version, recordOf(r.ID, []domain.Villa{v}, r))
}

func ruleSummary(r domain.Restriction) map[string]any {
	return map[string]any{"rule": r.Rule, "nights": r.Nights, "from": r.From, "to": r.To}
}

// SaveRestriction adds a restriction (id "") or replaces one; it needs property/edit. Stays
// already booked keep their dates.
type SaveRestriction struct{ Deps }

// Handle saves the restriction.
func (h SaveRestriction) Handle(ctx context.Context, p auth.Principal, id string, in domain.RestrictionInput) (domain.Restriction, error) {
	if err := h.Authz.Require(ctx, p.Role, propertyEdit...); err != nil {
		return domain.Restriction{}, err
	}
	if err := domain.RestrictionFields(in).Err(); err != nil {
		return domain.Restriction{}, err
	}
	var saved domain.Restriction
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		cat, err := h.Catalog.Catalog(ctx)
		if err != nil {
			return err
		}
		var before *domain.Restriction
		if id != "" {
			r, err := h.Repo.Restriction(ctx, id)
			if err != nil {
				return err
			}
			before = &r
		} else {
			n, err := h.Repo.Next(ctx, "restriction")
			if err != nil {
				return err
			}
			id = fmt.Sprintf("rst-%d", n)
		}
		saved, _, err = h.restrictionOf(cat, in, id, p)
		if err != nil {
			return err
		}
		if err := groupScope(p, cat, saved.GroupID); err != nil {
			return err
		}
		if before != nil {
			if err := groupScope(p, cat, before.GroupID); err != nil {
				return err
			}
		}
		action, verb := audit.Create, "Added"
		var beforeAudit any
		if before != nil {
			saved.Version = before.Version
			if err := h.Repo.UpdateRestriction(ctx, &saved); err != nil {
				return err
			}
			action, verb, beforeAudit = audit.Update, "Changed", ruleSummary(*before)
		} else if err := h.Repo.InsertRestriction(ctx, &saved); err != nil {
			return err
		}
		if err := h.restrictionEvent(ctx, cat, saved); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: action, Entity: "restriction", EntityID: saved.ID, Summary: verb + " " + describeRestriction(cat, saved), Before: beforeAudit, After: ruleSummary(saved)})
	})
	return saved, err
}

// groupScope refuses a room type outside the caller's villas.
func groupScope(p auth.Principal, c domain.Catalog, groupID string) error {
	g, _ := c.Group(groupID)
	villa, _ := c.Villa(g.VillaID)
	return inScope(p, villa)
}

// RemoveRestriction deletes a restriction; it needs property/edit.
type RemoveRestriction struct{ Deps }

// Handle removes the restriction.
func (h RemoveRestriction) Handle(ctx context.Context, p auth.Principal, id string) error {
	if err := h.Authz.Require(ctx, p.Role, propertyEdit...); err != nil {
		return err
	}
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		cat, err := h.Catalog.Catalog(ctx)
		if err != nil {
			return err
		}
		r, err := h.Repo.Restriction(ctx, id)
		if err != nil {
			return err
		}
		if err := groupScope(p, cat, r.GroupID); err != nil {
			return err
		}
		if err := h.Repo.DeleteRestriction(ctx, id); err != nil {
			return err
		}
		if err := h.emit(ctx, reservation.EventRestrictionRemoved, "restriction", id, r.Version+1, reservation.Removed{ID: id}); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Delete, Entity: "restriction", EntityID: id, Summary: "Removed " + describeRestriction(cat, r),
			Before: map[string]any{"rule": r.Rule, "from": r.From, "to": r.To}})
	})
}

// BulkRestrictions adds one rule to several room types, all or nothing; it needs property/edit.
type BulkRestrictions struct{ Deps }

// Handle adds the rules.
func (h BulkRestrictions) Handle(ctx context.Context, p auth.Principal, in domain.BulkRestrictionInput) ([]domain.Restriction, error) {
	if err := h.Authz.Require(ctx, p.Role, propertyEdit...); err != nil {
		return nil, err
	}
	f := domain.RestrictionFields(in.RestrictionInput)
	if len(in.GroupIDs) == 0 {
		f.Add("groupIds", "Pick at least one room type.")
	}
	if err := f.Err(); err != nil {
		return nil, err
	}
	var saved []domain.Restriction
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		cat, err := h.Catalog.Catalog(ctx)
		if err != nil {
			return err
		}
		var ids, names []string
		var seen []string
		for _, groupID := range in.GroupIDs {
			if slices.Contains(seen, groupID) {
				continue
			}
			seen = append(seen, groupID)
			n, err := h.Repo.Next(ctx, "restriction")
			if err != nil {
				return err
			}
			one := in.RestrictionInput
			one.GroupID, one.UnitID = groupID, nil
			r, g, err := h.restrictionOf(cat, one, fmt.Sprintf("rst-%d", n), p)
			if err != nil {
				return err
			}
			if err := groupScope(p, cat, r.GroupID); err != nil {
				return err
			}
			if err := h.Repo.InsertRestriction(ctx, &r); err != nil {
				return err
			}
			if err := h.restrictionEvent(ctx, cat, r); err != nil {
				return err
			}
			saved = append(saved, r)
			ids, names = append(ids, r.ID), append(names, g.Name)
		}
		first := saved[0]
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "restriction", EntityID: strings.Join(ids, ", "),
			Summary: fmt.Sprintf("Added %s on %s, %s", domain.RestrictionLabel(first.Rule, first.Nights), strings.Join(names, ", "), domain.RestrictionWhen(first.Yearly, first.From, first.To, first.Weekdays))})
	})
	return saved, err
}

// SetOverbooking sets how many stays a night a room type may sell past its rooms; it needs
// property/edit, and only a room type that sells by type may overbook.
type SetOverbooking struct{ Deps }

// Handle saves the policy.
func (h SetOverbooking) Handle(ctx context.Context, p auth.Principal, groupID string, limit float64) (domain.OverbookPolicy, error) {
	if err := h.Authz.Require(ctx, p.Role, propertyEdit...); err != nil {
		return domain.OverbookPolicy{}, err
	}
	if err := domain.ValidateOverbook(limit); err != nil {
		return domain.OverbookPolicy{}, err
	}
	policy := domain.OverbookPolicy{GroupID: groupID, Limit: int(limit)}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Repo.LockAvailability(ctx); err != nil {
			return err
		}
		cat, err := h.Catalog.Catalog(ctx)
		if err != nil {
			return err
		}
		g, ok := cat.Group(groupID)
		if !ok {
			return errs.NotFound("room type", groupID)
		}
		villa, _ := cat.Villa(g.VillaID)
		if err := inScope(p, villa); err != nil {
			return err
		}
		if policy.Limit > 0 && !g.OperatorAssigns {
			return errs.Newf("OVERBOOK_ROOM_BY_ROOM", "%s sells room by room; only a room type that sells by type can overbook.", g.Name)
		}
		policies, err := h.Repo.Policies(ctx)
		if err != nil {
			return err
		}
		before := domain.OverbookLimit(policies, groupID)
		version, err := h.Repo.SetPolicy(ctx, policy)
		if err != nil {
			return err
		}
		if err := h.emit(ctx, reservation.EventOverbookingSet, "overbooking", groupID, version, recordOf(groupID, []domain.Villa{villa}, policy)); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "overbooking", EntityID: groupID, Summary: fmt.Sprintf("Set %s to sell %d past its rooms a night", g.Name, policy.Limit),
			Before: map[string]any{"limit": before}, After: map[string]any{"limit": policy.Limit}})
	})
	return policy, err
}

// Walked is the answer of a walk.
type Walked struct {
	Booking domain.Booking `json:"booking"`
	Walk    domain.Walk    `json:"walk"`
}

// WalkGuest walks a guest arriving today off an overbooked night: into a unit of another room
// type, or out to another property, which cancels the stay and refunds everything paid. The cost
// travels on walk.recorded for finance to book as a Guest relocation cash-out.
type WalkGuest struct{ Deps }

// Handle walks the guest.
func (h WalkGuest) Handle(ctx context.Context, p auth.Principal, bookingID string, in domain.WalkInput) (Walked, error) {
	if err := h.Authz.Require(ctx, p.Role, bookingEdit...); err != nil {
		return Walked{}, err
	}
	if err := domain.ValidateWalk(in); err != nil {
		return Walked{}, err
	}
	var out Walked
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		cat, err := h.Catalog.Catalog(ctx)
		if err != nil {
			return err
		}
		b, from, err := h.booking(ctx, p, cat, bookingID)
		if err != nil {
			return err
		}
		today := h.today()
		if b.Status != domain.Confirmed || b.CheckIn != today {
			return errs.Newf("WALK_NOT_ALLOWED", "%s is not a confirmed arrival for today; only a guest due today can be walked.", b.Code)
		}
		w, err := h.load(ctx, b.CheckIn, b.CheckOut)
		if err != nil {
			return err
		}
		if !from.hasGroup || len(domain.OverbookedNights(cat, from.group.ID, today, domain.AddDays(today, 1), w.avail.Bookings, cat.Blocks)) == 0 {
			name := from.unit.Code
			if from.hasGroup {
				name = from.group.Name
			}
			return errs.Newf("WALK_NOT_OVERBOOKED", "%s is not overbooked tonight. Assign a room instead.", name)
		}
		n, err := h.Repo.Next(ctx, "walk")
		if err != nil {
			return err
		}
		number := fmt.Sprintf("WLK-%d", 100+n)
		walk := domain.Walk{ID: "walk-" + number[4:], Number: number, Cost: int64(in.Cost), Method: in.Method, Destination: in.Destination,
			BookingID: b.ID, BookingCode: b.Code, GroupID: from.group.ID, Date: today, FromUnitID: from.unit.ID,
			Compensation: strings.TrimSpace(in.Compensation), Reason: strings.TrimSpace(in.Reason), By: p.Name, ByID: p.UserID}
		where := ""
		if in.Destination == "group_villa" {
			target, ok := cat.Unit(str(in.UnitID))
			if !ok {
				return errs.NotFound("unit", str(in.UnitID))
			}
			if target.Group() == from.group.ID {
				return errs.Newf(errs.CodeValidation, "%s is a %s room; pick a unit of another villa or room type.", target.Code, from.group.Name)
			}
			if target.Status != "active" {
				return errs.Newf("UNIT_UNAVAILABLE", "%s is %s.", target.Code, target.Status)
			}
			if err := w.avail.AssertFree(target.ID, b.CheckIn, b.CheckOut, b.ID); err != nil {
				return err
			}
			b.Movements = append(b.Movements, domain.UnitMovement{FromUnitID: b.UnitID, ToUnitID: target.ID, On: today, Reason: fmt.Sprintf("Walked %s: %s", number, walk.Reason), By: p.Name})
			b.UnitID, b.UnitAssigned = target.ID, true
			walk.ToUnitID = &target.ID
			where = "to " + target.Code
			if err := h.saveBooking(ctx, &b, cat); err != nil {
				return err
			}
		} else {
			walk.Property = strings.TrimSpace(in.Property)
			b.Status = domain.Cancelled
			where = fmt.Sprintf("to %s, stay cancelled", walk.Property)
			refundAll := &reservation.Terms{Refund: int64(b.PaidAmount)}
			if err := h.statusEvent(ctx, &b, cat, domain.Confirmed, refundAll); err != nil {
				return err
			}
		}
		if err := h.Repo.InsertWalk(ctx, walk); err != nil {
			return err
		}
		if err := h.emit(ctx, reservation.EventWalkRecorded, "walk", walk.ID, 1, recordOf(walk.ID, []domain.Villa{from.villa}, walk)); err != nil {
			return err
		}
		out = Walked{Booking: b, Walk: walk}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "walk", EntityID: number, Summary: fmt.Sprintf("Walked %s off overbooked %s %s", b.Code, from.group.Name, where),
			After: map[string]any{"cost": walk.Cost, "destination": walk.Destination}})
	})
	return out, err
}
