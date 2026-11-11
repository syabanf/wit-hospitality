package postgres

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/inventory"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
)

// CashOuts is the in-process command.CashOutRequests: until finance runs, a purchase request is a
// row in inventory.cash_outs with status submitted plus an event in the outbox carrying the full
// amount. Finance answers with finance.cash_out.decided.v1, which Projections applies.
type CashOuts struct {
	DB    *db.DB
	Audit audit.Recorder
	Clock clock.Clock
}

var _ command.CashOutRequests = CashOuts{}

func (c CashOuts) emit(ctx context.Context, eventType string, r inventory.CashOut, version int64) error {
	if r.Attachments == nil {
		r.Attachments = []inventory.Attachment{}
	}
	return outbox.Append(ctx, c.DB.Q(ctx), c.Clock.Now(), outbox.Event{Type: eventType, AggregateType: "cash_out", AggregateID: r.TransactionID, AggregateVersion: version, Payload: r})
}

// Submit records the request as submitted and asks finance for it.
func (c CashOuts) Submit(ctx context.Context, p auth.Principal, r inventory.CashOut) (command.CashOutStatus, error) {
	n, err := Repo{DB: c.DB}.Next(ctx, "transaction")
	if err != nil {
		return command.CashOutStatus{}, err
	}
	r.TransactionID, r.Number = fmt.Sprintf("tx-s%d", n), fmt.Sprintf("TX-S%d", 2400+n)
	r.CreatedByID, r.CreatedBy = p.UserID, p.Name
	if _, err := c.DB.Q(ctx).Exec(ctx, `
		INSERT INTO inventory.cash_outs (id, number, status, origin, source_id, amount, created_by_id, created_by, request)
		VALUES ($1, $2, 'submitted', $3, $4, $5, $6, $7, $8)`, r.TransactionID, r.Number, r.Origin, r.SourceID, r.Amount, r.CreatedByID, r.CreatedBy, r); err != nil {
		return command.CashOutStatus{}, err
	}
	if err := c.emit(ctx, inventory.EventPurchaseSubmitted, r, 1); err != nil {
		return command.CashOutStatus{}, err
	}
	err = c.Audit.Record(ctx, audit.Actor{ID: p.UserID, Name: p.Name, Role: string(p.Role)}, audit.Line{
		Action: audit.Create, Entity: "transaction", EntityID: r.Number, Summary: fmt.Sprintf("Submitted %s, %s", r.Number, r.Description),
		After: map[string]any{"amount": r.Amount, "kind": r.Kind},
	})
	return command.CashOutStatus{ID: r.TransactionID, Number: r.Number, Status: "submitted", CreatedByID: p.UserID, CreatedBy: p.Name}, err
}

// Status reads the local status of a cash-out.
func (c CashOuts) Status(ctx context.Context, id string) (command.CashOutStatus, error) {
	var s command.CashOutStatus
	err := c.DB.Q(ctx).QueryRow(ctx, `SELECT id, number, status, created_by_id, created_by FROM inventory.cash_outs WHERE id = $1 FOR UPDATE`, id).
		Scan(&s.ID, &s.Number, &s.Status, &s.CreatedByID, &s.CreatedBy)
	return s, notFound(err, "transaction", id)
}

func (c CashOuts) rejected(ctx context.Context, id string) (command.CashOutStatus, error) {
	s, err := c.Status(ctx, id)
	if err != nil {
		return s, err
	}
	if s.Status != "rejected" {
		return s, errs.Newf("TRANSACTION_INVALID_STATE", "%s is %s; only a rejected cash-out can be corrected.", s.Number, s.Status)
	}
	return s, nil
}

// Correct resubmits a rejected cash-out with new fields, as the mock's resubmit does.
func (c CashOuts) Correct(ctx context.Context, p auth.Principal, id string, r inventory.CashOut, note string) (command.CashOutStatus, error) {
	s, err := c.rejected(ctx, id)
	if err != nil {
		return s, err
	}
	r.TransactionID, r.Number, r.CreatedByID, r.CreatedBy, r.Note = s.ID, s.Number, s.CreatedByID, s.CreatedBy, note
	var version int64
	if err := c.DB.Q(ctx).QueryRow(ctx, `
		UPDATE inventory.cash_outs SET status = 'submitted', amount = $2, request = $3, version = version + 1 WHERE id = $1 RETURNING version`,
		id, r.Amount, r).Scan(&version); err != nil {
		return s, err
	}
	s.Status = "submitted"
	return s, c.emit(ctx, inventory.EventPurchaseResubmitted, r, version)
}

// Cancel closes a rejected cash-out for good; its status stays rejected.
func (c CashOuts) Cancel(ctx context.Context, p auth.Principal, id, note string) error {
	s, err := c.rejected(ctx, id)
	if err != nil {
		return err
	}
	var version int64
	if err := c.DB.Q(ctx).QueryRow(ctx, `UPDATE inventory.cash_outs SET version = version + 1 WHERE id = $1 RETURNING version`, id).Scan(&version); err != nil {
		return err
	}
	return c.emit(ctx, inventory.EventPurchaseCancelled, inventory.CashOut{TransactionID: s.ID, Number: s.Number, Origin: "stock", CreatedByID: s.CreatedByID, CreatedBy: s.CreatedBy, Note: note}, version)
}
