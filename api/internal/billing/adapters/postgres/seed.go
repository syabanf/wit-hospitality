package postgres

import (
	"context"
	"encoding/json"
	"regexp"
	"strconv"

	"github.com/syabanf/wit-hospitality/api/internal/billing/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
)

// SeedData is seed/billing.json, written by scripts/export-seed.mjs from the mock's buildState.
// Records stay in the console's JSON; the loader reads the keys it files them under.
type SeedData struct {
	BaseDate            string              `json:"baseDate"`
	BusinessDate        string              `json:"businessDate"`
	PaymentPolicy       json.RawMessage     `json:"paymentPolicy"`
	ShiftPolicy         json.RawMessage     `json:"shiftPolicy"`
	Tax                 json.RawMessage     `json:"tax"`
	TransactionCodes    []json.RawMessage   `json:"transactionCodes"`
	FolioPostings       []json.RawMessage   `json:"folioPostings"`
	Payments            []json.RawMessage   `json:"payments"`
	PaymentLinks        []json.RawMessage   `json:"paymentLinks"`
	NightAudits         []json.RawMessage   `json:"nightAudits"`
	NightsPosted        map[string][]string `json:"nightsPosted"`
	Orders              []json.RawMessage   `json:"orders"`
	CashierShifts       []json.RawMessage   `json:"cashierShifts"`
	HandOvers           []json.RawMessage   `json:"handOvers"`
	CityLedgerAccounts  []json.RawMessage   `json:"cityLedgerAccounts"`
	CityLedgerInvoices  []json.RawMessage   `json:"cityLedgerInvoices"`
	CityLedgerPayments  []json.RawMessage   `json:"cityLedgerPayments"`
	CityLedgerWriteOffs []json.RawMessage   `json:"cityLedgerWriteOffs"`
	CashAccounts        []json.RawMessage   `json:"cashAccounts"`
}

// ParseSeed decodes the fixture.
func ParseSeed(raw []byte) (SeedData, error) {
	var s SeedData
	err := json.Unmarshal(raw, &s)
	return s, err
}

var datePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$`)

// shiftDates moves every date and local date-time in a record by n days. Effective dates of tax
// rates are rule dates, not demo dates, and stay.
func shiftDates(v any, n int) any {
	switch x := v.(type) {
	case map[string]any:
		for k, child := range x {
			if k != "effectiveFrom" {
				x[k] = shiftDates(child, n)
			}
		}
	case []any:
		for i, child := range x {
			x[i] = shiftDates(child, n)
		}
	case string:
		if datePattern.MatchString(x) {
			return clock.AddDays(x[:10], n) + x[10:]
		}
	}
	return v
}

func shifted(raw json.RawMessage, n int) (map[string]any, error) {
	var v map[string]any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	shiftDates(v, n)
	return v, nil
}

func text(v map[string]any, key string) string {
	s, _ := v[key].(string)
	return s
}

var trailing = regexp.MustCompile(`(\d+)$`)

// number reads the number a record's id or number ends with.
func number(s string) int64 {
	m := trailing.FindString(s)
	n, _ := strconv.ParseInt(m, 10, 64)
	return n
}

// Reset empties billing's copies of other contexts, so the seed's events rebuild them from scratch
// instead of losing to the newer versions an earlier run left.
func Reset(ctx context.Context, d *db.DB) error {
	_, err := d.Pool.Exec(ctx, `TRUNCATE billing.rm_stays, billing.rm_groups, billing.cat_units, billing.cat_villas, billing.cat_locations`)
	return err
}

// Seed replaces billing's records with the fixture, shifted by shiftDays. It reads each stay's
// villa and location from billing's copy of the bookings, so reservation's seed events must be
// projected first. It appends no events: finance seeds its own entries for the demo's money.
func Seed(ctx context.Context, d *db.DB, data SeedData, shiftDays int) error {
	store := Store{DB: d}
	return d.InTx(ctx, func(ctx context.Context) error {
		q := d.Q(ctx)
		if _, err := q.Exec(ctx, `TRUNCATE billing.counters, billing.settings, billing.postings, billing.payments, billing.links,
			billing.night_audits, billing.shifts, billing.hand_overs, billing.transaction_codes, billing.cl_accounts, billing.cl_invoices,
			billing.cl_payments, billing.cl_write_offs, billing.cash_accounts, billing.night_posts, billing.rm_orders RESTART IDENTITY`); err != nil {
			return err
		}
		scope := func(bookingID string) (string, string, error) {
			var villa, location string
			err := q.QueryRow(ctx, `SELECT villa_id, location_id FROM billing.rm_stays WHERE id = $1`, bookingID).Scan(&villa, &location)
			if db.NoRows(err) {
				return "", "", nil
			}
			return villa, location, err
		}
		counters := map[string]int64{}
		count := func(key string, n int64) {
			counters[key] = max(counters[key], n)
		}
		load := func(table string, list []json.RawMessage, key func(v map[string]any) (command.Row, error)) error {
			for _, raw := range list {
				v, err := shifted(raw, shiftDays)
				if err != nil {
					return err
				}
				r, err := key(v)
				if err != nil {
					return err
				}
				r.Doc = v
				if err := store.Put(ctx, table, r); err != nil {
					return err
				}
			}
			return nil
		}
		byStay := func(ref func(v map[string]any) string) func(v map[string]any) (command.Row, error) {
			return func(v map[string]any) (command.Row, error) {
				id := text(v, "id")
				if id == "" {
					id = text(v, "token")
				}
				villa, location, err := scope(text(v, "bookingId"))
				return command.Row{ID: id, BookingID: text(v, "bookingId"), VillaID: villa, LocationID: location, Ref: ref(v)}, err
			}
		}
		byRef := func(field string) func(v map[string]any) (command.Row, error) {
			return func(v map[string]any) (command.Row, error) {
				return command.Row{ID: text(v, "id"), LocationID: text(v, "locationId"), Ref: text(v, field)}, nil
			}
		}
		steps := []struct {
			table string
			list  []json.RawMessage
			key   func(v map[string]any) (command.Row, error)
		}{
			{command.Codes, data.TransactionCodes, byRef("code")},
			{command.CashAccounts, data.CashAccounts, byRef("id")},
			{command.Postings, data.FolioPostings, byStay(func(v map[string]any) string {
				if cl, ok := v["cityLedger"].(map[string]any); ok {
					return text(cl, "accountId")
				}
				return ""
			})},
			{command.Payments, data.Payments, byStay(func(v map[string]any) string { return text(v, "refundOf") })},
			{command.Links, data.PaymentLinks, byStay(func(v map[string]any) string { return text(v, "paymentId") })},
			{command.Audits, data.NightAudits, byRef("date")},
			{command.Shifts, data.CashierShifts, byRef("accountId")},
			{command.HandOvers, data.HandOvers, byRef("accountId")},
			{command.Accounts, data.CityLedgerAccounts, byRef("")},
			{command.Invoices, data.CityLedgerInvoices, byRef("accountId")},
			{command.LedgerPayments, data.CityLedgerPayments, byRef("accountId")},
			{command.WriteOffs, data.CityLedgerWriteOffs, byRef("accountId")},
		}
		for _, s := range steps {
			if err := load(s.table, s.list, s.key); err != nil {
				return err
			}
		}
		// Counters continue past the seed's numbers, so new records never take a seeded id.
		numbered := func(key string, list []json.RawMessage, field string) error {
			for _, raw := range list {
				var v map[string]any
				if err := json.Unmarshal(raw, &v); err != nil {
					return err
				}
				count(key, number(text(v, field)))
			}
			return nil
		}
		for _, n := range []struct {
			key, field string
			list       []json.RawMessage
		}{
			{"folio", "id", data.FolioPostings}, {"nightAudit", "id", data.NightAudits}, {"cashierShift", "id", data.CashierShifts},
			{"handOver", "id", data.HandOvers}, {"clInvoice", "id", data.CityLedgerInvoices}, {"clPayment", "id", data.CityLedgerPayments},
			{"clWriteOff", "id", data.CityLedgerWriteOffs}, {"entity", "id", data.CityLedgerAccounts},
		} {
			if err := numbered(n.key, n.list, n.field); err != nil {
				return err
			}
		}
		for _, raw := range data.Payments {
			var v map[string]any
			if err := json.Unmarshal(raw, &v); err != nil {
				return err
			}
			count("payment", number(text(v, "number"))-5000)
			count("groupPayment", number(text(v, "batch"))-2000)
		}
		count("link", int64(len(data.PaymentLinks)))
		for key, n := range counters {
			if _, err := q.Exec(ctx, `INSERT INTO billing.counters (key, n) VALUES ($1, $2)`, key, n+1); err != nil {
				return err
			}
		}
		orders := Orders{DB: d}
		for _, raw := range data.Orders {
			v, err := shifted(raw, shiftDays)
			if err != nil {
				return err
			}
			var o domain.Order
			if err := json.Unmarshal(mustJSON(v), &o); err != nil {
				return err
			}
			if err := orders.PutOrder(ctx, o); err != nil {
				return err
			}
		}
		for bookingID, dates := range data.NightsPosted {
			for i, date := range dates {
				dates[i] = clock.AddDays(date, shiftDays)
			}
			if err := store.SetNightPosts(ctx, bookingID, dates); err != nil {
				return err
			}
		}
		settings := map[string]json.RawMessage{command.SettingPaymentPolicy: data.PaymentPolicy, command.SettingShiftPolicy: data.ShiftPolicy, command.SettingTax: data.Tax}
		for key, raw := range settings {
			if len(raw) == 0 {
				continue
			}
			v, err := shifted(raw, shiftDays)
			if err != nil {
				return err
			}
			if err := store.PutSetting(ctx, key, v); err != nil {
				return err
			}
		}
		if data.BusinessDate != "" {
			return store.PutSetting(ctx, command.SettingBusinessDate, clock.AddDays(data.BusinessDate, shiftDays))
		}
		return nil
	})
}

func mustJSON(v any) []byte {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return raw
}
