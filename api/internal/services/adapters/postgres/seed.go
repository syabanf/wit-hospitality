package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/services"
	"github.com/syabanf/wit-hospitality/api/internal/services/domain"
)

// SeedData is seed/services.json, written by scripts/export-seed.mjs from the mock's buildState.
type SeedData struct {
	BaseDate string                  `json:"baseDate"`
	Partners []domain.ServicePartner `json:"partners"`
	Menu     []domain.MenuItem       `json:"menu"`
	Orders   []domain.ServiceOrder   `json:"orders"`
	Requests []domain.ServiceRequest `json:"requests"`
	// PartnerBills is where finance stood on each seeded partner bill.
	PartnerBills []struct {
		TransactionID string `json:"transactionId"`
		OrderID       string `json:"orderId"`
		PartnerID     string `json:"partnerId"`
		Status        string `json:"status"`
	} `json:"partnerBills"`
	// Next continues the mock's seq() for orders and requests.
	Next map[string]int64 `json:"next"`
}

// ParseSeed decodes the fixture.
func ParseSeed(raw []byte) (SeedData, error) {
	var s SeedData
	err := json.Unmarshal(raw, &s)
	return s, err
}

func shift(d string, n int) string {
	if d == "" {
		return d
	}
	return clock.AddDays(d, n)
}

func shiftPtr(d *string, n int) *string {
	if d == nil {
		return nil
	}
	s := shift(*d, n)
	return &s
}

// shiftStamp moves the date part of a local date-time.
func shiftStamp(s string, n int) string {
	if len(s) < 10 {
		return s
	}
	return shift(s[:10], n) + s[10:]
}

// Seed replaces the services write model with the fixture, dates shifted by shiftDays. It reads
// villas and units from the catalog copy, so property's seed events must be projected first. It
// appends a saved event per partner, menu item and request, so billing's invoice sees the charged
// requests; seeded orders publish none, because billing, inventory and finance seed their own
// copies of that history from the export.
func Seed(ctx context.Context, d *db.DB, data SeedData, shiftDays int, now time.Time) error {
	repo := Repo{DB: d}
	cat := CatalogStore{DB: d}
	return d.InTx(ctx, func(ctx context.Context) error {
		q := d.Q(ctx)
		if _, err := q.Exec(ctx, `TRUNCATE services.counters, services.partners, services.menu_items, services.orders, services.requests, services.partner_bills, services.setup_requests RESTART IDENTITY`); err != nil {
			return err
		}
		emit := func(eventType, aggregateType, id string, payload any) error {
			return outbox.Append(ctx, q, now, outbox.Event{Type: eventType, AggregateType: aggregateType, AggregateID: id, AggregateVersion: 1, Payload: payload})
		}
		for _, p := range data.Partners {
			if err := repo.InsertPartner(ctx, &p); err != nil {
				return fmt.Errorf("seed partner %s: %w", p.ID, err)
			}
			if err := emit(services.EventPartnerSaved, "partner", p.ID, services.PartnerSaved{Partner: mustJSON(p)}); err != nil {
				return err
			}
		}
		for _, m := range data.Menu {
			if len(m.Photo) == 0 {
				m.Photo = json.RawMessage("null")
			}
			if err := repo.InsertMenuItem(ctx, &m); err != nil {
				return fmt.Errorf("seed menu item %s: %w", m.ID, err)
			}
			v, _, err := cat.Villa(ctx, m.VillaID)
			if err != nil {
				return err
			}
			if err := emit(services.EventMenuItemSaved, "menu_item", m.ID, services.MenuItemSaved{Item: mustJSON(m), LocationID: v.LocationID}); err != nil {
				return err
			}
		}
		for _, o := range data.Orders {
			o.RequestedOn, o.CreatedOn, o.DeliveredOn = shift(o.RequestedOn, shiftDays), shift(o.CreatedOn, shiftDays), shiftPtr(o.DeliveredOn, shiftDays)
			for i := range o.History {
				o.History[i].At = shiftStamp(o.History[i].At, shiftDays)
			}
			if err := repo.InsertOrder(ctx, &o); err != nil {
				return fmt.Errorf("seed order %s: %w", o.ID, err)
			}
		}
		// Version 0: any answer finance sends later replaces the seeded status.
		for _, b := range data.PartnerBills {
			if err := repo.SaveBill(ctx, b.OrderID, domain.CostBill{TransactionID: b.TransactionID, PartnerID: b.PartnerID, Status: b.Status}); err != nil {
				return fmt.Errorf("seed partner bill %s: %w", b.TransactionID, err)
			}
		}
		for _, r := range data.Requests {
			r.RequestedOn, r.DoneOn = shift(r.RequestedOn, shiftDays), shiftPtr(r.DoneOn, shiftDays)
			pl, _, err := cat.Place(ctx, r.UnitID)
			if err != nil {
				return err
			}
			if err := repo.InsertRequest(ctx, &r, pl.Villa.ID); err != nil {
				return fmt.Errorf("seed request %s: %w", r.ID, err)
			}
			if err := emit(services.EventRequestSaved, "service_request", r.ID, services.RequestSaved{Request: mustJSON(r), VillaID: pl.Villa.ID, LocationID: pl.Villa.LocationID}); err != nil {
				return err
			}
		}
		for _, key := range []string{"order", "request"} {
			n := max(data.Next[key], 1)
			if _, err := q.Exec(ctx, `INSERT INTO services.counters (key, n) VALUES ($1, $2)`, key, n); err != nil {
				return err
			}
		}
		return nil
	})
}
