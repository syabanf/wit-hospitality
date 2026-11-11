package postgres

import (
	"context"
	"encoding/json"

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
