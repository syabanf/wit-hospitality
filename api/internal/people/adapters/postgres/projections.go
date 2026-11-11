package postgres

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/property"
)

// ConsumerVillas keeps people.rm_villas from property events.
const ConsumerVillas = "people.villas"

// Projections copies the property catalog people needs: each villa's name and location.
type Projections struct{ DB *db.DB }

// Register adds the handlers to p.
func (pr Projections) Register(p *projector.Projector) {
	p.On(ConsumerVillas, property.EventVillaCreated, pr.villa)
	p.On(ConsumerVillas, property.EventVillaUpdated, pr.villa)
}

func (pr Projections) villa(ctx context.Context, m bus.Message) error {
	var e property.VillaEvent
	if err := json.Unmarshal(m.Payload, &e); err != nil {
		return err
	}
	v := e.Villa
	q := pr.DB.Q(ctx)
	tag, err := q.Exec(ctx, `
		INSERT INTO people.rm_villas (id, location_id, name, version) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET location_id = EXCLUDED.location_id, name = EXCLUDED.name, version = EXCLUDED.version
		WHERE people.rm_villas.version < EXCLUDED.version`, v.ID, v.LocationID, v.Name, m.AggregateVersion)
	if err != nil || tag.RowsAffected() == 0 {
		return err
	}
	// A villa that moved location moves the scope of the employees and notices at it.
	for _, table := range []string{"employees", "announcements"} {
		if _, err := q.Exec(ctx, `
			UPDATE people.`+table+` t SET location_ids = ARRAY(
				SELECT coalesce(v.location_id, '') FROM unnest(t.villa_ids) WITH ORDINALITY AS a(villa_id, n)
				LEFT JOIN people.rm_villas v ON v.id = a.villa_id ORDER BY a.n)
			WHERE $1 = ANY(t.villa_ids)`, v.ID); err != nil {
			return err
		}
	}
	return nil
}
