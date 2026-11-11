package command

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// SaveLinenPar sets a room type's linen par.
type SaveLinenPar struct{ Deps }

// Handle saves the par. Lines without pieces drop out first, as the service does.
func (h SaveLinenPar) Handle(ctx context.Context, p auth.Principal, groupID string, in domain.ParInput) (domain.LinenPar, error) {
	var par domain.LinenPar
	if err := h.need(ctx, p, "edit"); err != nil {
		return par, err
	}
	in.Lines = domain.Positive(in.Lines)
	if err := domain.ValidatePar(in); err != nil {
		return par, err
	}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		group, err := h.Store.Group(ctx, groupID)
		if err != nil {
			return err
		}
		if _, err := h.villaInScope(ctx, p, group.VillaID); err != nil {
			return err
		}
		if err := h.linenOnly(ctx, in.Lines); err != nil {
			return err
		}
		old, err := h.Store.Par(ctx, groupID)
		if err != nil {
			return err
		}
		par = domain.LinenPar{GroupID: groupID, Sets: in.Sets, Lines: in.Lines}
		if old != nil {
			par.Version = old.Version
		}
		if err := h.Store.SavePar(ctx, &par, group.VillaID); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "linen-par", EntityID: groupID,
			Summary: fmt.Sprintf("Set the %s linen par to %d sets of %d items", group.Name, par.Sets, len(par.Lines))})
	})
	return par, err
}

// linenOnly refuses a stock item that is not linen. Without inventory the rule cannot see kinds
// and passes.
func (d Deps) linenOnly(ctx context.Context, lines []domain.Line) error {
	items, err := d.Clients.Stock.Items(ctx)
	if errs.HasCode(err, CodeNotAvailable) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, l := range lines {
		found := false
		for _, i := range items {
			if i.ID == l.ItemID {
				found = true
				if i.Kind != "linen" {
					return errs.New(errs.CodeValidation, "Only linen items make a linen par.")
				}
			}
		}
		if !found {
			return errs.NotFound("stock item", l.ItemID)
		}
	}
	return nil
}

// takeSoiled is assertSoiled then the bags lose the pieces: LINEN_SHORT when the villa holds fewer.
func (d Deps) takeSoiled(ctx context.Context, villa domain.Villa, lines []domain.Line) error {
	for _, l := range lines {
		held, err := d.Store.Soiled(ctx, villa.ID, l.ItemID)
		if err != nil {
			return err
		}
		if l.Quantity > held {
			name, err := d.itemName(ctx, l.ItemID)
			if err != nil {
				return err
			}
			return errs.Newf("LINEN_SHORT", "%s holds %d soiled %s; %d cannot leave.", villa.Name, held, name, l.Quantity)
		}
	}
	return d.Store.AddSoiled(ctx, villa.ID, lines, -1)
}

// writeOff numbers a discard and appends linen.discarded for inventory; it returns the discard id.
func (d Deps) writeOff(ctx context.Context, p auth.Principal, villa domain.Villa, from string, lines []domain.Line, reason, batchID string) (string, error) {
	n, err := d.Store.Next(ctx, "linenDiscard")
	if err != nil {
		return "", err
	}
	id := fmt.Sprintf("lnd-%d", n)
	out := make([]housekeeping.Line, len(lines))
	for i, l := range lines {
		out[i] = housekeeping.Line{ItemID: l.ItemID, Quantity: l.Quantity}
	}
	return id, d.emit(ctx, housekeeping.EventLinenDiscarded, "linen_discard", id, 1, housekeeping.LinenDiscarded{
		DiscardID: id, VillaID: villa.ID, LocationID: villa.LocationID, From: from, Lines: out, Reason: reason, BatchID: batchID,
		On: d.today(), By: p.Name, ByID: p.UserID,
	})
}

// WriteOff is one line of a discard in StockMovement's shape, as POST linen/discards answers. Its
// number is the discard id inventory books the movement under; unitCost is inventory's to set.
type WriteOff struct {
	ID           string  `json:"id"`
	Number       string  `json:"number"`
	VillaID      string  `json:"villaId"`
	ItemID       string  `json:"itemId"`
	Kind         string  `json:"kind"`
	Quantity     int     `json:"quantity"`
	UnitCost     int64   `json:"unitCost"`
	On           string  `json:"on"`
	By           string  `json:"by"`
	UnitID       *string `json:"unitId"`
	BookingID    *string `json:"bookingId"`
	OrderID      *string `json:"orderId"`
	ReceiptID    *string `json:"receiptId"`
	CountID      *string `json:"countId"`
	TransferID   *string `json:"transferId"`
	OtherVillaID *string `json:"otherVillaId"`
	Reason       string  `json:"reason"`
}

// DiscardLinen takes pieces out of soiled or clean and asks inventory to write them off.
type DiscardLinen struct{ Deps }

// Handle discards the linen.
func (h DiscardLinen) Handle(ctx context.Context, p auth.Principal, in domain.Discard) ([]WriteOff, error) {
	var out []WriteOff
	if err := h.need(ctx, p, "edit"); err != nil {
		return out, err
	}
	if err := domain.ValidateDiscard(in); err != nil {
		return out, err
	}
	if in.From != "soiled" && in.From != "clean" {
		return out, errs.Invalid("from", "Pick soiled or clean.")
	}
	lines := domain.Positive(in.Lines)
	reason := "Linen discarded: " + strings.TrimSpace(in.Reason)
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		villa, err := h.villaInScope(ctx, p, in.VillaID)
		if err != nil {
			return err
		}
		if in.From == "soiled" {
			if err := h.takeSoiled(ctx, villa, lines); err != nil {
				return err
			}
		}
		id, err := h.writeOff(ctx, p, villa, in.From, lines, reason, "")
		if err != nil {
			return err
		}
		for i, l := range lines {
			out = append(out, WriteOff{ID: fmt.Sprintf("%s-%d", id, i+1), Number: id, VillaID: villa.ID, ItemID: l.ItemID, Kind: "write_off",
				Quantity: -l.Quantity, On: h.today(), By: p.Name, Reason: reason})
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "linen-discard", EntityID: id,
			Summary: fmt.Sprintf("Discarded %d linen pieces in %s", domain.Pieces(lines), villa.Name)})
	})
	return out, err
}

// SendLaundry moves soiled linen to a laundry vendor.
type SendLaundry struct{ Deps }

// Handle opens the batch.
func (h SendLaundry) Handle(ctx context.Context, p auth.Principal, in domain.SendInput) (domain.LaundryBatch, error) {
	var b domain.LaundryBatch
	if err := h.need(ctx, p, "edit"); err != nil {
		return b, err
	}
	if err := domain.ValidateSend(in); err != nil {
		return b, err
	}
	lines := domain.Positive(in.Lines)
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		villa, err := h.villaInScope(ctx, p, in.VillaID)
		if err != nil {
			return err
		}
		if err := h.takeSoiled(ctx, villa, lines); err != nil {
			return err
		}
		n, err := h.Store.Next(ctx, "laundryBatch")
		if err != nil {
			return err
		}
		b = domain.LaundryBatch{ID: fmt.Sprintf("lnb-%d", n), Number: fmt.Sprintf("LDY-%d", 200+n), VillaID: villa.ID, Vendor: strings.TrimSpace(in.Vendor),
			Status: domain.Out, SentOn: in.SentOn, Method: "cash", SentBy: p.Name, Note: strings.TrimSpace(in.Note)}
		for _, l := range lines {
			b.Lines = append(b.Lines, domain.LaundryLine{ItemID: l.ItemID, Sent: l.Quantity})
		}
		b.Normalize()
		if err := h.Store.InsertBatch(ctx, &b); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "laundry-batch", EntityID: b.Number,
			Summary: fmt.Sprintf("Sent %d pieces from %s to %s", domain.Pieces(lines), villa.Name, b.Vendor)})
	})
	return b, err
}

// ReturnLaundry counts what came back; losses go to inventory as a write-off and the bill to
// finance as a cash-out for approval.
type ReturnLaundry struct{ Deps }

// Handle closes the batch.
func (h ReturnLaundry) Handle(ctx context.Context, p auth.Principal, id string, in domain.ReturnInput) (domain.LaundryBatch, error) {
	var b domain.LaundryBatch
	action := rbac.Action("edit")
	if in.Cost > 0 {
		action = "submit"
	}
	if err := h.need(ctx, p, action); err != nil {
		return b, err
	}
	if err := h.editor(ctx, p); err != nil {
		return b, err
	}
	if in.Attachments == nil {
		in.Attachments = []json.RawMessage{}
	}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if b, err = h.Store.Batch(ctx, id); err != nil {
			return err
		}
		villa, err := h.villaInScope(ctx, p, b.VillaID)
		if err != nil {
			return err
		}
		if b.Status != domain.Out {
			returned := ""
			if b.ReturnedOn != nil {
				returned = *b.ReturnedOn
			}
			return errs.Newf("LAUNDRY_INVALID_STATE", "%s came back on %s.", b.Number, returned)
		}
		if err := domain.ValidateReturn(b, in); err != nil {
			return err
		}
		lost := domain.ApplyReturn(&b, in)
		b.WriteOffs = []string{}
		if len(lost) > 0 {
			discard, err := h.writeOff(ctx, p, villa, "laundry", lost, fmt.Sprintf("Laundry %s: missing or damaged at %s", b.Number, b.Vendor), b.ID)
			if err != nil {
				return err
			}
			b.WriteOffs = []string{discard}
		}
		b.Status, b.ReturnedOn, b.Cost, b.Method = domain.Returned, ptr(in.ReturnedOn), in.Cost, in.Method
		b.Reference, b.Attachments, b.ReturnedBy = strings.TrimSpace(in.Reference), in.Attachments, p.Name
		if err := h.Store.UpdateBatch(ctx, &b); err != nil {
			return err
		}
		if in.Cost > 0 {
			reference := b.Reference
			if reference == "" {
				reference = b.Number
			}
			if err := h.emit(ctx, housekeeping.EventLaundryBilled, "laundry_batch", b.ID, b.Version, housekeeping.LaundryBilled{
				BatchID: b.ID, Number: b.Number, VillaID: villa.ID, LocationID: villa.LocationID, Vendor: b.Vendor, Amount: in.Cost, Method: in.Method,
				Date: in.ReturnedOn, CategoryID: "cat-house", Origin: "maintenance", Description: fmt.Sprintf("%s laundry, %s", b.Number, b.Vendor),
				Reference: reference, Attachments: in.Attachments, By: p.Name, ByID: p.UserID,
			}); err != nil {
				return err
			}
		}
		summary := fmt.Sprintf("%s back from %s", b.Number, b.Vendor)
		if len(lost) > 0 {
			summary += fmt.Sprintf(", %d pieces written off", domain.Pieces(lost))
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "laundry-batch", EntityID: b.Number, Summary: summary, After: map[string]any{"cost": in.Cost}})
	})
	return b, err
}
