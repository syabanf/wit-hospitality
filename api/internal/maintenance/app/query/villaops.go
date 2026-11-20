package query

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/maintenance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// OpsStore reads meters, readings and the long-stay settings, narrowed to a scope.
type OpsStore interface {
	Meters(ctx context.Context, s rbac.Scope) ([]domain.Meter, error)
	Readings(ctx context.Context, s rbac.Scope) ([]domain.MeterReading, error)
	UtilitySettings(ctx context.Context, s rbac.Scope) ([]domain.UtilitySettings, error)
}

func scoped[T any](ctx context.Context, read func(context.Context, rbac.Scope) ([]T, error)) ([]T, error) {
	s, err := scope(ctx)
	if err != nil {
		return nil, err
	}
	return read(ctx, s)
}

// Meters is GET /meters.
func (q Queries) Meters(ctx context.Context) ([]domain.Meter, error) {
	return scoped(ctx, q.Ops.Meters)
}

// Readings is GET /meter-readings.
func (q Queries) Readings(ctx context.Context) ([]domain.MeterReading, error) {
	return scoped(ctx, q.Ops.Readings)
}

// UtilitySettings is GET /utility-settings.
func (q Queries) UtilitySettings(ctx context.Context) ([]domain.UtilitySettings, error) {
	return scoped(ctx, q.Ops.UtilitySettings)
}
