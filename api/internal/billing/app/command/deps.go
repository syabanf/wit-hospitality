// Package command holds the billing context's write side: one handler per command. Each handler
// checks the permission and villa scope, takes the billing lock, loads what its rules read, applies
// them, saves, and appends its events and audit line in one transaction. Money facts go out as
// events for finance; billing books no cash entry and no journal.
package command

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Record tables.
const (
	Postings       = "postings"
	Payments       = "payments"
	Links          = "links"
	Audits         = "night_audits"
	Shifts         = "shifts"
	HandOvers      = "hand_overs"
	Codes          = "transaction_codes"
	Accounts       = "cl_accounts"
	Invoices       = "cl_invoices"
	LedgerPayments = "cl_payments"
	WriteOffs      = "cl_write_offs"
	CashAccounts   = "cash_accounts"
)

// Settings keys.
const (
	SettingPaymentPolicy = "payment_policy"
	SettingShiftPolicy   = "shift_policy"
	SettingTax           = "tax"
	SettingBusinessDate  = "business_date"
)

// Row is a record to save: its id, the stay and scope it belongs to, the key rules look it up by.
type Row struct {
	ID         string
	BookingID  string
	VillaID    string
	LocationID string
	Ref        string
	Doc        any
}

// Stored is a record read back with its scope.
type Stored struct {
	VillaID    string
	LocationID string
	Doc        json.RawMessage
}

// Place is where a unit sits.
type Place struct {
	UnitID       string
	UnitCode     string
	UnitName     string
	VillaID      string
	VillaName    string
	LocationID   string
	LocationName string
	// RoomType is the name of the unit's room type, "" for a unit in none; Group is the room type
	// as property publishes it, nil for none.
	RoomType string
	Group    json.RawMessage
}

// Store is the billing schema.
type Store interface {
	Lock(ctx context.Context) error
	Next(ctx context.Context, key string) (int64, error)
	Setting(ctx context.Context, key string) (json.RawMessage, error)
	PutSetting(ctx context.Context, key string, doc any) error
	Get(ctx context.Context, table, id, what string) (json.RawMessage, error)
	Put(ctx context.Context, table string, r Row) error
	All(ctx context.Context, table string) ([]Stored, error)
	ByBooking(ctx context.Context, table, bookingID string) ([]Stored, error)
	ByRef(ctx context.Context, table, ref string) ([]Stored, error)
	Stay(ctx context.Context, id string) (json.RawMessage, error)
	Stays(ctx context.Context, status string) ([]json.RawMessage, error)
	GroupStays(ctx context.Context, groupID string) ([]json.RawMessage, error)
	Group(ctx context.Context, id string) (json.RawMessage, error)
	Place(ctx context.Context, unitID string) (Place, error)
	// Account is billing's copy of an Airbnb account, nil when unknown.
	Account(ctx context.Context, id string) (json.RawMessage, error)
	// Requests is billing's copy of the service requests on a stay.
	Requests(ctx context.Context, bookingID string) ([]domain.Request, error)
	Villa(ctx context.Context, id string) (Place, error)
	NightPosts(ctx context.Context, bookingID string) ([]string, bool, error)
	SetNightPosts(ctx context.Context, bookingID string, dates []string) error
}

// CashAccount is the part of finance's CashAccount billing reads.
type CashAccount struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Kind       string  `json:"kind"`
	LocationID *string `json:"locationId"`
}

// Finance is the finance context as billing needs it. ARCHITECTURE.md, "Billing to finance
// events", describes each answer.
type Finance interface {
	// ApprovalStatus is the status of the entry finance made from the fact named ref.
	ApprovalStatus(ctx context.Context, ref string) (string, error)
	// AssertOpen refuses a date in a month finance closed.
	AssertOpen(ctx context.Context, date string) error
	CashAccounts(ctx context.Context) ([]CashAccount, error)
	// ShiftCash is the cash in and out finance holds on the shift's cashbox; ok is false when
	// finance does not answer, and billing counts its own cash payments instead.
	ShiftCash(ctx context.Context, shiftID, accountID string) (in, out int64, ok bool, err error)
}

// Guests names guests.
type Guests interface {
	Name(ctx context.Context, guestID string) (string, error)
}

// Orders reads the room service orders services owns.
type Orders interface {
	StayOrders(ctx context.Context, bookingID string) ([]domain.Order, error)
}

// Reservation closes a stay whose check-out link the guest paid.
type Reservation interface {
	CheckOut(ctx context.Context, p auth.Principal, bookingID string, details domain.Departure) error
}

// Roster says whether a cashier works today.
type Roster interface {
	Rostered(ctx context.Context, employeeID, date string) (bool, error)
}

// Deps is what every billing command needs.
type Deps struct {
	DB          *db.DB
	Store       Store
	Authz       rbac.Authorizer
	Audit       audit.Recorder
	Clock       clock.Clock
	Finance     Finance
	Guests      Guests
	Orders      Orders
	Reservation Reservation
	Roster      Roster
}

// Permission sets, from the application services' allow() calls.
var (
	bookingEdit    = []rbac.Need{{Module: "booking", Action: "edit"}}
	bookingPost    = []rbac.Need{{Module: "booking", Action: "post"}}
	paymentsCreate = []rbac.Need{{Module: "payments", Action: "create"}}
	paymentsEdit   = []rbac.Need{{Module: "payments", Action: "edit"}}
	financeCreate  = []rbac.Need{{Module: "finance", Action: "create"}}
	financeEdit    = []rbac.Need{{Module: "finance", Action: "edit"}}
	financeSubmit  = []rbac.Need{{Module: "finance", Action: "submit"}}
)

// Actors that stand in for nobody signed in: the guest on a public page, and the gateway.
var (
	GuestActor   = auth.Principal{UserID: "usr-guest", Name: "Guest", Role: "staff"}
	GatewayActor = auth.Principal{UserID: "usr-gateway", Name: "Payment gateway", Role: "admin"}
)

func (d Deps) record(ctx context.Context, p auth.Principal, l audit.Line) error {
	return d.Audit.Record(ctx, audit.Actor{ID: p.UserID, Name: p.Name, Role: string(p.Role)}, l)
}

func (d Deps) today() string { return clock.Today(d.Clock) }

func (d Deps) stamp() string { return clock.Stamp(d.Clock) }

// stampIn is the local stamp `hours` from now, as the mock's expiresAt.
func (d Deps) stampIn(hours float64) string {
	return d.Clock.Now().Add(time.Duration(hours * float64(time.Hour))).Format(clock.StampLayout)
}

func (d Deps) emit(ctx context.Context, eventType, aggregateType, aggregateID string, payload any) error {
	return outbox.Append(ctx, d.DB.Q(ctx), d.Clock.Now(), outbox.Event{Type: eventType, AggregateType: aggregateType, AggregateID: aggregateID, AggregateVersion: 1, Payload: payload})
}

func (d Deps) can(ctx context.Context, p auth.Principal, module, action string) (bool, error) {
	perms, err := d.Authz.Source.Permissions(ctx)
	if err != nil {
		return false, err
	}
	return rbac.Can(perms, p.Role, rbac.Module(module), rbac.Action(action)), nil
}

func decode[T any](raw json.RawMessage) (T, error) {
	var v T
	err := json.Unmarshal(raw, &v)
	return v, err
}

func get[T any](ctx context.Context, d Deps, table, id, what string) (T, error) {
	raw, err := d.Store.Get(ctx, table, id, what)
	if err != nil {
		var zero T
		return zero, err
	}
	return decode[T](raw)
}

func docs[T any](rows []Stored, err error) ([]T, error) {
	if err != nil {
		return nil, err
	}
	out := make([]T, 0, len(rows))
	for _, r := range rows {
		v, err := decode[T](r.Doc)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

func mustJSON(v any) json.RawMessage {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return raw
}

func ptr[T any](v T) *T { return &v }

// inScope refuses a villa outside the principal's scope.
func inScope(p auth.Principal, pl Place) error {
	if p.Scope().AllowedVilla(pl.VillaID, pl.LocationID) {
		return nil
	}
	name := pl.VillaName
	if name == "" {
		name = "This villa"
	}
	return errs.Forbidden(fmt.Sprintf("%s is outside the villas you work with.", name))
}

// Settings.

func (d Deps) policy(ctx context.Context) (domain.Policy, error) {
	raw, err := d.Store.Setting(ctx, SettingPaymentPolicy)
	if err != nil || raw == nil {
		return domain.DefaultPolicy, err
	}
	return decode[domain.Policy](raw)
}

func (d Deps) shiftPolicy(ctx context.Context) (domain.ShiftPolicy, error) {
	raw, err := d.Store.Setting(ctx, SettingShiftPolicy)
	if err != nil || raw == nil {
		return domain.DefaultShiftPolicy, err
	}
	return decode[domain.ShiftPolicy](raw)
}

func (d Deps) tax(ctx context.Context) (domain.TaxSettings, error) {
	raw, err := d.Store.Setting(ctx, SettingTax)
	if err != nil || raw == nil {
		return domain.DefaultTaxSettings(), err
	}
	return decode[domain.TaxSettings](raw)
}

func (d Deps) businessDate(ctx context.Context) (string, error) {
	raw, err := d.Store.Setting(ctx, SettingBusinessDate)
	if err != nil || raw == nil {
		return d.today(), err
	}
	return decode[string](raw)
}

func (d Deps) codes(ctx context.Context) ([]domain.TransactionCode, error) {
	list, err := docs[domain.TransactionCode](d.Store.All(ctx, Codes))
	if err == nil && len(list) == 0 {
		list = domain.DefaultTransactionCodes()
	}
	return list, err
}

// Stays.

// stayOf decodes a booking and lays the audit's posted nights over it: billing keeps them, and a
// stay reservation has not projected back yet still reads them.
func (d Deps) stayOf(ctx context.Context, raw json.RawMessage) (domain.Booking, error) {
	b, err := decode[domain.Booking](raw)
	if err != nil {
		return b, err
	}
	dates, ok, err := d.Store.NightPosts(ctx, b.ID)
	if ok {
		b.NightsPosted = &dates
	}
	return b, err
}

func (d Deps) stay(ctx context.Context, id string) (domain.Booking, error) {
	raw, err := d.Store.Stay(ctx, id)
	if err != nil {
		return domain.Booking{}, err
	}
	return d.stayOf(ctx, raw)
}

// stayInScope loads a stay with its place, refusing one outside the caller's scope.
func (d Deps) stayInScope(ctx context.Context, p auth.Principal, id string) (domain.Booking, Place, error) {
	b, err := d.stay(ctx, id)
	if err != nil {
		return b, Place{}, err
	}
	pl, err := d.Store.Place(ctx, b.UnitID)
	if err != nil {
		return b, pl, err
	}
	return b, pl, inScope(p, pl)
}

func (d Deps) group(ctx context.Context, id string) (*domain.Group, error) {
	if id == "" {
		return nil, nil
	}
	raw, err := d.Store.Group(ctx, id)
	if errs.HasCode(err, errs.CodeNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	g, err := decode[domain.Group](raw)
	return &g, err
}

func (d Deps) groupStays(ctx context.Context, groupID string) ([]domain.Booking, error) {
	raws, err := d.Store.GroupStays(ctx, groupID)
	if err != nil {
		return nil, err
	}
	out := make([]domain.Booking, 0, len(raws))
	for _, raw := range raws {
		b, err := d.stayOf(ctx, raw)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, nil
}

func (d Deps) payments(ctx context.Context) ([]domain.Payment, error) {
	return docs[domain.Payment](d.Store.All(ctx, Payments))
}

func (d Deps) stayPayments(ctx context.Context, bookingID string) ([]domain.Payment, error) {
	return docs[domain.Payment](d.Store.ByBooking(ctx, Payments, bookingID))
}

func (d Deps) postings(ctx context.Context, bookingID string) ([]domain.Posting, error) {
	return docs[domain.Posting](d.Store.ByBooking(ctx, Postings, bookingID))
}

func (d Deps) orders(ctx context.Context, bookingID string) ([]domain.Order, error) {
	if d.Orders == nil {
		return nil, nil
	}
	return d.Orders.StayOrders(ctx, bookingID)
}

// folio is the mock's folioOf: the stay's folio from billing's tables; a master-billed group carries
// the room lines unless whole.
func (d Deps) folio(ctx context.Context, b domain.Booking, whole bool) (domain.GuestFolio, error) {
	pays, err := d.payments(ctx)
	if err != nil {
		return domain.GuestFolio{}, err
	}
	return d.folioWith(ctx, b, pays, whole)
}

func (d Deps) folioWith(ctx context.Context, b domain.Booking, pays []domain.Payment, whole bool) (domain.GuestFolio, error) {
	postings, err := d.postings(ctx, b.ID)
	if err != nil {
		return domain.GuestFolio{}, err
	}
	orders, err := d.orders(ctx, b.ID)
	if err != nil {
		return domain.GuestFolio{}, err
	}
	tax, err := d.tax(ctx)
	if err != nil {
		return domain.GuestFolio{}, err
	}
	onMaster := false
	if !whole {
		g, err := d.group(ctx, b.BookingGroupID)
		if err != nil {
			return domain.GuestFolio{}, err
		}
		onMaster = g != nil && g.Billing == "master"
	}
	return domain.Folio(domain.FolioSources{Booking: b, Payments: pays, Orders: orders, Postings: postings, RoomOnMaster: onMaster, Tax: &tax}), nil
}

// Money on a stay.

func (d Deps) stayTotal(ctx context.Context, b domain.Booking) (int64, error) {
	tax, err := d.tax(ctx)
	if err != nil {
		return 0, err
	}
	return domain.StayTaxOf(b, &tax).Total, nil
}

// expected is expectedOf: what the villa expects for the room, Airbnb's fee off a payout.
func (d Deps) expected(ctx context.Context, b domain.Booking) (int64, error) {
	total, err := d.stayTotal(ctx, b)
	if b.Source == "airbnb" {
		total -= int64(b.AirbnbFee)
	}
	return total, err
}

// paid is paidOf: room money in and what moved to a city ledger account.
func (d Deps) paid(ctx context.Context, b domain.Booking) (int64, error) {
	pays, err := d.stayPayments(ctx, b.ID)
	if err != nil {
		return 0, err
	}
	postings, err := d.postings(ctx, b.ID)
	if err != nil {
		return 0, err
	}
	paid := domain.NetPaid(pays, b.ID)
	for _, p := range postings {
		if p.Kind == domain.KindTransfer && p.Part == domain.PartRoom {
			paid += p.Amount
		}
	}
	return paid, nil
}

// owed is expectedOf less paidOf.
func (d Deps) owed(ctx context.Context, b domain.Booking) (int64, error) {
	expected, err := d.expected(ctx, b)
	if err != nil {
		return 0, err
	}
	paid, err := d.paid(ctx, b)
	return expected - paid, err
}

// summary is syncBooking: what the booking reads as paid after a fact.
func (d Deps) summary(ctx context.Context, b domain.Booking) (int64, string, error) {
	total, err := d.stayTotal(ctx, b)
	if err != nil {
		return 0, "", err
	}
	paid, err := d.paid(ctx, b)
	if err != nil {
		return 0, "", err
	}
	if b.Source == "airbnb" {
		expected, err := d.expected(ctx, b)
		if err != nil {
			return 0, "", err
		}
		if paid >= expected {
			paid = total
		}
	}
	paid = max(0, paid)
	return paid, domain.SettledStatus(paid, total), nil
}

// pendingSettle is the settle link still waiting for the guest on a stay.
func (d Deps) pendingSettle(ctx context.Context, bookingID string) (*domain.PaymentLink, error) {
	links, err := docs[domain.PaymentLink](d.Store.ByBooking(ctx, Links, bookingID))
	if err != nil {
		return nil, err
	}
	for _, l := range links {
		if l.Status == "pending" && l.CheckOut != nil {
			return &l, nil
		}
	}
	return nil, nil
}

// guestName names the stay's guest; empty when guest does not answer.
func (d Deps) guestName(ctx context.Context, guestID string) string {
	if d.Guests == nil || guestID == "" {
		return ""
	}
	name, err := d.Guests.Name(ctx, guestID)
	if err != nil {
		return ""
	}
	return name
}

// gl is the account hint of a code.
func (d Deps) gl(ctx context.Context, code string) (string, error) {
	codes, err := d.codes(ctx)
	if err != nil {
		return "", err
	}
	return domain.CodeAccount(codes, code), nil
}
