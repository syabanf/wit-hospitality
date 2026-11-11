package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/guest/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
)

// GroupLead is a booking group's lead guest.
type GroupLead struct {
	ID          string `json:"id"`
	LeadGuestID string `json:"leadGuestId"`
}

// SeedData is seed/guest.json, written by scripts/export-seed.mjs from the mock's buildState.
// Stays and group leads are the reservation facts guest keeps a copy of.
type SeedData struct {
	BaseDate          string                   `json:"baseDate"`
	Guests            []domain.Guest           `json:"guests"`
	Companions        []domain.Companion       `json:"companions"`
	ForeignReports    []domain.ForeignReport   `json:"foreignReports"`
	LostItems         []domain.LostItem        `json:"lostItems"`
	LostFoundSettings domain.LostFoundSettings `json:"lostFoundSettings"`
	Stays             []domain.Stay            `json:"stays"`
	GroupLeads        []GroupLead              `json:"groupLeads"`
	Next              map[string]int64         `json:"next"`
}

// ParseSeed decodes the fixture.
func ParseSeed(raw []byte) (SeedData, error) {
	var s SeedData
	err := json.Unmarshal(raw, &s)
	return s, err
}

var apoaReference = regexp.MustCompile(`^APOA-(\d{8})-`)

type shifter int

func (n shifter) day(d string) string {
	if len(d) < 10 {
		return d
	}
	return clock.AddDays(d[:10], int(n)) + d[10:]
}

func (n shifter) ptr(d *string) *string {
	if d == nil {
		return nil
	}
	v := n.day(*d)
	return &v
}

// reference moves the check-in date inside an APOA receipt number.
func (n shifter) reference(ref string) string {
	m := apoaReference.FindStringSubmatch(ref)
	if m == nil {
		return ref
	}
	iso := m[1][:4] + "-" + m[1][4:6] + "-" + m[1][6:]
	return "APOA-" + strings.ReplaceAll(n.day(iso), "-", "") + ref[len(m[0])-1:]
}

func (n shifter) photos(list []json.RawMessage) []json.RawMessage {
	out := make([]json.RawMessage, 0, len(list))
	for _, raw := range list {
		var file map[string]any
		if json.Unmarshal(raw, &file) != nil {
			out = append(out, raw)
			continue
		}
		if at, ok := file["uploadedAt"].(string); ok {
			file["uploadedAt"] = n.day(at)
		}
		moved, _ := json.Marshal(file)
		out = append(out, moved)
	}
	return out
}

// Seed replaces the guest write model and the stay copies with the fixture, dates moved by
// shiftDays (document expiry and birth dates are absolute and stay), and appends a created event
// per guest and lost item.
func Seed(ctx context.Context, d *db.DB, data SeedData, shiftDays int, now time.Time) error {
	repo := Repo{DB: d}
	n := shifter(shiftDays)
	return d.InTx(ctx, func(ctx context.Context) error {
		q := d.Q(ctx)
		if _, err := q.Exec(ctx, `TRUNCATE guest.guests, guest.companions, guest.foreign_reports, guest.lost_items, guest.settings, guest.counters,
			guest.rm_stays, guest.rm_group_leads, guest.rm_villas, guest.rm_units, guest.rm_locations RESTART IDENTITY`); err != nil {
			return err
		}
		emit := func(eventType, aggregateType, id string, payload any) error {
			return outbox.Append(ctx, q, now, outbox.Event{Type: eventType, AggregateType: aggregateType, AggregateID: id, AggregateVersion: 1, Payload: payload})
		}
		for _, g := range data.Guests {
			g.EntryDate, g.CreatedOn = n.ptr(g.EntryDate), n.day(g.CreatedOn)
			if g.Blacklist != nil {
				g.Blacklist.SetOn = n.day(g.Blacklist.SetOn)
			}
			if g.Tags == nil {
				g.Tags = []string{}
			}
			if err := repo.InsertGuest(ctx, &g); err != nil {
				return fmt.Errorf("seed guest %s: %w", g.ID, err)
			}
			if err := emit(guest.EventGuestCreated, "guest", g.ID, guest.GuestEvent{Guest: g.Summary()}); err != nil {
				return err
			}
		}
		for _, s := range data.Stays {
			if _, err := q.Exec(ctx, `INSERT INTO guest.rm_stays (`+stayColumns+`) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
				s.ID, s.Code, s.GuestID, s.UnitID, s.VillaID, s.Status, n.day(s.CheckIn), n.day(s.CheckOut), n.ptr(s.CheckedInOn), n.ptr(s.CheckedOutOn), s.ArrivalTime, s.Adults); err != nil {
				return fmt.Errorf("seed stay %s: %w", s.ID, err)
			}
		}
		for _, l := range data.GroupLeads {
			if _, err := q.Exec(ctx, `INSERT INTO guest.rm_group_leads (id, lead_guest_id) VALUES ($1, $2)`, l.ID, l.LeadGuestID); err != nil {
				return err
			}
		}
		for _, c := range data.Companions {
			c.EntryDate = n.ptr(c.EntryDate)
			if err := repo.InsertCompanion(ctx, &c); err != nil {
				return fmt.Errorf("seed companion %s: %w", c.ID, err)
			}
		}
		for _, f := range data.ForeignReports {
			f.ReportedAt, f.Reference = n.day(f.ReportedAt), n.reference(f.Reference)
			if err := repo.InsertReport(ctx, f); err != nil {
				return fmt.Errorf("seed report %s: %w", f.ID, err)
			}
		}
		for _, i := range data.LostItems {
			i.FoundOn, i.Photos = n.day(i.FoundOn), n.photos(i.Photos)
			for k := range i.History {
				i.History[k].At = n.day(i.History[k].At)
			}
			if err := repo.InsertLostItem(ctx, &i); err != nil {
				return fmt.Errorf("seed lost item %s: %w", i.ID, err)
			}
			if err := emit(guest.EventLostItemLogged, "lost_item", i.ID, i.State()); err != nil {
				return err
			}
		}
		if _, err := repo.SaveSettings(ctx, data.LostFoundSettings); err != nil {
			return err
		}
		for key, next := range data.Next {
			if _, err := q.Exec(ctx, `INSERT INTO guest.counters (key, next) VALUES ($1, $2)`, key, next); err != nil {
				return err
			}
		}
		return nil
	})
}
