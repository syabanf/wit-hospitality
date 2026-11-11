package command

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/ids"
	"github.com/syabanf/wit-hospitality/api/internal/property"
	"github.com/syabanf/wit-hospitality/api/internal/property/domain"
)

// HoldBlock blocks a unit for another context's job (a maintenance work order). The caller has
// checked its own permission and the villa scope and records its own audit line, so this handler
// checks neither; a stay on those nights still refuses it.
type HoldBlock struct{ Deps }

// Handle adds a maintenance block on [from, to) and returns its id.
func (h HoldBlock) Handle(ctx context.Context, unitID, from, to, note string) (string, error) {
	var id string
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		unit, err := h.Repo.Unit(ctx, unitID)
		if err != nil {
			return err
		}
		villa, err := h.Repo.Villa(ctx, unit.VillaID)
		if err != nil {
			return err
		}
		if code, clash, err := h.Stays.OverlappingStay(ctx, unit.ID, from, to); err != nil {
			return err
		} else if clash {
			return errs.Newf("BLOCK_OVERLAP", "%s has %s on those nights. Move the guest before blocking.", unit.Code, code)
		}
		b := domain.UnitBlock{ID: ids.Random("blk"), UnitID: unit.ID, From: from, To: to, Reason: "maintenance", Note: note}
		if err := h.Repo.InsertBlock(ctx, b); err != nil {
			return err
		}
		id = b.ID
		state := property.Block{ID: b.ID, UnitID: b.UnitID, From: b.From, To: b.To, Reason: b.Reason, Note: b.Note}
		return h.emit(ctx, property.EventBlockAdded, "unit_block", b.ID, 1, property.BlockAdded{Block: state, VillaID: villa.ID, LocationID: villa.LocationID})
	})
	return id, err
}

// ReleaseBlock frees a held unit from today on: a block that has not started goes, one under way
// ends today, so the nights already lost stay for the downtime report.
type ReleaseBlock struct{ Deps }

// Handle releases the block.
func (h ReleaseBlock) Handle(ctx context.Context, id, today string) error {
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
		switch {
		case b.From >= today:
			if err := h.Repo.DeleteBlock(ctx, id); err != nil {
				return err
			}
			return h.emit(ctx, property.EventBlockRemoved, "unit_block", id, 3, property.BlockRemoved{ID: id, UnitID: b.UnitID})
		case b.To > today:
			if err := h.Repo.TrimBlock(ctx, id, today); err != nil {
				return err
			}
			b.To = today
			state := property.Block{ID: b.ID, UnitID: b.UnitID, From: b.From, To: b.To, Reason: b.Reason, Note: b.Note}
			return h.emit(ctx, property.EventBlockTrimmed, "unit_block", id, 2, property.BlockAdded{Block: state, VillaID: villa.ID, LocationID: villa.LocationID})
		}
		return nil
	})
}
