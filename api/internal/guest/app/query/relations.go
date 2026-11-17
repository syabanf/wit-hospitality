package query

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/guest/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// RelationsStore reads complaints, incidents, safe boxes and box rentals in a scope.
type RelationsStore interface {
	Complaints(ctx context.Context, s rbac.Scope) ([]domain.Complaint, error)
	Incidents(ctx context.Context, s rbac.Scope) ([]domain.Incident, error)
	SafeBoxes(ctx context.Context, s rbac.Scope) ([]domain.SafeBox, error)
	BoxRentals(ctx context.Context, s rbac.Scope) ([]domain.BoxRental, error)
}

func scoped[T any](ctx context.Context, read func(context.Context, rbac.Scope) ([]T, error)) ([]T, error) {
	s, err := scope(ctx)
	if err != nil {
		return nil, err
	}
	return read(ctx, s)
}

// Complaints is GET /complaints.
func (q Queries) Complaints(ctx context.Context) ([]domain.Complaint, error) {
	return scoped(ctx, q.Store.Complaints)
}

// Incidents is GET /incidents.
func (q Queries) Incidents(ctx context.Context) ([]domain.Incident, error) {
	return scoped(ctx, q.Store.Incidents)
}

// SafeBoxes is GET /safe-boxes.
func (q Queries) SafeBoxes(ctx context.Context) ([]domain.SafeBox, error) {
	return scoped(ctx, q.Store.SafeBoxes)
}

// BoxRentals is GET /safe-box-rentals.
func (q Queries) BoxRentals(ctx context.Context) ([]domain.BoxRental, error) {
	return scoped(ctx, q.Store.BoxRentals)
}
