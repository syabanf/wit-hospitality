package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/inventory"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// purchase is purchaseFields: the cash-out a receipt submits. Minibar-only purchases book to
// cat-minibar, the rest to cat-house.
func purchase(b *Book, villa Villa, number string, in domain.ReceiptInput, lines []domain.ReceiptLine) inventory.CashOut {
	category := "cat-minibar"
	for _, l := range lines {
		if b.items[l.ItemID].Kind != "minibar" {
			category = "cat-house"
		}
	}
	reference := strings.TrimSpace(in.Reference)
	if reference == "" {
		reference = number
	}
	attachments := make([]inventory.Attachment, 0, len(in.Attachments))
	for _, a := range in.Attachments {
		attachments = append(attachments, inventory.Attachment(a))
	}
	return inventory.CashOut{
		Origin: "stock", Kind: "cash_out", CategoryID: category, Method: in.Method, Amount: domain.ReceiptTotal(lines), Date: in.ReceivedOn,
		LocationID: villa.LocationID, VillaID: villa.ID, Description: fmt.Sprintf("%s stock purchase, %s", number, strings.TrimSpace(in.Supplier)),
		Reference: reference, Attachments: attachments,
	}
}

func attachments(a []domain.Attachment) []domain.Attachment {
	if a == nil {
		return []domain.Attachment{}
	}
	return a
}

// Receive books goods into a villa store, moves the average cost and submits the purchase as a
// cash-out for approval; it needs maintenance/submit.
type Receive struct{ Deps }

// Handle books the receipt.
func (h Receive) Handle(ctx context.Context, p auth.Principal, in domain.ReceiptInput) (domain.StockReceipt, error) {
	if err := h.Authz.Require(ctx, p.Role, needSubmit); err != nil {
		return domain.StockReceipt{}, err
	}
	if err := domain.ValidateReceipt(in); err != nil {
		return domain.StockReceipt{}, err
	}
	var r domain.StockReceipt
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		villa, err := h.villaInScope(ctx, p, in.VillaID)
		if err != nil {
			return err
		}
		b, err := h.open(ctx, p.Name)
		if err != nil {
			return err
		}
		lines := domain.ReceiptLines(in.Lines)
		for _, l := range lines {
			if _, err := b.Item(l.ItemID); err != nil {
				return err
			}
		}
		n, err := h.Repo.Next(ctx, "stockReceipt")
		if err != nil {
			return err
		}
		id, number := fmt.Sprintf("srx-%d", n), fmt.Sprintf("SR-%d", 300+n)
		req := purchase(b, villa, number, in, lines)
		req.SourceID = id
		t, err := h.CashOuts.Submit(ctx, p, req)
		if err != nil {
			return err
		}
		r = domain.StockReceipt{
			ID: id, Number: number, VillaID: villa.ID, Supplier: strings.TrimSpace(in.Supplier), Lines: lines, Method: in.Method,
			Reference: strings.TrimSpace(in.Reference), Attachments: attachments(in.Attachments), ReceivedOn: in.ReceivedOn,
			TransactionID: ptr(t.ID), CreatedBy: p.Name, CreatedOn: h.today(),
		}
		if err := h.Repo.InsertReceipt(ctx, &r); err != nil {
			return err
		}
		for _, l := range lines {
			if _, err := b.Push(ctx, domain.Movement{VillaID: villa.ID, ItemID: l.ItemID, Kind: domain.Receipt, Quantity: l.Quantity, UnitCost: l.UnitCost, On: in.ReceivedOn, ReceiptID: ptr(r.ID), Reason: r.Supplier}); err != nil {
				return err
			}
		}
		if err := b.Close(ctx); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{
			Action: audit.Create, Entity: "stock-receipt", EntityID: number,
			Summary: fmt.Sprintf("Received %d items into %s from %s, %s for approval", len(lines), villa.Name, r.Supplier, t.Number),
			After:   map[string]any{"amount": req.Amount},
		})
	})
	return r, err
}

// rejected is rejectedPurchase: a rejected purchase the signed-in person may still fix or
// cancel, as its author or someone who approves maintenance.
func (d Deps) rejected(ctx context.Context, p auth.Principal, id string) (domain.StockReceipt, CashOutStatus, error) {
	r, err := d.Repo.Receipt(ctx, id)
	if err != nil {
		return r, CashOutStatus{}, err
	}
	if r.TransactionID == nil {
		return r, CashOutStatus{}, errs.Newf(errs.CodeValidation, "%s is opening stock with no cash-out.", r.Number)
	}
	t, err := d.CashOuts.Status(ctx, *r.TransactionID)
	if errs.HasCode(err, errs.CodeNotFound) {
		return r, t, errs.Newf(errs.CodeValidation, "%s is opening stock with no cash-out.", r.Number)
	}
	if err != nil {
		return r, t, err
	}
	if r.CancelledOn != nil {
		return r, t, errs.Newf("TRANSACTION_INVALID_STATE", "%s was cancelled on %s.", r.Number, *r.CancelledOn)
	}
	if t.Status != "rejected" {
		return r, t, errs.Newf("TRANSACTION_INVALID_STATE", "%s is %s; only a rejected purchase can be corrected or cancelled.", t.Number, t.Status)
	}
	if t.CreatedByID != p.UserID {
		ok, err := d.can(ctx, p, needApprove)
		if err != nil {
			return r, t, err
		}
		if !ok {
			return r, t, errs.Forbidden(fmt.Sprintf("Only %s or a manager can fix %s.", t.CreatedBy, r.Number))
		}
	}
	return r, t, nil
}

// neverShort is assertNeverShort: it replays the store as if the receipt had come in as lines on
// `on` (or never, with no lines) and refuses the change when any day from the earlier receipt
// date on would close below zero, because that stock is already used.
func neverShort(b *Book, villa Villa, r domain.StockReceipt, lines []domain.ReceiptLine, on, change string) error {
	kept := make([]domain.Movement, 0, len(b.moves))
	for _, m := range b.moves {
		if m.ReceiptID == nil || *m.ReceiptID != r.ID {
			kept = append(kept, m)
		}
	}
	for i, l := range lines {
		kept = append(kept, domain.Movement{VillaID: r.VillaID, ItemID: l.ItemID, Kind: domain.Receipt, Quantity: l.Quantity, UnitCost: l.UnitCost, On: on, Number: fmt.Sprintf("%s-%d", r.Number, i), ReceiptID: ptr(r.ID)})
	}
	from := r.ReceivedOn
	if on < from {
		from = on
	}
	seen := map[string]bool{}
	for _, l := range append(append([]domain.ReceiptLine{}, r.Lines...), lines...) {
		if seen[l.ItemID] {
			continue
		}
		seen[l.ItemID] = true
		if short := domain.FirstShortfall(kept, r.VillaID, l.ItemID, from); short != nil {
			item, err := b.Item(l.ItemID)
			if err != nil {
				return err
			}
			return errs.Newf("STOCK_SHORT", "%s %s would leave %s at %d %s on %s; that stock is already used. Correct the receipt down to what is left, or count the store first.",
				change, r.Number, villa.Name, short.Held, item.Name, short.On)
		}
	}
	return nil
}

// ReceiptCorrection is ReceiptCorrection: what a correction may change; the villa store stays.
type ReceiptCorrection struct {
	Supplier    string                    `json:"supplier"`
	Lines       []domain.ReceiptLineInput `json:"lines"`
	Method      string                    `json:"method"`
	Reference   string                    `json:"reference"`
	Attachments []domain.Attachment       `json:"attachments"`
	ReceivedOn  string                    `json:"receivedOn"`
}

// CorrectReceipt fixes a receipt whose cash-out finance rejected and resubmits the same
// cash-out: the old lines leave the movements and the average cost, the corrected ones go in. It
// needs maintenance/submit, and the author or someone who approves maintenance.
type CorrectReceipt struct{ Deps }

// Handle corrects the receipt.
func (h CorrectReceipt) Handle(ctx context.Context, p auth.Principal, id string, in ReceiptCorrection) (domain.StockReceipt, error) {
	if err := h.Authz.Require(ctx, p.Role, needSubmit); err != nil {
		return domain.StockReceipt{}, err
	}
	var r domain.StockReceipt
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		b, err := h.open(ctx, p.Name)
		if err != nil {
			return err
		}
		var t CashOutStatus
		if r, t, err = h.rejected(ctx, p, id); err != nil {
			return err
		}
		full := domain.ReceiptInput{VillaID: r.VillaID, Supplier: in.Supplier, Lines: in.Lines, Method: in.Method, Reference: in.Reference, Attachments: in.Attachments, ReceivedOn: in.ReceivedOn}
		if err := domain.ValidateReceipt(full); err != nil {
			return err
		}
		villa, err := h.villaInScope(ctx, p, r.VillaID)
		if err != nil {
			return err
		}
		lines := domain.ReceiptLines(in.Lines)
		for _, l := range lines {
			if _, err := b.Item(l.ItemID); err != nil {
				return err
			}
		}
		if err := neverShort(b, villa, r, lines, in.ReceivedOn, "Correcting"); err != nil {
			return err
		}
		before := map[string]any{"amount": r.Total(), "lines": len(r.Lines)}
		req := purchase(b, villa, r.Number, full, lines)
		req.SourceID = r.ID
		if _, err := h.CashOuts.Correct(ctx, p, t.ID, req, "Corrected from "+r.Number); err != nil {
			return err
		}
		if err := h.replaceLines(ctx, b, r, lines, in); err != nil {
			return err
		}
		r.Supplier, r.Lines, r.Method = strings.TrimSpace(in.Supplier), lines, in.Method
		r.Reference, r.Attachments, r.ReceivedOn = strings.TrimSpace(in.Reference), attachments(in.Attachments), in.ReceivedOn
		if err := h.Repo.UpdateReceipt(ctx, &r); err != nil {
			return err
		}
		if err := b.Close(ctx); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{
			Action: audit.Update, Entity: "stock-receipt", EntityID: r.Number, Summary: fmt.Sprintf("Corrected %s and resubmitted %s", r.Number, t.Number),
			Before: before, After: map[string]any{"amount": req.Amount, "lines": len(r.Lines)},
		})
	})
	return r, err
}

// replaceLines swaps the receipt's movements for the corrected lines: an item already on the
// receipt keeps its movement with the new quantity, price and date; a new item gets a new one.
func (h CorrectReceipt) replaceLines(ctx context.Context, b *Book, r domain.StockReceipt, lines []domain.ReceiptLine, in ReceiptCorrection) error {
	old := map[string]domain.Movement{}
	for _, m := range b.moves {
		if m.ReceiptID != nil && *m.ReceiptID == r.ID {
			old[m.ItemID] = m
		}
	}
	b.Replace(r.ID, func(domain.Movement) bool { return false })
	supplier := strings.TrimSpace(in.Supplier)
	for _, l := range lines {
		same, ok := old[l.ItemID]
		if !ok {
			if _, err := b.Push(ctx, domain.Movement{VillaID: r.VillaID, ItemID: l.ItemID, Kind: domain.Receipt, Quantity: l.Quantity, UnitCost: l.UnitCost, On: in.ReceivedOn, ReceiptID: ptr(r.ID), Reason: supplier}); err != nil {
				return err
			}
			continue
		}
		delete(old, l.ItemID)
		same.Quantity, same.UnitCost, same.On, same.Reason = l.Quantity, l.UnitCost, in.ReceivedOn, supplier
		if err := h.Repo.UpdateMovement(ctx, same); err != nil {
			return err
		}
		b.moves = append(b.moves, same)
	}
	for _, gone := range old {
		if err := h.Repo.DeleteMovement(ctx, gone.ID); err != nil {
			return err
		}
	}
	b.replay = nil
	return nil
}

// CancelInput is the body of POST stock/receipts/{id}/cancel.
type CancelInput struct {
	Reason string `json:"reason"`
}

// CancelReceipt gives up a rejected purchase: its stock leaves the store again (STOCK_SHORT when
// already used) and the cash-out stays rejected for good. It needs maintenance/submit, and the
// author or someone who approves maintenance.
type CancelReceipt struct{ Deps }

// Handle cancels the receipt.
func (h CancelReceipt) Handle(ctx context.Context, p auth.Principal, id string, in CancelInput) (domain.StockReceipt, error) {
	if err := h.Authz.Require(ctx, p.Role, needSubmit); err != nil {
		return domain.StockReceipt{}, err
	}
	var r domain.StockReceipt
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		b, err := h.open(ctx, p.Name)
		if err != nil {
			return err
		}
		var t CashOutStatus
		if r, t, err = h.rejected(ctx, p, id); err != nil {
			return err
		}
		reason := strings.TrimSpace(in.Reason)
		if len([]rune(reason)) < 3 {
			return errs.Invalid("reason", "Say why the purchase is cancelled.")
		}
		villa, err := h.villaInScope(ctx, p, r.VillaID)
		if err != nil {
			return err
		}
		if err := neverShort(b, villa, r, nil, r.ReceivedOn, "Cancelling"); err != nil {
			return err
		}
		// The reversal keeps the history; the replay drops both halves, as if the receipt never came in.
		for _, l := range r.Lines {
			if _, err := b.Push(ctx, domain.Movement{VillaID: r.VillaID, ItemID: l.ItemID, Kind: domain.Receipt, Quantity: -l.Quantity, UnitCost: l.UnitCost, ReceiptID: ptr(r.ID), Reason: fmt.Sprintf("Cancelled %s: %s", r.Number, reason)}); err != nil {
				return err
			}
		}
		r.CancelledOn = ptr(h.today())
		if err := h.Repo.UpdateReceipt(ctx, &r); err != nil {
			return err
		}
		if err := h.CashOuts.Cancel(ctx, p, t.ID, fmt.Sprintf("Closed: %s cancelled. %s", r.Number, reason)); err != nil {
			return err
		}
		if err := b.Close(ctx); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "stock-receipt", EntityID: r.Number, Summary: fmt.Sprintf("Cancelled %s; its stock left %s and %s stays rejected", r.Number, villa.Name, t.Number)})
	})
	return r, err
}
