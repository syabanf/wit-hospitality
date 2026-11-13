package command

import (
	"context"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/ids"
	"github.com/syabanf/wit-hospitality/api/internal/property"
	"github.com/syabanf/wit-hospitality/api/internal/property/domain"
)

// HoldBlock blocks a unit for another context's job (a maintenance work order). The caller has
// checked its own permission and the villa scope and records its own audit line, so this handler
// checks neither; a stay on those nights still refuses it. A block under way today takes a unit
// in service to maintenance, with the job as the reason and the block's end as its return.
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
		if err := h.emit(ctx, property.EventBlockAdded, "unit_block", b.ID, 1, property.BlockAdded{Block: state, VillaID: villa.ID, LocationID: villa.LocationID}); err != nil {
			return err
		}
		today := clock.Today(h.Clock)
		if from > today || to <= today || (unit.Status != domain.UnitActive && unit.Status != domain.UnitCleaning) {
			return nil
		}
		return h.moveStatus(ctx, &unit, villa, domain.UnitMaintenance, note, &to, domain.ByMaintenance)
	})
	return id, err
}

// ReleaseBlock frees a held unit from today on: a block that has not started goes, one under way
// ends today, so the nights already lost stay for the downtime report. A unit the block took to
// maintenance comes back into service.
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
			if err := h.emit(ctx, property.EventBlockRemoved, "unit_block", id, 3, property.BlockRemoved{ID: id, UnitID: b.UnitID}); err != nil {
				return err
			}
		case b.To > today:
			if err := h.Repo.TrimBlock(ctx, id, today); err != nil {
				return err
			}
			b.To = today
			state := property.Block{ID: b.ID, UnitID: b.UnitID, From: b.From, To: b.To, Reason: b.Reason, Note: b.Note}
			if err := h.emit(ctx, property.EventBlockTrimmed, "unit_block", id, 2, property.BlockAdded{Block: state, VillaID: villa.ID, LocationID: villa.LocationID}); err != nil {
				return err
			}
		}
		if unit.Status != domain.UnitMaintenance || unit.StatusReason != strings.TrimSpace(b.Note) {
			return nil
		}
		return h.moveStatus(ctx, &unit, villa, domain.UnitActive, "", nil, domain.ByMaintenance)
	})
}

// FollowRoomState is property's policy on housekeeping.room.state_changed: a unit in service goes
// to cleaning when an attendant starts on it and back to active when the room is ready. Other
// board moves leave the unit alone, and so does a unit already where the move would take it, so a
// redelivery changes nothing.
type FollowRoomState struct{ Deps }

// Handle applies the board move inside the projector's transaction.
func (h FollowRoomState) Handle(ctx context.Context, unitID, to, note string) error {
	from, next := "", ""
	switch to {
	case "cleaning":
		from, next = domain.UnitActive, domain.UnitCleaning
	case "ready":
		from, next = domain.UnitCleaning, domain.UnitActive
	default:
		return nil
	}
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		u, err := h.Repo.Unit(ctx, unitID)
		if errs.HasCode(err, errs.CodeNotFound) {
			return nil
		}
		if err != nil || u.Status != from {
			return err
		}
		villa, err := h.Repo.Villa(ctx, u.VillaID)
		if err != nil {
			return err
		}
		return h.moveStatus(ctx, &u, villa, next, note, nil, domain.ByHousekeeping)
	})
}
