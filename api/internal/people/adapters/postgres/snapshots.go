package postgres

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/people"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/snapshot"
)

// Snapshots answers the current state behind the people events other contexts copy (housekeeping's
// and payroll's staff, rosters, leave, attendance, overtime and loans), as the events carry it, for a
// copy that started after the events went by: a context seeded fresh beside a people context that
// already holds data.
func Snapshots(d *db.DB) snapshot.Sources {
	return snapshot.Sources{
		people.EventEmployeeSaved:      rows(d, `SELECT id, version, json_build_object('employee', data, 'locationIds', location_ids) FROM people.employees ORDER BY id`),
		people.EventAssignmentSaved:    rows(d, `SELECT id, version, json_build_object('assignment', data) FROM people.shift_assignments ORDER BY id`),
		people.EventAttendanceRecorded: rows(d, `SELECT id, version, json_build_object('attendance', data) FROM people.attendance ORDER BY id`),
		people.EventLeaveSaved:         rows(d, `SELECT id, version, json_build_object('leave', data) FROM people.leave_requests ORDER BY id`),
		people.EventOvertimeSaved:      rows(d, `SELECT id, version, json_build_object('overtime', data) FROM people.overtime_requests ORDER BY id`),
		people.EventLoanSaved:          rows(d, `SELECT id, version, json_build_object('loan', data) FROM people.loans ORDER BY id`),
	}
}

// rows reads id, version and the event payload the query builds.
func rows(d *db.DB, query string) func(ctx context.Context) ([]snapshot.Record, error) {
	return func(ctx context.Context) ([]snapshot.Record, error) {
		rs, err := d.Q(ctx).Query(ctx, query)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rs, func(r pgx.CollectableRow) (snapshot.Record, error) {
			var id string
			var version int64
			var payload json.RawMessage
			if err := r.Scan(&id, &version, &payload); err != nil {
				return snapshot.Record{}, err
			}
			return snapshot.Of(id, version, payload)
		})
	}
}
