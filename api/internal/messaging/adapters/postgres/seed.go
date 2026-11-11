package postgres

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/messaging"
	"github.com/syabanf/wit-hospitality/api/internal/messaging/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
)

// SeedData is seed/messaging.json, written by scripts/export-seed.mjs from the mock's buildState.
// PaymentLinks is messaging's copy of billing's links; BookingVillas places each message.
type SeedData struct {
	BaseDate      string                  `json:"baseDate"`
	Settings      domain.Settings         `json:"settings"`
	Messages      []domain.Message        `json:"messages"`
	PaymentLinks  []messaging.PaymentLink `json:"paymentLinks"`
	BookingVillas map[string]string       `json:"bookingVillas"`
	Next          map[string]int64        `json:"next"`
}

// ParseSeed decodes the fixture.
func ParseSeed(raw []byte) (SeedData, error) {
	var s SeedData
	err := json.Unmarshal(raw, &s)
	return s, err
}

func shiftStamp(s string, n int) string {
	if len(s) < 10 {
		return s
	}
	return clock.AddDays(s[:10], n) + s[10:]
}

func shiftPtr(s *string, n int) *string {
	if s == nil {
		return nil
	}
	v := shiftStamp(*s, n)
	return &v
}

// Seed replaces the messaging write model with the fixture, its stamps shifted by shiftDays. The
// bodies keep the dates the export rendered. The catalog, guest and stay copies come from the
// other contexts' seed events, so the copies are not truncated here.
func Seed(ctx context.Context, d *db.DB, data SeedData, shiftDays int) error {
	repo := Repo{DB: d}
	return d.InTx(ctx, func(ctx context.Context) error {
		q := d.Q(ctx)
		if _, err := q.Exec(ctx, `TRUNCATE messaging.counters, messaging.settings, messaging.messages, messaging.payment_links, messaging.cat_villas,
			messaging.cat_unit_groups, messaging.cat_units, messaging.guests, messaging.stays RESTART IDENTITY`); err != nil {
			return err
		}
		if _, err := repo.SaveSettings(ctx, data.Settings, 0); err != nil {
			return fmt.Errorf("seed messaging settings: %w", err)
		}
		for _, m := range data.Messages {
			m.QueuedAt = shiftStamp(m.QueuedAt, shiftDays)
			m.SentAt, m.DeliveredAt, m.ReadAt, m.FailedAt = shiftPtr(m.SentAt, shiftDays), shiftPtr(m.DeliveredAt, shiftDays), shiftPtr(m.ReadAt, shiftDays), shiftPtr(m.FailedAt, shiftDays)
			if err := repo.InsertMessage(ctx, &m, data.BookingVillas[m.BookingID]); err != nil {
				return fmt.Errorf("seed message %s: %w", m.ID, err)
			}
		}
		for _, l := range data.PaymentLinks {
			if _, err := q.Exec(ctx, `INSERT INTO messaging.payment_links (token, booking_id, amount, status, version) VALUES ($1, $2, $3, $4, 1)`,
				l.Token, l.BookingID, l.Amount, l.Status); err != nil {
				return fmt.Errorf("seed payment link %s: %w", l.Token, err)
			}
		}
		for key, n := range data.Next {
			if _, err := q.Exec(ctx, `INSERT INTO messaging.counters (key, n) VALUES ($1, $2)`, key, n); err != nil {
				return err
			}
		}
		return nil
	})
}
