package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// RecordRoomCheck saves what housekeeping found in a room on its round and compares it with the
// front office as it stands, keeping the result on the check. It needs maintenance/edit.
type RecordRoomCheck struct{ Deps }

// Handle records the check.
func (h RecordRoomCheck) Handle(ctx context.Context, p auth.Principal, in domain.RoomCheckInput) (domain.RoomCheck, error) {
	if err := h.need(ctx, p, "edit"); err != nil {
		return domain.RoomCheck{}, err
	}
	var out domain.RoomCheck
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		unit, err := h.Store.Unit(ctx, in.UnitID)
		if err != nil {
			return err
		}
		if _, err := h.villaInScope(ctx, p, unit.VillaID); err != nil {
			return err
		}
		if err := domain.ValidateRoomCheck(&in, h.today()); err != nil {
			return err
		}
		id := domain.RoomCheckID(in.Date, unit.ID)
		held, found, err := h.Store.RoomCheck(ctx, id)
		if err != nil {
			return err
		}
		if found && held.Resolution != nil {
			return errs.Newf("ROOM_CHECK_RESOLVED", "%s on %s is resolved; its check stays as recorded.", unit.Code, in.Date)
		}
		stays, err := h.Store.UnitStays(ctx, unit.ID)
		if err != nil {
			return err
		}
		out = domain.RoomCheck{ID: id, UnitID: unit.ID, VillaID: unit.VillaID, Date: in.Date, Found: in.Found, Persons: in.Persons,
			Note: strings.TrimSpace(in.Note), CheckedBy: p.Name, CheckedAt: h.now(), FrontOffice: domain.FoundVacant}
		stay := domain.FrontOfficeStay(stays, unit.ID, in.Date)
		if stay != nil {
			out.FrontOffice, out.BookingID, out.BookingCode, out.FrontPersons = domain.FoundOccupied, &stay.ID, &stay.Code, stay.Persons
		}
		if kind := domain.DiscrepancyOf(in.Found, in.Persons, stay != nil, out.FrontPersons); kind != "" {
			out.Discrepancy = &kind
		}
		if err := h.Store.SaveRoomCheck(ctx, out); err != nil {
			return err
		}
		action := audit.Create
		if found {
			action = audit.Update
		}
		return h.record(ctx, p, audit.Line{Action: action, Entity: "room-check", EntityID: id, Summary: domain.CheckSummary(out, unit.Code)})
	})
	return out, err
}

// ResolveDiscrepancy records how the desk settled a room check's discrepancy. It needs
// booking/edit.
type ResolveDiscrepancy struct{ Deps }

// Handle resolves the check.
func (h ResolveDiscrepancy) Handle(ctx context.Context, p auth.Principal, id string, in domain.ResolveInput) (domain.RoomCheck, error) {
	if err := h.Authz.Require(ctx, p.Role, rbac.Need{Module: "booking", Action: "edit"}); err != nil {
		return domain.RoomCheck{}, err
	}
	var out domain.RoomCheck
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		c, found, err := h.Store.RoomCheck(ctx, id)
		if err != nil {
			return err
		}
		if !found {
			return errs.NotFound("room check", id)
		}
		if _, err := h.villaInScope(ctx, p, c.VillaID); err != nil {
			return err
		}
		unit, err := h.Store.Unit(ctx, c.UnitID)
		if err != nil {
			return err
		}
		if err := domain.ValidateResolve(c, unit.Code, in); err != nil {
			return err
		}
		c.Resolution = &domain.Resolution{Action: in.Action, Note: strings.TrimSpace(in.Note), By: p.Name, At: h.now()}
		if err := h.Store.SaveRoomCheck(ctx, c); err != nil {
			return err
		}
		out = c
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "room-check", EntityID: id,
			Summary: fmt.Sprintf("Resolved %s on %s %s: %s", strings.ToLower(domain.KindLabel[*c.Discrepancy]), unit.Code, c.Date, domain.ResolveLabel[in.Action])})
	})
	return out, err
}

// OpenDiscrepancies answers billing's night audit: the open discrepancies on or before date.
type OpenDiscrepancies struct{ Deps }

// Count counts them across every villa.
func (h OpenDiscrepancies) Count(ctx context.Context, date string) (int, error) {
	return h.Store.OpenDiscrepancies(ctx, date)
}
