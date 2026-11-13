package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

// SeedData is seed/reservation.json, written by scripts/export-seed.mjs from the mock's buildState.
type SeedData struct {
	BaseDate     string                  `json:"baseDate"`
	Bookings     []domain.Booking        `json:"bookings"`
	Groups       []domain.BookingGroup   `json:"groups"`
	Restrictions []domain.Restriction    `json:"restrictions"`
	Overbooking  []domain.OverbookPolicy `json:"overbooking"`
	Walks        []domain.Walk           `json:"walks"`
	PreCheckIns  []domain.PreCheckIn     `json:"preCheckIns"`
}

// ParseSeed decodes the fixture.
func ParseSeed(raw []byte) (SeedData, error) {
	var s SeedData
	err := json.Unmarshal(raw, &s)
	return s, err
}

// firstBooking is the mock's next booking number after its seed (state.ts next.booking).
const firstBooking = 3001

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

func shiftBooking(b *domain.Booking, n int) {
	b.CheckIn, b.CheckOut, b.CreatedOn = shift(b.CheckIn, n), shift(b.CheckOut, n), shift(b.CreatedOn, n)
	b.CheckedInOn, b.CheckedOutOn = shiftPtr(b.CheckedInOn, n), shiftPtr(b.CheckedOutOn, n)
	for i := range b.Movements {
		b.Movements[i].On = shift(b.Movements[i].On, n)
	}
	if b.PriceSetBy != nil {
		b.PriceSetBy.On = shift(b.PriceSetBy.On, n)
	}
	if b.RestrictionNote != nil {
		b.RestrictionNote.On = shift(b.RestrictionNote.On, n)
	}
	if b.NightsPosted != nil {
		for i, d := range *b.NightsPosted {
			(*b.NightsPosted)[i] = shift(d, n)
		}
	}
}

// codeNumber reads the number at the end of a code such as BK-2104.
func codeNumber(code string) int64 {
	n, _ := strconv.ParseInt(code[strings.LastIndex(code, "-")+1:], 10, 64)
	return n
}

// Seed replaces the reservation write model with the fixture, shifted by shiftDays, and appends a
// saved event per record so the projector builds the read models as it does after a command. It
// reads villas from the catalog copy, so property's seed events must be projected first.
func Seed(ctx context.Context, d *db.DB, data SeedData, shiftDays int, now time.Time) error {
	repo := Repo{DB: d}
	return d.InTx(ctx, func(ctx context.Context) error {
		q := d.Q(ctx)
		if _, err := q.Exec(ctx, `TRUNCATE reservation.counters, reservation.bookings, reservation.booking_groups, reservation.restrictions,
			reservation.overbooking, reservation.walks, reservation.pre_checkins, reservation.rm_bookings, reservation.rm_booking_groups,
			reservation.rm_restrictions, reservation.rm_overbooking, reservation.rm_walks, reservation.rm_pre_checkins RESTART IDENTITY`); err != nil {
			return err
		}
		cat, err := CatalogStore{DB: d}.Catalog(ctx)
		if err != nil {
			return err
		}
		villaOfUnit := func(unitID string) []domain.Villa {
			u, _ := cat.Unit(unitID)
			v, _ := cat.Villa(u.VillaID)
			return []domain.Villa{v}
		}
		villaOfGroup := func(groupID string) []domain.Villa {
			g, _ := cat.Group(groupID)
			v, _ := cat.Villa(g.VillaID)
			return []domain.Villa{v}
		}
		emit := func(eventType, aggregateType, id string, villas []domain.Villa, record any) error {
			r := reservation.Record{ID: id, VillaIDs: []string{}, LocationIDs: []string{}}
			for _, v := range villas {
				r.VillaIDs, r.LocationIDs = append(r.VillaIDs, v.ID), append(r.LocationIDs, v.LocationID)
			}
			raw, err := json.Marshal(record)
			if err != nil {
				return err
			}
			r.Data = raw
			return outbox.Append(ctx, q, now, outbox.Event{Type: eventType, AggregateType: aggregateType, AggregateID: id, AggregateVersion: 1, Payload: r})
		}
		next := map[string]int64{"booking": firstBooking, "bookingGroup": 1, "walk": 1, "restriction": 1}
		for _, b := range data.Bookings {
			shiftBooking(&b, shiftDays)
			u, _ := cat.Unit(b.UnitID)
			b.FillStay(cat.UnitKind(u), nil)
			if err := repo.InsertBooking(ctx, &b); err != nil {
				return fmt.Errorf("seed booking %s: %w", b.ID, err)
			}
			next["booking"] = max(next["booking"], codeNumber(b.Code)+1)
			if err := emit(reservation.EventBookingSaved, "booking", b.ID, villaOfUnit(b.UnitID), b); err != nil {
				return err
			}
		}
		for _, g := range data.Groups {
			g.CreatedAt = shiftStamp(g.CreatedAt, shiftDays)
			if err := repo.InsertGroup(ctx, &g); err != nil {
				return fmt.Errorf("seed group %s: %w", g.ID, err)
			}
			next["bookingGroup"] = max(next["bookingGroup"], codeNumber(g.Code)-1000+1)
			var villas []domain.Villa
			for _, id := range g.VillaIDs {
				v, _ := cat.Villa(id)
				villas = append(villas, v)
			}
			if err := emit(reservation.EventGroupSaved, "booking_group", g.ID, villas, g); err != nil {
				return err
			}
		}
		for _, r := range data.Restrictions {
			if !r.Yearly {
				r.From, r.To = shift(r.From, shiftDays), shift(r.To, shiftDays)
			}
			r.CreatedOn = shift(r.CreatedOn, shiftDays)
			if err := repo.InsertRestriction(ctx, &r); err != nil {
				return fmt.Errorf("seed restriction %s: %w", r.ID, err)
			}
			if err := emit(reservation.EventRestrictionSaved, "restriction", r.ID, villaOfGroup(r.GroupID), r); err != nil {
				return err
			}
		}
		for _, p := range data.Overbooking {
			if _, err := repo.SetPolicy(ctx, p); err != nil {
				return fmt.Errorf("seed overbooking %s: %w", p.GroupID, err)
			}
			if err := emit(reservation.EventOverbookingSet, "overbooking", p.GroupID, villaOfGroup(p.GroupID), p); err != nil {
				return err
			}
		}
		for _, w := range data.Walks {
			w.Date = shift(w.Date, shiftDays)
			if err := repo.InsertWalk(ctx, w); err != nil {
				return fmt.Errorf("seed walk %s: %w", w.ID, err)
			}
			next["walk"] = max(next["walk"], codeNumber(w.Number)-100+1)
			if err := emit(reservation.EventWalkRecorded, "walk", w.ID, villaOfUnit(w.FromUnitID), w); err != nil {
				return err
			}
		}
		units := map[string]string{}
		for _, b := range data.Bookings {
			units[b.ID] = b.UnitID
		}
		for _, p := range data.PreCheckIns {
			p.SubmittedAt = shiftStamp(p.SubmittedAt, shiftDays)
			if p.VerifiedAt != nil {
				at := shiftStamp(*p.VerifiedAt, shiftDays)
				p.VerifiedAt = &at
			}
			for i := range p.Travellers {
				p.Travellers[i].EntryDate = shift(p.Travellers[i].EntryDate, shiftDays)
			}
			p.Version = 0
			if err := repo.SavePreCheckIn(ctx, &p); err != nil {
				return fmt.Errorf("seed pre-check-in %s: %w", p.BookingID, err)
			}
			if err := emit(reservation.EventPreCheckInSaved, "pre_checkin", p.BookingID, villaOfUnit(units[p.BookingID]), p); err != nil {
				return err
			}
		}
		for key, n := range next {
			if _, err := q.Exec(ctx, `INSERT INTO reservation.counters (key, n) VALUES ($1, $2)`, key, n); err != nil {
				return err
			}
		}
		return nil
	})
}
