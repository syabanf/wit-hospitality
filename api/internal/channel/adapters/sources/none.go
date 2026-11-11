// Package sources answers channel's questions about records other contexts own: the booking an
// enquiry became and the public site's stays, stay rules, tax, menu and team. Until reservation,
// finance, services and people run, None answers truthfully for an API that holds none of those
// records: no bookings or stays, no stay rules, the default tax settings, no menu and no team. Each
// later phase replaces one answer with a client of the owning context (in process in the monolith,
// HTTP in split mode) behind the same interfaces.
package sources

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/channel/domain"
)

// DefaultTax is DEFAULT_TAX_SETTINGS in tax.ts as the site reads it: rates and the direct price
// mode.
var DefaultTax = json.RawMessage(`{"rates":[{"effectiveFrom":"2020-01-01","servicePct":10,"pb1Pct":10,"pb1OnService":true,` +
	`"serviceCodes":["ROOM","LATE","FNB","MINI","SPA","XTRA"],"pb1Codes":["ROOM","LATE","FNB","MINI","SPA","XTRA","LDRY"]}],"directMode":"net"}`)

// None reports no records.
type None struct{}

// BookingCode finds no booking.
func (None) BookingCode(context.Context, string) (string, bool, error) { return "", false, nil }

// Restrictions lists no stay rules.
func (None) Restrictions(context.Context) ([]json.RawMessage, error) { return []json.RawMessage{}, nil }

// Tax returns the default tax settings.
func (None) Tax(context.Context) (json.RawMessage, error) { return DefaultTax, nil }

// Menu lists no menu items.
func (None) Menu(context.Context) ([]json.RawMessage, error) { return []json.RawMessage{}, nil }

// Team lists no roles.
func (None) Team(context.Context) ([]json.RawMessage, error) { return []json.RawMessage{}, nil }

// Stays finds no stays.
func (None) Stays(context.Context, string, string) ([]domain.Hold, error) {
	return []domain.Hold{}, nil
}
