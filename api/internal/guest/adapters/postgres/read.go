package postgres

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/guest/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// ReadStore reads the guest schema's views.
type ReadStore struct{ DB *db.DB }

// inScope is the allowedVilla rule in SQL: $1 villa ids, $2 location ids; empty lists allow all.
// A row whose villa guest does not know passes only an unrestricted scope.
const inScope = `((cardinality($1::text[]) > 0 AND villa_id = ANY($1)) OR
	(cardinality($1::text[]) = 0 AND (cardinality($2::text[]) = 0 OR location_id = ANY($2))))`

func args(s rbac.Scope) []any {
	vil, loc := s.VillaIDs, s.LocationIDs
	if vil == nil {
		vil = []string{}
	}
	if loc == nil {
		loc = []string{}
	}
	return []any{vil, loc}
}

// Guests returns every profile in creation order. Profiles are shared across villas: the booking
// form picks a returning guest whichever villa they stayed in.
func (s ReadStore) Guests(ctx context.Context) ([]domain.Guest, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `SELECT doc FROM guest.v_guests ORDER BY seq`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, docRow[domain.Guest])
}

// Guest returns one profile.
func (s ReadStore) Guest(ctx context.Context, id string) (domain.Guest, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `SELECT doc FROM guest.v_guests WHERE id = $1`, id)
	if err != nil {
		return domain.Guest{}, err
	}
	g, err := pgx.CollectExactlyOneRow(rows, docRow[domain.Guest])
	return g, notFound(err, "guest", id)
}

// Companions returns the companions on stays in scope.
func (s ReadStore) Companions(ctx context.Context, sc rbac.Scope) ([]domain.Companion, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `SELECT doc FROM guest.v_companions WHERE `+inScope+` ORDER BY seq`, args(sc)...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, docRow[domain.Companion])
}

// CompanionsOf returns the companions of one stay.
func (s ReadStore) CompanionsOf(ctx context.Context, bookingID string) ([]domain.Companion, error) {
	return companionsOf(ctx, s.DB, bookingID)
}

// Reports returns the Immigration reports of stays in scope.
func (s ReadStore) Reports(ctx context.Context, sc rbac.Scope) ([]domain.ForeignReport, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `
		SELECT id, booking_id, person_id, reported_at, reported_by, reference FROM guest.v_foreign_reports
		WHERE `+inScope+` ORDER BY seq`, args(sc)...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.ForeignReport, error) {
		var f domain.ForeignReport
		err := r.Scan(&f.ID, &f.BookingID, &f.PersonID, &f.ReportedAt, &f.ReportedBy, &f.Reference)
		return f, err
	})
}

// LostItems returns the items found in villas in scope.
func (s ReadStore) LostItems(ctx context.Context, sc rbac.Scope) ([]domain.LostItem, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `SELECT doc FROM guest.v_lost_items WHERE `+inScope+` ORDER BY seq`, args(sc)...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, docRow[domain.LostItem])
}

// Settings returns the lost and found settings.
func (s ReadStore) Settings(ctx context.Context) (domain.LostFoundSettings, error) {
	return settings(ctx, s.DB, "")
}

// StartedStays returns the stays in scope that have checked in.
func (s ReadStore) StartedStays(ctx context.Context, sc rbac.Scope) ([]domain.StayPlace, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `
		SELECT `+stayColumns+`, coalesce(location_id, ''), coalesce(villa_name, ''), coalesce(location_name, ''), coalesce(location_area, ''), coalesce(unit_code, '')
		FROM guest.v_stays WHERE status IN ('checked_in', 'checked_out') AND checked_in_on IS NOT NULL AND `+inScope+` ORDER BY seq`, args(sc)...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.StayPlace, error) {
		var v domain.StayPlace
		st := &v.Stay
		err := r.Scan(&st.ID, &st.Code, &st.GuestID, &st.UnitID, &st.VillaID, &st.Status, &st.CheckIn, &st.CheckOut, &st.CheckedInOn, &st.CheckedOutOn, &st.ArrivalTime, &st.Adults,
			&v.LocationID, &v.VillaName, &v.LocationName, &v.LocationArea, &v.UnitCode)
		return v, err
	})
}
