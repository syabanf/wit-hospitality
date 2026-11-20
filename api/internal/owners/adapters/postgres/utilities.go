package postgres

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/maintenance"
	"github.com/syabanf/wit-hospitality/api/internal/owners/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
)

// ConsumerUtilities keeps the owner-paid utility lines maintenance bills.
const ConsumerUtilities = "owners.utilities"

// RegisterUtilities adds the owner-paid utility handler to p.
func (pr Projections) RegisterUtilities(p *projector.Projector) {
	p.On(ConsumerUtilities, maintenance.EventUtilityBilled, pr.utility)
}

// utility keeps an owner-paid reading; a guest-paid one is billing's.
func (pr Projections) utility(ctx context.Context, m bus.Message) error {
	e, err := decode[maintenance.UtilityBilled](m)
	if err != nil || e.Payer != "owner" {
		return err
	}
	return pr.saveUtility(ctx, e.VillaID, e.Month, domain.StatementUtility{ReadingID: e.ReadingID, On: e.On, MeterNumber: e.MeterNumber, Kind: e.Kind, Usage: e.Usage, Unit: e.Unit, Tariff: e.Tariff, Amount: e.Amount})
}

func (pr Projections) saveUtility(ctx context.Context, villaID, month string, u domain.StatementUtility) error {
	line, err := json.Marshal(u)
	if err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO owners.utility_charges (reading_id, villa_id, month, line) VALUES ($1, $2, $3, $4)
		ON CONFLICT (reading_id) DO NOTHING`, u.ReadingID, villaID, month, line)
	return err
}

// Utilities lists a villa's owner-paid utility lines of the month in date order.
func (s Store) Utilities(ctx context.Context, villaID, month string) ([]domain.StatementUtility, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `SELECT line FROM owners.utility_charges WHERE villa_id = $1 AND month = $2 ORDER BY line->>'on', reading_id`, villaID, month)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.StatementUtility{}
	for rows.Next() {
		var raw []byte
		var u domain.StatementUtility
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, &u); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}
