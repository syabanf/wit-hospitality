package postgres

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/property"
)

// section keeps a section of property's at the event's version.
func (pr Projections) section(ctx context.Context, m bus.Message) error {
	e, err := decode[property.SectionSaved](m)
	if err != nil {
		return err
	}
	return upsertSection(ctx, pr.DB, domain.Section(e.Section), m.AggregateVersion)
}

func upsertSection(ctx context.Context, d *db.DB, s domain.Section, version int64) error {
	units, err := json.Marshal(s.UnitIDs)
	if err != nil {
		return err
	}
	_, err = d.Q(ctx).Exec(ctx, `
		INSERT INTO housekeeping.cat_sections (id, villa_id, name, unit_ids, version) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (id) DO UPDATE SET villa_id = EXCLUDED.villa_id, name = EXCLUDED.name, unit_ids = EXCLUDED.unit_ids, version = EXCLUDED.version
		WHERE housekeeping.cat_sections.version < EXCLUDED.version`, s.ID, s.VillaID, s.Name, units, version)
	return err
}

// sectionRemoved drops the copy of a removed section and its attendants. Property numbers a
// removal one above the section's last save, so an older save arriving late leaves no trace.
func (pr Projections) sectionRemoved(ctx context.Context, m bus.Message) error {
	e, err := decode[property.SectionRemoved](m)
	if err != nil {
		return err
	}
	q := pr.DB.Q(ctx)
	if _, err := q.Exec(ctx, `DELETE FROM housekeeping.cat_sections WHERE id = $1 AND version < $2`, e.ID, m.AggregateVersion); err != nil {
		return err
	}
	_, err = q.Exec(ctx, `DELETE FROM housekeeping.section_assignments WHERE section_id = $1`, e.ID)
	return err
}

// Section reads a section from the copy.
func (r Repo) Section(ctx context.Context, id string) (domain.Section, error) {
	var s domain.Section
	var units []byte
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT id, villa_id, name, unit_ids FROM housekeeping.cat_sections WHERE id = $1`, id).Scan(&s.ID, &s.VillaID, &s.Name, &units)
	if err != nil {
		return s, notFound(err, "section", id)
	}
	return s, json.Unmarshal(units, &s.UnitIDs)
}

// SectionAttendant is the attendant who holds the section on date, locked; nil when nobody does.
func (r Repo) SectionAttendant(ctx context.Context, sectionID, date string) (*string, error) {
	var id string
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT attendant_id FROM housekeeping.section_assignments WHERE section_id = $1 AND date = $2::date FOR UPDATE`, sectionID, date).Scan(&id)
	if db.NoRows(err) {
		return nil, nil
	}
	return &id, err
}

// SaveSectionAttendant gives the section to the attendant on date, or clears the day with nil.
func (r Repo) SaveSectionAttendant(ctx context.Context, sectionID, date string, attendantID *string) error {
	if attendantID == nil {
		_, err := r.DB.Q(ctx).Exec(ctx, `DELETE FROM housekeeping.section_assignments WHERE section_id = $1 AND date = $2::date`, sectionID, date)
		return err
	}
	_, err := r.DB.Q(ctx).Exec(ctx, `
		INSERT INTO housekeeping.section_assignments (section_id, date, attendant_id) VALUES ($1, $2::date, $3)
		ON CONFLICT (section_id, date) DO UPDATE SET attendant_id = EXCLUDED.attendant_id`, sectionID, date, *attendantID)
	return err
}

// UnitAttendant is the attendant who holds a section with the unit on date; nil when none does.
func (r Repo) UnitAttendant(ctx context.Context, unitID, date string) (*string, error) {
	var id string
	err := r.DB.Q(ctx).QueryRow(ctx, `
		SELECT a.attendant_id FROM housekeeping.section_assignments a JOIN housekeeping.cat_sections s ON s.id = a.section_id
		WHERE a.date = $2::date AND s.unit_ids ? $1 ORDER BY s.seq LIMIT 1`, unitID, date).Scan(&id)
	if db.NoRows(err) {
		return nil, nil
	}
	return &id, err
}

// SectionAssignments lists the section attendants whose section's villa is in scope, by day and
// section.
func (s ReadStore) SectionAssignments(ctx context.Context, sc rbac.Scope) ([]domain.SectionAssignment, error) {
	vil, loc := scopeIDs(sc)
	rows, err := s.DB.Q(ctx).Query(ctx, `
		SELECT a.section_id, to_char(a.date, 'YYYY-MM-DD'), a.attendant_id
		FROM housekeeping.section_assignments a
		JOIN housekeeping.cat_sections c ON c.id = a.section_id
		LEFT JOIN housekeeping.cat_villas v ON v.id = c.villa_id
		WHERE (cardinality($1::text[]) > 0 AND c.villa_id = ANY($1))
		   OR (cardinality($1::text[]) = 0 AND (cardinality($2::text[]) = 0 OR v.location_id = ANY($2)))
		ORDER BY a.date, c.seq`, vil, loc)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.SectionAssignment, error) {
		var a domain.SectionAssignment
		err := r.Scan(&a.SectionID, &a.Date, &a.AttendantID)
		return a, err
	})
}
