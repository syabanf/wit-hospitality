package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/maintenance"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
)

// SeedCashOut is the status of a transaction a seeded expense line points at.
type SeedCashOut struct {
	ID          string `json:"id"`
	Number      string `json:"number"`
	Status      string `json:"status"`
	Amount      int64  `json:"amount"`
	SourceID    string `json:"sourceId"`
	CreatedByID string `json:"createdById"`
	CreatedBy   string `json:"createdBy"`
}

// SeedData is seed/maintenance.json, written by scripts/export-seed.mjs from the mock's buildState.
type SeedData struct {
	BaseDate   string             `json:"baseDate"`
	WorkOrders []domain.WorkOrder `json:"workOrders"`
	Assets     []domain.Asset     `json:"assets"`
	Vendors    []domain.Vendor    `json:"vendors"`
	Plans      []domain.Plan      `json:"plans"`
	CashOuts   []SeedCashOut      `json:"cashOuts"`
	Next       map[string]int     `json:"next"`
}

// ParseSeed decodes the fixture.
func ParseSeed(raw []byte) (SeedData, error) {
	var s SeedData
	err := json.Unmarshal(raw, &s)
	return s, err
}

func shift(s *string, days int) {
	if s != nil && *s != "" {
		*s = clock.AddDays(*s, days)
	}
}

// shiftStamp moves the date part of a YYYY-MM-DDTHH:MM:SS stamp.
func shiftStamp(s string, days int) string {
	if len(s) < 10 {
		return s
	}
	return clock.AddDays(s[:10], days) + s[10:]
}

// Seed replaces the maintenance write model with the fixture, every date moved by shiftDays, and
// appends work_order.saved per job. Villa and unit references arrive from property's seed events.
func Seed(ctx context.Context, d *db.DB, data SeedData, shiftDays int, now time.Time) error {
	repo := Repo{DB: d}
	return d.InTx(ctx, func(ctx context.Context) error {
		q := d.Q(ctx)
		if _, err := q.Exec(ctx, `TRUNCATE maintenance.work_orders, maintenance.assets, maintenance.vendors, maintenance.plans, maintenance.counters,
			maintenance.cash_outs, maintenance.ref_villas, maintenance.ref_units RESTART IDENTITY`); err != nil {
			return err
		}
		for _, w := range data.WorkOrders {
			w.CreatedOn = clock.AddDays(w.CreatedOn, shiftDays)
			for _, s := range []*string{w.ScheduledOn, w.StartedOn, w.FinishedOn, w.VerifiedOn} {
				shift(s, shiftDays)
			}
			for i := range w.History {
				w.History[i].On = clock.AddDays(w.History[i].On, shiftDays)
			}
			for i := range w.Expenses {
				e := &w.Expenses[i]
				e.PaidOn, e.CreatedOn = clock.AddDays(e.PaidOn, shiftDays), clock.AddDays(e.CreatedOn, shiftDays)
				for j := range e.Receipts {
					e.Receipts[j].UploadedAt = shiftStamp(e.Receipts[j].UploadedAt, shiftDays)
				}
			}
			if err := repo.InsertWorkOrder(ctx, &w); err != nil {
				return fmt.Errorf("seed work order %s: %w", w.ID, err)
			}
			state := maintenance.WorkOrder{ID: w.ID, Number: w.Number, VillaID: w.VillaID, UnitID: w.UnitID, AssetID: w.AssetID, PlanID: w.PlanID, VendorID: w.VendorID,
				Category: w.Category, Priority: w.Priority, Title: w.Title, Status: w.Status, BlockID: w.BlockID, CreatedOn: w.CreatedOn, FinishedOn: w.FinishedOn, Cost: w.Cost()}
			if err := outbox.Append(ctx, q, now, outbox.Event{Type: maintenance.EventWorkOrderSaved, AggregateType: "work_order", AggregateID: w.ID, AggregateVersion: 1, Payload: maintenance.WorkOrderSaved{WorkOrder: state}}); err != nil {
				return err
			}
		}
		for _, a := range data.Assets {
			shift(a.PurchasedOn, shiftDays)
			shift(a.WarrantyUntil, shiftDays)
			if err := repo.InsertAsset(ctx, &a); err != nil {
				return fmt.Errorf("seed asset %s: %w", a.ID, err)
			}
		}
		for _, v := range data.Vendors {
			if err := repo.InsertVendor(ctx, &v); err != nil {
				return fmt.Errorf("seed vendor %s: %w", v.ID, err)
			}
		}
		for _, p := range data.Plans {
			p.NextDue = clock.AddDays(p.NextDue, shiftDays)
			shift(p.LastDoneOn, shiftDays)
			if err := repo.InsertPlan(ctx, &p); err != nil {
				return fmt.Errorf("seed plan %s: %w", p.ID, err)
			}
		}
		for _, c := range data.CashOuts {
			if _, err := q.Exec(ctx, `
				INSERT INTO maintenance.cash_outs (id, number, status, origin, source_id, amount, created_by_id, created_by, request)
				VALUES ($1, $2, $3, 'maintenance', $4, $5, $6, $7, '{}')`, c.ID, c.Number, c.Status, c.SourceID, c.Amount, c.CreatedByID, c.CreatedBy); err != nil {
				return fmt.Errorf("seed cash-out %s: %w", c.ID, err)
			}
		}
		for key, next := range data.Next {
			if _, err := q.Exec(ctx, `INSERT INTO maintenance.counters (key, next) VALUES ($1, $2)`, key, next); err != nil {
				return err
			}
		}
		return nil
	})
}
