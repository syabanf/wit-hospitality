package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/channel"
	"github.com/syabanf/wit-hospitality/api/internal/channel/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
)

// SeedData is seed/channel.json, written by scripts/export-seed.mjs from the mock's buildState.
type SeedData struct {
	BaseDate  string           `json:"baseDate"`
	Accounts  []domain.Account `json:"accounts"`
	Listings  []domain.Listing `json:"listings"`
	Enquiries []domain.Enquiry `json:"enquiries"`
}

// ParseSeed decodes the fixture.
func ParseSeed(raw []byte) (SeedData, error) {
	var s SeedData
	err := json.Unmarshal(raw, &s)
	return s, err
}

// WeekAligned rounds a shift to whole weeks. The seed prices Friday and Saturday nights higher,
// so date prices move by whole weeks to stay on the same weekdays; the high season edges move by
// up to three days.
func WeekAligned(days int) int { return int(math.Round(float64(days)/7)) * 7 }

func shift(date string, days int) string {
	if date == "" {
		return ""
	}
	return clock.AddDays(date, days)
}

// Seed replaces the channel data with the fixture and appends a created event per record. The
// projected catalog tables are emptied too: property's seed events rebuild them. Enquiry dates
// move by shiftDays, listing date prices by the week-aligned shift.
func Seed(ctx context.Context, d *db.DB, data SeedData, shiftDays int, now time.Time) error {
	repo := Repo{DB: d}
	return d.InTx(ctx, func(ctx context.Context) error {
		q := d.Q(ctx)
		if _, err := q.Exec(ctx, `TRUNCATE channel.enquiries, channel.listings, channel.airbnb_accounts,
			channel.rm_unit_blocks, channel.rm_rate_plans, channel.rm_units, channel.rm_unit_groups, channel.rm_villas, channel.rm_locations RESTART IDENTITY CASCADE`); err != nil {
			return err
		}
		emit := func(eventType, aggregateType, id string, payload any) error {
			return outbox.Append(ctx, q, now, outbox.Event{Type: eventType, AggregateType: aggregateType, AggregateID: id, AggregateVersion: 1, Payload: payload})
		}
		for _, a := range data.Accounts {
			if err := repo.InsertAccount(ctx, &a); err != nil {
				return fmt.Errorf("seed account %s: %w", a.ID, err)
			}
			if err := emit(channel.EventAccountCreated, "airbnb_account", a.ID, channel.AccountEvent{Account: channel.Account{ID: a.ID, Name: a.Name, Email: a.Email, Status: a.Status, Slot: a.Slot}}); err != nil {
				return err
			}
		}
		weeks := WeekAligned(shiftDays)
		for _, l := range data.Listings {
			l.DateRates = domain.ShiftDateRates(l.DateRates, weeks)
			if err := repo.InsertListing(ctx, &l); err != nil {
				return fmt.Errorf("seed listing %s: %w", l.ID, err)
			}
			// The unit's villa is not known here; the event carries the listing alone.
			state := channel.Listing{ID: l.ID, AccountID: l.AccountID, UnitID: l.UnitID, Title: l.Title, AirbnbID: l.AirbnbID, Status: l.Status, DateRates: l.DateRates}
			if err := emit(channel.EventListingCreated, "listing", l.ID, channel.ListingEvent{Listing: state}); err != nil {
				return err
			}
		}
		var last int64
		for i, e := range data.Enquiries {
			seq, err := strconv.ParseInt(strings.TrimPrefix(e.Number, "ENQ-"), 10, 64)
			if err != nil {
				return fmt.Errorf("seed enquiry %s: number %q", e.ID, e.Number)
			}
			e.Seq = seq
			last = max(last, seq)
			e.CheckIn, e.CheckOut, e.CreatedOn = shift(e.CheckIn, shiftDays), shift(e.CheckOut, shiftDays), shift(e.CreatedOn, shiftDays)
			if len(e.CreatedAt) >= 10 {
				e.CreatedAt = shift(e.CreatedAt[:10], shiftDays) + e.CreatedAt[10:]
			}
			// The fixture lists the newest first; keep that order under any enquiry filed later.
			if err := repo.insertEnquiry(ctx, &e, int64(len(data.Enquiries)-i)); err != nil {
				return fmt.Errorf("seed enquiry %s: %w", e.ID, err)
			}
			if err := emit(channel.EventEnquiryReceived, "enquiry", e.ID, channel.EnquiryEvent{Enquiry: channel.Enquiry{ID: e.ID, Number: e.Number, Topic: e.Topic, VillaID: e.VillaID, GroupID: e.GroupID, CheckIn: e.CheckIn, CheckOut: e.CheckOut, Guests: e.Guests, Status: e.Status, BookingID: e.BookingID, CreatedOn: e.CreatedOn}}); err != nil {
				return err
			}
		}
		if last > 0 {
			if _, err := q.Exec(ctx, `SELECT setval('channel.enquiry_seq', $1)`, last); err != nil {
				return err
			}
		} else if _, err := q.Exec(ctx, `ALTER SEQUENCE channel.enquiry_seq RESTART`); err != nil {
			return err
		}
		return nil
	})
}
