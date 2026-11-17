package postgres

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/maintenance/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
)

// ConsumerStays keeps maintenance's copy of reservation's stays.
const ConsumerStays = "maintenance.stays"

// VillaOps keeps meters, readings, the long-stay setting and the stay copy.
type VillaOps struct{ DB *db.DB }

var _ command.VillaOps = VillaOps{}

// LockVilla serialises meter and reading writes of one villa.
func (v VillaOps) LockVilla(ctx context.Context, villaID string) error {
	_, err := v.DB.Q(ctx).Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('maintenance.villa:' || $1))`, villaID)
	return err
}

// Meters lists a villa's meters.
func (v VillaOps) Meters(ctx context.Context, villaID string) ([]domain.Meter, error) {
	return docs[domain.Meter](v.DB.Q(ctx).Query(ctx, `SELECT doc FROM maintenance.meters WHERE villa_id = $1 ORDER BY seq`, villaID))
}

// Meter reads one meter.
func (v VillaOps) Meter(ctx context.Context, id string) (domain.Meter, error) {
	var raw []byte
	var m domain.Meter
	if err := v.DB.Q(ctx).QueryRow(ctx, `SELECT doc FROM maintenance.meters WHERE id = $1`, id).Scan(&raw); err != nil {
		return m, notFound(err, "meter", id)
	}
	return m, json.Unmarshal(raw, &m)
}

// SaveMeter inserts or replaces a meter.
func (v VillaOps) SaveMeter(ctx context.Context, m domain.Meter) error {
	doc, err := json.Marshal(m)
	if err != nil {
		return err
	}
	_, err = v.DB.Q(ctx).Exec(ctx, `
		INSERT INTO maintenance.meters (id, villa_id, doc) VALUES ($1, $2, $3)
		ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, version = maintenance.meters.version + 1`, m.ID, m.VillaID, doc)
	return err
}

// Readings lists a meter's readings in the order they were recorded.
func (v VillaOps) Readings(ctx context.Context, meterID string) ([]domain.MeterReading, error) {
	return docs[domain.MeterReading](v.DB.Q(ctx).Query(ctx, `SELECT doc FROM maintenance.meter_readings WHERE meter_id = $1 ORDER BY seq`, meterID))
}

// InsertReading stores a reading.
func (v VillaOps) InsertReading(ctx context.Context, r domain.MeterReading) error {
	doc, err := json.Marshal(r)
	if err != nil {
		return err
	}
	_, err = v.DB.Q(ctx).Exec(ctx, `INSERT INTO maintenance.meter_readings (id, meter_id, villa_id, doc) VALUES ($1, $2, $3, $4)`, r.ID, r.MeterID, r.VillaID, doc)
	return err
}

// LongStayNights is the villa's long-stay length, 28 when never set.
func (v VillaOps) LongStayNights(ctx context.Context, villaID string) (int, error) {
	n := domain.DefaultLongStayNights
	err := v.DB.Q(ctx).QueryRow(ctx, `SELECT long_stay_nights FROM maintenance.utility_settings WHERE villa_id = $1`, villaID).Scan(&n)
	if db.NoRows(err) {
		return domain.DefaultLongStayNights, nil
	}
	return n, err
}

// SaveLongStayNights stores the villa's long-stay length.
func (v VillaOps) SaveLongStayNights(ctx context.Context, villaID string, nights int) error {
	_, err := v.DB.Q(ctx).Exec(ctx, `
		INSERT INTO maintenance.utility_settings (villa_id, long_stay_nights) VALUES ($1, $2)
		ON CONFLICT (villa_id) DO UPDATE SET long_stay_nights = EXCLUDED.long_stay_nights`, villaID, nights)
	return err
}

// Stay reads the copy of a stay.
func (v VillaOps) Stay(ctx context.Context, id string) (command.Stay, error) {
	var s command.Stay
	var window []byte
	err := v.DB.Q(ctx).QueryRow(ctx, `SELECT id, code, status, unit_id, check_in, check_out, service_window FROM maintenance.ref_stays WHERE id = $1`, id).
		Scan(&s.ID, &s.Code, &s.Status, &s.UnitID, &s.CheckIn, &s.CheckOut, &window)
	if err != nil {
		return s, notFound(err, "booking", id)
	}
	return s, decodeWindow(window, &s)
}

// StayInHouse is the first stay checked in on any of the units, nil when none.
func (v VillaOps) StayInHouse(ctx context.Context, unitIDs []string) (*command.Stay, error) {
	var s command.Stay
	var window []byte
	err := v.DB.Q(ctx).QueryRow(ctx, `
		SELECT id, code, status, unit_id, check_in, check_out, service_window FROM maintenance.ref_stays
		WHERE status = 'checked_in' AND unit_id = ANY($1) ORDER BY check_in, id LIMIT 1`, unitIDs).
		Scan(&s.ID, &s.Code, &s.Status, &s.UnitID, &s.CheckIn, &s.CheckOut, &window)
	if db.NoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &s, decodeWindow(window, &s)
}

func decodeWindow(raw []byte, s *command.Stay) error {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	s.Window = &domain.ServiceWindow{}
	return json.Unmarshal(raw, s.Window)
}

// UnitsOf lists a villa's units.
func (v VillaOps) UnitsOf(ctx context.Context, villaID string) ([]string, error) {
	rows, err := v.DB.Q(ctx).Query(ctx, `SELECT id FROM maintenance.ref_units WHERE villa_id = $1 ORDER BY id`, villaID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// VillaPlans lists a villa's plans.
func (v VillaOps) VillaPlans(ctx context.Context, villaID string) ([]domain.Plan, error) {
	return docs[domain.Plan](v.DB.Q(ctx).Query(ctx, `SELECT doc FROM maintenance.plans WHERE villa_id = $1 ORDER BY seq`, villaID))
}

// stay keeps the copy of a booking from booking.saved and status_changed; both carry the record.
func (pr Projections) stay(ctx context.Context, m bus.Message) error {
	r, err := decode[reservation.Record](m)
	if err != nil {
		return err
	}
	var b struct {
		Code          string          `json:"code"`
		Status        string          `json:"status"`
		UnitID        string          `json:"unitId"`
		CheckIn       string          `json:"checkIn"`
		CheckOut      string          `json:"checkOut"`
		ServiceWindow json.RawMessage `json:"serviceWindow"`
	}
	if err := json.Unmarshal(r.Data, &b); err != nil {
		return err
	}
	var window any
	if len(b.ServiceWindow) > 0 && string(b.ServiceWindow) != "null" {
		window = []byte(b.ServiceWindow)
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO maintenance.ref_stays (id, code, status, unit_id, check_in, check_out, service_window, version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, status = EXCLUDED.status, unit_id = EXCLUDED.unit_id, check_in = EXCLUDED.check_in,
			check_out = EXCLUDED.check_out, service_window = EXCLUDED.service_window, version = EXCLUDED.version
		WHERE maintenance.ref_stays.version <= EXCLUDED.version`, r.ID, b.Code, b.Status, b.UnitID, b.CheckIn, b.CheckOut, window, m.AggregateVersion)
	return err
}

// Meters lists the meters of villas in scope.
func (s ReadStore) Meters(ctx context.Context, sc rbac.Scope) ([]domain.Meter, error) {
	return docs[domain.Meter](s.DB.Q(ctx).Query(ctx, `SELECT doc FROM maintenance.v_meters WHERE `+inScope+` ORDER BY seq`, args(sc)...))
}

// Readings lists the readings of villas in scope, in the order they were recorded.
func (s ReadStore) Readings(ctx context.Context, sc rbac.Scope) ([]domain.MeterReading, error) {
	return docs[domain.MeterReading](s.DB.Q(ctx).Query(ctx, `SELECT doc FROM maintenance.v_meter_readings WHERE `+inScope+` ORDER BY seq`, args(sc)...))
}

// UtilitySettings answers every villa in scope with its long-stay length.
func (s ReadStore) UtilitySettings(ctx context.Context, sc rbac.Scope) ([]domain.UtilitySettings, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `
		SELECT villa_id, nights FROM (
			SELECT v.id AS villa_id, v.location_id, coalesce(u.long_stay_nights, $3) AS nights
			FROM maintenance.ref_villas v LEFT JOIN maintenance.utility_settings u ON u.villa_id = v.id) x
		WHERE `+inScope+` ORDER BY villa_id`, append(args(sc), domain.DefaultLongStayNights)...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.UtilitySettings, error) {
		var u domain.UtilitySettings
		return u, r.Scan(&u.VillaID, &u.LongStayNights)
	})
}
