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
}

// ParseSeed decodes the fixture.
func ParseSeed(raw []byte) (SeedData, error) {
	var s SeedData
	err := json.Unmarshal(raw, &s)
	return s, err
}

// Seed replaces the property write model with the fixture and appends a created event per
// record, so the projector builds the read models the same way it does after a command. Block
// dates move by shiftDays.
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
			if err := repo.InsertVilla(ctx, &v); err != nil {
				return fmt.Errorf("seed villa %s: %w", v.ID, err)
			}
			villaLocation[v.ID] = v.LocationID
			if err := emit(property.EventVillaCreated, "villa", v.ID, property.VillaEvent{Villa: property.Villa{ID: v.ID, LocationID: v.LocationID, Code: v.Code, Name: v.Name, Description: v.Description, Facilities: v.Facilities}}); err != nil {
				return err
			}
		}
		for _, g := range data.Groups {
			if err := repo.InsertGroup(ctx, &g); err != nil {
				return fmt.Errorf("seed group %s: %w", g.ID, err)
			}
			groupVilla[g.ID] = g.VillaID
			if err := emit(property.EventGroupCreated, "unit_group", g.ID, property.GroupEvent{Group: property.Group{ID: g.ID, VillaID: g.VillaID, Name: g.Name, Interchangeable: g.Interchangeable, OperatorAssigns: g.OperatorAssigns}, LocationID: villaLocation[g.VillaID]}); err != nil {
				return err
			}
		}
		for _, u := range data.Units {
			if err := repo.InsertUnit(ctx, &u); err != nil {
				return fmt.Errorf("seed unit %s: %w", u.ID, err)
			}
			unitVilla[u.ID] = u.VillaID
			state := property.Unit{ID: u.ID, VillaID: u.VillaID, GroupID: u.GroupID, Code: u.Code, Name: u.Name, Bedrooms: u.Bedrooms, NightlyRate: u.NightlyRate, Status: u.Status, Amenities: u.Amenities}
			if err := emit(property.EventUnitCreated, "unit", u.ID, property.UnitEvent{Unit: state, LocationID: villaLocation[u.VillaID]}); err != nil {
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
		return nil
	})
}
