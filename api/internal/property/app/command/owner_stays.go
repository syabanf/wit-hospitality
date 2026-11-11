package command

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/owners"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/property"
	"github.com/syabanf/wit-hospitality/api/internal/property/domain"
)

// AddOwnerBlock is property's policy on owners.stay.decided: an approved owner stay puts an owner
// block on its unit, with the id owners chose, and publishes unit_block.added. Owners already
// checked the permission, the unit and the free nights, and recorded the audit line. A block that
// exists, or a unit property does not know, is left alone, so a redelivery changes nothing.
type AddOwnerBlock struct{ Deps }

// Handle adds the block inside the projector's transaction.
func (h AddOwnerBlock) Handle(ctx context.Context, b owners.StayBlock) error {
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		if _, err := h.Repo.Block(ctx, b.ID); err == nil || !errs.HasCode(err, errs.CodeNotFound) {
			return err
		}
		unit, err := h.Repo.Unit(ctx, b.UnitID)
		if errs.HasCode(err, errs.CodeNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		villa, err := h.Repo.Villa(ctx, unit.VillaID)
		if err != nil {
			return err
		}
		block := domain.NewBlock(b.ID, domain.BlockInput{UnitID: b.UnitID, From: b.From, To: b.To, Reason: "owner", Note: b.Note})
		if err := h.Repo.InsertBlock(ctx, block); err != nil {
			return err
		}
		state := property.Block{ID: block.ID, UnitID: block.UnitID, From: block.From, To: block.To, Reason: block.Reason, Note: block.Note}
		return h.emit(ctx, property.EventBlockAdded, "unit_block", block.ID, 1, property.BlockAdded{Block: state, VillaID: villa.ID, LocationID: villa.LocationID})
	})
}
