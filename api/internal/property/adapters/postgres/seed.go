package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/property"
	"github.com/syabanf/wit-hospitality/api/internal/property/domain"
)

// SeedData is seed/property.json, written by scripts/export-seed.mjs from the mock's buildState.
type SeedData struct {
	BaseDate  string             `json:"baseDate"`
	Locations []domain.Location  `json:"locations"`
	Villas    []domain.Villa     `json:"villas"`
	Groups    []domain.UnitGroup `json:"groups"`
	Units     []domain.Unit      `json:"units"`
	RatePlans []domain.RatePlan  `json:"ratePlans"`
	Blocks    []domain.UnitBlock `json:"blocks"`
	// StatusHistory is newest first, as the mock keeps it.
	StatusHistory []domain.StatusChange `json:"statusHistory"`
}

// ParseSeed decodes the fixture.
func ParseSeed(raw []byte) (SeedData, error) {
	var s SeedData
	err := json.Unmarshal(raw, &s)
	return s, err
}

// Seed replaces the property write model with the fixture and appends a created event per
// record, so the projector builds the read models the same way it does after a command. Block
// dates and the unit status history move by shiftDays; the history appends no event, as a status
// change only keeps it in property.
func Seed(ctx context.Context, d *db.DB, data SeedData, shiftDays int, now time.Time) error {
	repo := Repo{DB: d}
	return d.InTx(ctx, func(ctx context.Context) error {
		q := d.Q(ctx)
		if _, err := q.Exec(ctx, `TRUNCATE property.unit_blocks, property.rate_plans, property.units, property.unit_groups, property.villas, property.locations,
			property.rm_unit_blocks, property.rm_rate_plans, property.rm_units, property.rm_unit_groups, property.rm_villas, property.rm_locations RESTART IDENTITY CASCADE`); err != nil {
			return err
		}
		emit := func(eventType, aggregateType, id string, payload any) error {
			return outbox.Append(ctx, q, now, outbox.Event{Type: eventType, AggregateType: aggregateType, AggregateID: id, AggregateVersion: 1, Payload: payload})
		}
		villaLocation := map[string]string{}
		groupVilla := map[string]string{}
		unitVilla := map[string]string{}
		for _, l := range data.Locations {
			if err := repo.InsertLocation(ctx, &l); err != nil {
				return fmt.Errorf("seed location %s: %w", l.ID, err)
			}
			if err := emit(property.EventLocationCreated, "location", l.ID, property.LocationEvent{Location: property.Location{ID: l.ID, Name: l.Name, Area: l.Area}}); err != nil {
				return err
			}
		}
		for _, v := range data.Villas {
			v.FillDefaults()
			if err := repo.InsertVilla(ctx, &v); err != nil {
				return fmt.Errorf("seed villa %s: %w", v.ID, err)
			}
			villaLocation[v.ID] = v.LocationID
			if err := emit(property.EventVillaCreated, "villa", v.ID, property.VillaEvent{Villa: domain.VillaState(v)}); err != nil {
				return err
			}
		}
		for _, g := range data.Groups {
			g.FillDefaults()
			if err := repo.InsertGroup(ctx, &g); err != nil {
				return fmt.Errorf("seed group %s: %w", g.ID, err)
			}
			groupVilla[g.ID] = g.VillaID
			if err := emit(property.EventGroupCreated, "unit_group", g.ID, property.GroupEvent{Group: domain.GroupState(g), LocationID: villaLocation[g.VillaID]}); err != nil {
				return err
			}
		}
		for _, u := range data.Units {
			u.FillDefaults()
			if err := repo.InsertUnit(ctx, &u); err != nil {
				return fmt.Errorf("seed unit %s: %w", u.ID, err)
			}
			unitVilla[u.ID] = u.VillaID
			if err := emit(property.EventUnitCreated, "unit", u.ID, property.UnitEvent{Unit: domain.UnitState(u), LocationID: villaLocation[u.VillaID]}); err != nil {

				return err
			}
		}
		for _, p := range data.RatePlans {
			if err := repo.SaveRatePlan(ctx, &p); err != nil {
				return fmt.Errorf("seed rate plan %s: %w", p.GroupID, err)
			}
			state := property.RatePlan{GroupID: p.GroupID, WeekdayRate: p.WeekdayRate, WeekendRate: p.WeekendRate, Seasons: []property.Season{}}
			for _, s := range p.Seasons {
				state.Seasons = append(state.Seasons, property.Season{Name: s.Name, From: s.From, To: s.To, Kind: s.Kind, Value: s.Value})
			}
			villa := groupVilla[p.GroupID]
			if err := emit(property.EventRatePlanSaved, "rate_plan", p.GroupID, property.RatePlanSaved{Plan: state, VillaID: villa, LocationID: villaLocation[villa]}); err != nil {
				return err
			}
		}
		for _, b := range data.Blocks {
			b.From, b.To = clock.AddDays(b.From, shiftDays), clock.AddDays(b.To, shiftDays)
			if err := repo.InsertBlock(ctx, b); err != nil {
				return fmt.Errorf("seed block %s: %w", b.ID, err)
			}
			villa := unitVilla[b.UnitID]
			state := property.Block{ID: b.ID, UnitID: b.UnitID, From: b.From, To: b.To, Reason: b.Reason, Note: b.Note}
			if err := emit(property.EventBlockAdded, "unit_block", b.ID, property.BlockAdded{Block: state, VillaID: villa, LocationID: villaLocation[villa]}); err != nil {
				return err
			}
		}
		for i := len(data.StatusHistory) - 1; i >= 0; i-- {
			c := data.StatusHistory[i]
			if len(c.At) < 10 {
				return fmt.Errorf("seed status change %s: at %q is not a date-time", c.ID, c.At)
			}
			c.At = clock.AddDays(c.At[:10], shiftDays) + c.At[10:]
			if c.Until != nil {
				until := clock.AddDays(*c.Until, shiftDays)
				c.Until = &until
			}
			villa := unitVilla[c.UnitID]
			if err := repo.AddStatusChange(ctx, c, villa, villaLocation[villa], c.At[:10]); err != nil {
				return fmt.Errorf("seed status change %s: %w", c.ID, err)
			}
		}
		return nil
	})
}
