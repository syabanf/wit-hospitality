package postgres

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
)

// StayLookup answers reservation.Stays from the booking write table, so a stay is visible to
// other contexts the moment it is saved.
type StayLookup struct{ DB *db.DB }

const staySelect = `
	SELECT b.id, b.code, COALESCE(b.doc->>'guestId', ''), b.unit_id, b.unit_assigned, COALESCE(u.villa_id, ''), b.status,
		to_char(b.check_in, 'YYYY-MM-DD'), to_char(b.check_out, 'YYYY-MM-DD')
	FROM reservation.bookings b LEFT JOIN reservation.cat_units u ON u.id = b.unit_id`

func scanStay(r pgx.CollectableRow) (reservation.Stay, error) {
	var s reservation.Stay
	err := r.Scan(&s.ID, &s.Code, &s.GuestID, &s.UnitID, &s.UnitAssigned, &s.VillaID, &s.Status, &s.CheckIn, &s.CheckOut)
	return s, err
}

// Stay returns one booking.
func (l StayLookup) Stay(ctx context.Context, id string) (reservation.Stay, error) {
	rows, err := l.DB.Q(ctx).Query(ctx, staySelect+` WHERE b.id = $1`, id)
	if err != nil {
		return reservation.Stay{}, err
	}
	s, err := pgx.CollectExactlyOneRow(rows, scanStay)
	if db.NoRows(err) {
		return s, errs.NotFound("booking", id)
	}
	return s, err
}

// InUnit lists the confirmed and checked-in stays with the unit assigned, oldest first.
func (l StayLookup) InUnit(ctx context.Context, unitID string) ([]reservation.Stay, error) {
	rows, err := l.DB.Q(ctx).Query(ctx, staySelect+`
		WHERE b.unit_id = $1 AND b.unit_assigned AND b.status IN ('confirmed', 'checked_in') ORDER BY b.check_in, b.seq`, unitID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, scanStay)
}

// Groups answers reservation.Groups from the group write table.
type Groups struct{ DB *db.DB }

// GroupSources lists every group's source and version, by id.
func (g Groups) GroupSources(ctx context.Context) ([]reservation.GroupSource, error) {
	rows, err := g.DB.Q(ctx).Query(ctx, `SELECT id, COALESCE(doc->>'source', ''), version FROM reservation.booking_groups ORDER BY id`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (reservation.GroupSource, error) {
		var s reservation.GroupSource
		err := r.Scan(&s.ID, &s.Source, &s.Version)
		return s, err
	})
}
