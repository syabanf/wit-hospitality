package postgres

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/property/domain"
)

func scanSection(row pgx.Row) (domain.Section, error) {
	var s domain.Section
	var units []byte
	if err := row.Scan(&s.ID, &s.VillaID, &s.Name, &units, &s.Version); err != nil {
		return s, err
	}
	return s, json.Unmarshal(units, &s.UnitIDs)
}

// Section loads and locks a section.
func (r Repo) Section(ctx context.Context, id string) (domain.Section, error) {
	s, err := scanSection(r.DB.Q(ctx).QueryRow(ctx, `SELECT id, villa_id, name, unit_ids, version FROM property.sections WHERE id = $1 FOR UPDATE`, id))
	return s, notFound(err, "section", id)
}

// VillaSections loads and locks a villa's sections, oldest first.
func (r Repo) VillaSections(ctx context.Context, villaID string) ([]domain.Section, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT id, villa_id, name, unit_ids, version FROM property.sections WHERE villa_id = $1 ORDER BY seq FOR UPDATE`, villaID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.Section, error) { return scanSection(row) })
}

func unitIDs(s *domain.Section) ([]byte, error) {
	if s.UnitIDs == nil {
		s.UnitIDs = []string{}
	}
	return json.Marshal(s.UnitIDs)
}

// InsertSection adds a section at version 1.
func (r Repo) InsertSection(ctx context.Context, s *domain.Section) error {
	units, err := unitIDs(s)
	if err != nil {
		return err
	}
	s.Version = 1
	_, err = r.DB.Q(ctx).Exec(ctx, `INSERT INTO property.sections (id, villa_id, name, unit_ids, version) VALUES ($1, $2, $3, $4, $5)`, s.ID, s.VillaID, s.Name, units, s.Version)
	return err
}

// UpdateSection saves when the version matches.
func (r Repo) UpdateSection(ctx context.Context, s *domain.Section) error {
	units, err := unitIDs(s)
	if err != nil {
		return err
	}
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE property.sections SET name = $2, unit_ids = $3, version = version + 1 WHERE id = $1 AND version = $4`, s.ID, s.Name, units, s.Version)
	if err := stale(tag, err, "section"); err != nil {
		return err
	}
	s.Version++
	return nil
}

// DeleteSection removes a section.
func (r Repo) DeleteSection(ctx context.Context, id string) error {
	_, err := r.DB.Q(ctx).Exec(ctx, `DELETE FROM property.sections WHERE id = $1`, id)
	return err
}

// VillaUnits reads a villa's units without locking them.
func (r Repo) VillaUnits(ctx context.Context, villaID string) ([]domain.Unit, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT `+unitColumns+`, to_char(status_until, 'YYYY-MM-DD'), version FROM property.units WHERE villa_id = $1 ORDER BY id`, villaID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.Unit, error) {
		var u domain.Unit
		err := row.Scan(append(unitFields(&u), &u.Version)...)
		return u, err
	})
}
