package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/inventory/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Move issues stock to a unit, transfers it to another villa store or writes it off, never more
// than the store holds; it needs maintenance/edit.
type Move struct{ Deps }

// Handle books the movements and returns them.
func (h Move) Handle(ctx context.Context, p auth.Principal, in domain.MoveInput) ([]domain.Movement, error) {
	if err := h.Authz.Require(ctx, p.Role, needEdit); err != nil {
		return nil, err
	}
	if err := domain.ValidateMove(in); err != nil {
		return nil, err
	}
	var moved []domain.Movement
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		from, err := h.villaInScope(ctx, p, in.VillaID)
		if err != nil {
			return err
		}
		b, err := h.open(ctx, p.Name)
		if err != nil {
			return err
		}
		lines := domain.Lines(in.Lines)
		reason := strings.TrimSpace(in.Reason)
		var line audit.Line
		switch in.Kind {
		case domain.Issue:
			unit, err := h.Repo.Unit(ctx, *in.UnitID)
			if err != nil {
				return err
			}
			if unit.VillaID != from.ID {
				return errs.Newf(errs.CodeValidation, "%s is not in %s.", unit.Code, from.Name)
			}
			why := reason
			if why == "" {
				why = "Issued to " + unit.Code
			}
			if moved, err = b.Take(ctx, from, lines, domain.Movement{Kind: domain.Issue, UnitID: ptr(unit.ID), Reason: why}); err != nil {
				return err
			}
			line.Summary = fmt.Sprintf("Issued %d items from %s to %s", len(lines), from.Name, unit.Code)
		case domain.Transfer:
			to, err := h.villaInScope(ctx, p, *in.ToVillaID)
			if err != nil {
				return err
			}
			n, err := h.Repo.Next(ctx, "stockTransfer")
			if err != nil {
				return err
			}
			transferID := fmt.Sprintf("stf-%d", n)
			out, err := b.Take(ctx, from, lines, domain.Movement{Kind: domain.Transfer, TransferID: ptr(transferID), OtherVillaID: ptr(to.ID), Reason: reason})
			if err != nil {
				return err
			}
			moved = out
			for _, m := range out {
				back, err := b.Push(ctx, domain.Movement{VillaID: to.ID, ItemID: m.ItemID, Kind: domain.Transfer, Quantity: -m.Quantity, UnitCost: m.UnitCost, TransferID: ptr(transferID), OtherVillaID: ptr(from.ID), Reason: reason})
				if err != nil {
					return err
				}
				moved = append(moved, back)
			}
			line.Summary = fmt.Sprintf("Moved %d items from %s to %s", len(lines), from.Name, to.Name)
		default:
			if moved, err = b.Take(ctx, from, lines, domain.Movement{Kind: domain.WriteOff, Reason: reason}); err != nil {
				return err
			}
			line.Summary = fmt.Sprintf("Wrote off %d items in %s: %s", len(lines), from.Name, reason)
		}
		if err := b.Close(ctx); err != nil {
			return err
		}
		line.Action, line.Entity = audit.Create, "stock-movement"
		if len(moved) > 0 {
			line.EntityID = moved[0].Number
		}
		return h.record(ctx, p, line)
	})
	return moved, err
}

// TakeCount records a shelf count of one villa store and posts each difference against the
// expected quantity as a count adjustment in the counter's name; it needs maintenance/edit.
type TakeCount struct{ Deps }

// Handle records the count.
func (h TakeCount) Handle(ctx context.Context, p auth.Principal, in domain.CountInput) (domain.Count, error) {
	if err := h.Authz.Require(ctx, p.Role, needEdit); err != nil {
		return domain.Count{}, err
	}
	if err := domain.ValidateCount(in); err != nil {
		return domain.Count{}, err
	}
	var c domain.Count
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		villa, err := h.villaInScope(ctx, p, in.VillaID)
		if err != nil {
			return err
		}
		b, err := h.open(ctx, p.Name)
		if err != nil {
			return err
		}
		n, err := h.Repo.Next(ctx, "stockCount")
		if err != nil {
			return err
		}
		countedBy := strings.TrimSpace(in.CountedBy)
		c = domain.Count{ID: fmt.Sprintf("scx-%d", n), Number: fmt.Sprintf("SC-%d", 100+n), VillaID: villa.ID, CountedBy: countedBy, CountedOn: h.today(), Note: strings.TrimSpace(in.Note)}
		for _, l := range in.Lines {
			c.Lines = append(c.Lines, domain.CountLine{ItemID: l.ItemID, Expected: b.Held(villa.ID, l.ItemID), Counted: int(l.Counted), UnitCost: b.Average(l.ItemID)})
		}
		if err := h.Repo.InsertCount(ctx, c); err != nil {
			return err
		}
		for _, l := range c.Lines {
			if l.Variance() == 0 {
				continue
			}
			if _, err := b.Push(ctx, domain.Movement{VillaID: villa.ID, ItemID: l.ItemID, Kind: domain.Adjustment, Quantity: l.Variance(), By: countedBy, CountID: ptr(c.ID), Reason: fmt.Sprintf("Count %s by %s", c.Number, countedBy)}); err != nil {
				return err
			}
		}
		if err := b.Close(ctx); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "stock-count", EntityID: c.Number, Summary: fmt.Sprintf("Counted %d items in %s", len(c.Lines), villa.Name)})
	})
	return c, err
}
