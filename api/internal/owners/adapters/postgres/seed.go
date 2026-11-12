package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/owners/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
)

// SeedPayout is the payout cash entry of a seeded statement, as the mock's finance holds it.
type SeedPayout struct {
	TransactionID string `json:"transactionId"`
	Number        string `json:"number"`
	Status        string `json:"status"`
}

// SeedStatement is a seeded statement with its payout.
type SeedStatement struct {
	domain.Statement
	Payout *SeedPayout `json:"payout"`
}

// SeedData is seed/owners.json, written by scripts/export-seed.mjs from the mock's buildState.
type SeedData struct {
	BaseDate   string               `json:"baseDate"`
	Owners     []domain.VillaOwner  `json:"owners"`
	Contracts  []domain.Contract    `json:"contracts"`
	Statements []SeedStatement      `json:"statements"`
	Stays      []domain.StayRequest `json:"stays"`
	Next       map[string]int64     `json:"next"`
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

// shiftDocument moves the upload stamp of a contract's document.
func shiftDocument(raw json.RawMessage, n int) json.RawMessage {
	var doc map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &doc) != nil || doc == nil {
		return raw
	}
	if at, ok := doc["uploadedAt"].(string); ok && len(at) >= 10 {
		doc["uploadedAt"] = shift(at[:10], n) + at[10:]
	}
	out, _ := json.Marshal(doc)
	return out
}

// Seed replaces the owners write model with the fixture and empties the copies, which the seed
// events of the other contexts rebuild. Dates move by shiftDays; statement months
// move by whole months from the base date's month to today's, so the two seeded statements stay the
// last two complete months. The statement figures keep the amounts the TypeScript seed worked out.
func Seed(ctx context.Context, d *db.DB, data SeedData, shiftDays int, today string) error {
	store := Store{DB: d}
	months := monthsBetween(data.BaseDate[:7], today[:7])
	return d.InTx(ctx, func(ctx context.Context) error {
		q := d.Q(ctx)
		if _, err := q.Exec(ctx, `TRUNCATE owners.counters, owners.villa_owners, owners.contracts, owners.statements, owners.stay_requests,
			owners.cat_locations, owners.cat_villas, owners.cat_units, owners.cat_blocks, owners.cat_accounts, owners.rm_stays, owners.rm_groups RESTART IDENTITY`); err != nil {
			return err
		}
		for _, o := range data.Owners {
			if err := store.InsertOwner(ctx, &o); err != nil {
				return fmt.Errorf("seed owner %s: %w", o.ID, err)
			}
		}
		for _, c := range data.Contracts {
			c.Start, c.End, c.CreatedOn = shift(c.Start, shiftDays), shift(c.End, shiftDays), shift(c.CreatedOn, shiftDays)
			c.Document = shiftDocument(c.Document, shiftDays)
			if err := store.InsertContract(ctx, &c); err != nil {
				return fmt.Errorf("seed contract %s: %w", c.ID, err)
			}
		}
		for _, s := range data.Statements {
			st := s.Statement
			month := domain.AddMonths(st.Month+"-01", months)[:7]
			st.Number = strings.Replace(st.Number, st.Month, month, 1)
			if st.BroughtFrom != nil {
				from := domain.AddMonths(*st.BroughtFrom+"-01", months)[:7]
				st.BroughtFrom = &from
			}
			st.Month = month
			st.ClosedOn, st.ApprovedOn = shift(st.ClosedOn, shiftDays), shiftPtr(st.ApprovedOn, shiftDays)
			for i := range st.Stays {
				st.Stays[i].CheckIn, st.Stays[i].CheckOut = shift(st.Stays[i].CheckIn, shiftDays), shift(st.Stays[i].CheckOut, shiftDays)
			}
			for i := range st.Entries {
				st.Entries[i].Date = shift(st.Entries[i].Date, shiftDays)
			}
			if p := s.Payout; p != nil {
				st.Payout = &domain.Payout{Ref: "seed-" + st.ID, TransactionID: p.TransactionID, Number: p.Number, Status: p.Status}
			}
			if err := store.InsertStatement(ctx, &st); err != nil {
				return fmt.Errorf("seed statement %s: %w", st.ID, err)
			}
		}
		for _, r := range data.Stays {
			r.CheckIn, r.CheckOut, r.RequestedOn = shift(r.CheckIn, shiftDays), shift(r.CheckOut, shiftDays), shift(r.RequestedOn, shiftDays)
			r.DecidedOn = shiftPtr(r.DecidedOn, shiftDays)
			if err := store.InsertStay(ctx, &r); err != nil {
				return fmt.Errorf("seed owner stay %s: %w", r.ID, err)
			}
		}
		for key, n := range data.Next {
			if _, err := q.Exec(ctx, `INSERT INTO owners.counters (key, n) VALUES ($1, $2)`, key, n); err != nil {
				return err
			}
		}
		return nil
	})
}

// monthsBetween counts calendar months from "YYYY-MM" a to b.
func monthsBetween(a, b string) int {
	var ay, am, by, bm int
	_, _ = fmt.Sscanf(a, "%d-%d", &ay, &am)
	_, _ = fmt.Sscanf(b, "%d-%d", &by, &bm)
	return (by-ay)*12 + bm - am
}
