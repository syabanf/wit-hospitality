package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/ids"
	"github.com/syabanf/wit-hospitality/api/internal/property"
	"github.com/syabanf/wit-hospitality/api/internal/property/domain"
)

// AddBlock holds a unit off sale; it needs booking/create or property/edit and the villa in scope.
// A block cannot cover a night a stay holds.
type AddBlock struct{ Deps }

// Handle adds the block.
func (h AddBlock) Handle(ctx context.Context, p auth.Principal, in domain.BlockInput) (domain.UnitBlock, error) {
	if err := h.Authz.Require(ctx, p.Role, blockAdd...); err != nil {
		return domain.UnitBlock{}, err
	}
	if err := domain.ValidateBlock(in); err != nil {
		return domain.UnitBlock{}, err
	}
	var b domain.UnitBlock
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		unit, err := h.Repo.Unit(ctx, in.UnitID)
		if err != nil {
			return err
		}
		villa, err := h.Repo.Villa(ctx, unit.VillaID)
		if err != nil {
			return err
		}
		if err := inScope(p, villa); err != nil {
			return err
		}
		if code, clash, err := h.Stays.OverlappingStay(ctx, unit.ID, in.From, in.To); err != nil {
			return err
		} else if clash {
			return domain.ErrBlockOverlap(unit.Code, code)
		}
		b = domain.NewBlock(ids.Random("blk"), in)
		if err := h.Repo.InsertBlock(ctx, b); err != nil {
			return err
		}
		state := property.Block{ID: b.ID, UnitID: b.UnitID, From: b.From, To: b.To, Reason: b.Reason, Note: b.Note}
		if err := h.emit(ctx, property.EventBlockAdded, "unit_block", b.ID, 1, property.BlockAdded{Block: state, VillaID: villa.ID, LocationID: villa.LocationID}); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "block", EntityID: b.ID, Summary: fmt.Sprintf("Blocked %s %s to %s: %s", unit.Code, b.From, b.To, b.Reason)})
	})
	return b, err
}

// RemoveBlock puts the unit back on sale; it needs booking/edit or property/edit.
type RemoveBlock struct{ Deps }

// Handle removes the block.
func (h RemoveBlock) Handle(ctx context.Context, p auth.Principal, id string) error {
	if err := h.Authz.Require(ctx, p.Role, blockRemove...); err != nil {
		return err
	}
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		b, err := h.Repo.Block(ctx, id)
		if err != nil {
			return err
		}
		unit, err := h.Repo.Unit(ctx, b.UnitID)
		if err != nil {
			return err
		}
		villa, err := h.Repo.Villa(ctx, unit.VillaID)
		if err != nil {
			return err
		}
		if err := inScope(p, villa); err != nil {
			return err
		}
		if err := h.Repo.DeleteBlock(ctx, id); err != nil {
			return err
		}
		if err := h.emit(ctx, property.EventBlockRemoved, "unit_block", id, 2, property.BlockRemoved{ID: id, UnitID: b.UnitID}); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Delete, Entity: "block", EntityID: id, Summary: fmt.Sprintf("Removed the block on %s", unit.Code)})
	})
}
