package postgres

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/people"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/property"
)

// ConsumerCatalog keeps finance's copy of the villas and locations from property's events.
const ConsumerCatalog = "finance.catalog"

// Catalog projects property's villas and locations; an older event never rolls a row back.
type Catalog struct{ DB *db.DB }

// Register adds the handlers to p.
func (c Catalog) Register(p *projector.Projector) {
	p.On(ConsumerCatalog, property.EventLocationCreated, c.location)
	p.On(ConsumerCatalog, property.EventLocationUpdated, c.location)
	p.On(ConsumerCatalog, property.EventVillaCreated, c.villa)
	p.On(ConsumerCatalog, property.EventVillaUpdated, c.villa)
	p.On(ConsumerPeople, people.EventAssignmentSaved, c.assignment)
}

// ConsumerPeople keeps the roster from people's shift assignments.
const ConsumerPeople = "finance.people"

func (c Catalog) assignment(ctx context.Context, m bus.Message) error {
	var e people.AssignmentSaved
	if err := json.Unmarshal(m.Payload, &e); err != nil {
		return err
	}
	a := e.Assignment
	_, err := c.DB.Q(ctx).Exec(ctx, `
		INSERT INTO finance.roster (id, employee_id, date, on_shift, version) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (id) DO UPDATE SET employee_id = EXCLUDED.employee_id, date = EXCLUDED.date, on_shift = EXCLUDED.on_shift, version = EXCLUDED.version
		WHERE finance.roster.version <= EXCLUDED.version`, a.ID, a.EmployeeID, a.Date, a.ShiftID != nil && *a.ShiftID != "", m.AggregateVersion)
	return err
}

// Roster answers whether an employee works a shift on a date from people's roster.
type Roster struct{ DB *db.DB }

// Rostered reports a shift assigned to the employee on the date.
func (r Roster) Rostered(ctx context.Context, employeeID, date string) (bool, error) {
	var ok bool
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM finance.roster WHERE employee_id = $1 AND date = $2 AND on_shift)`, employeeID, date).Scan(&ok)
	return ok, err
}

func (c Catalog) location(ctx context.Context, m bus.Message) error {
	var e property.LocationEvent
	if err := json.Unmarshal(m.Payload, &e); err != nil {
		return err
	}
	_, err := c.DB.Q(ctx).Exec(ctx, `
		INSERT INTO finance.cat_locations (id, name, area, version) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, area = EXCLUDED.area, version = EXCLUDED.version
		WHERE finance.cat_locations.version < EXCLUDED.version`, e.Location.ID, e.Location.Name, e.Location.Area, m.AggregateVersion)
	return err
}

func (c Catalog) villa(ctx context.Context, m bus.Message) error {
	var e property.VillaEvent
	if err := json.Unmarshal(m.Payload, &e); err != nil {
		return err
	}
	_, err := c.DB.Q(ctx).Exec(ctx, `
		INSERT INTO finance.cat_villas (id, location_id, name, version) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET location_id = EXCLUDED.location_id, name = EXCLUDED.name, version = EXCLUDED.version
		WHERE finance.cat_villas.version < EXCLUDED.version`, e.Villa.ID, e.Villa.LocationID, e.Villa.Name, m.AggregateVersion)
	return err
}
