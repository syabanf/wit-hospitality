// Package command holds the services context's write side: one handler per command. Each handler
// checks the permission and villa scope, loads with a row lock, applies the domain rules, saves
// with a version check, and appends its events and audit line in one transaction.
package command

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	"github.com/syabanf/wit-hospitality/api/internal/services/domain"
)

// Repository is the write model on the services schema. Loads lock the row for the transaction.
type Repository interface {
	Next(ctx context.Context, key string) (int64, error)

	Partner(ctx context.Context, id string) (domain.ServicePartner, error)
	InsertPartner(ctx context.Context, p *domain.ServicePartner) error
	UpdatePartner(ctx context.Context, p *domain.ServicePartner) error

	MenuItem(ctx context.Context, id string) (domain.MenuItem, error)
	// ActiveMenu lists a villa's items on sale, oldest first.
	ActiveMenu(ctx context.Context, villaID string) ([]domain.MenuItem, error)
	InsertMenuItem(ctx context.Context, m *domain.MenuItem) error
	UpdateMenuItem(ctx context.Context, m *domain.MenuItem) error

	Order(ctx context.Context, id string) (domain.ServiceOrder, error)
	InsertOrder(ctx context.Context, o *domain.ServiceOrder) error
	UpdateOrder(ctx context.Context, o *domain.ServiceOrder) error
	// StayOrders lists a stay's orders, oldest first.
	StayOrders(ctx context.Context, bookingID string) ([]domain.ServiceOrder, error)
	// SaveBill keeps finance's answer on a partner bill unless a newer one is stored.
	SaveBill(ctx context.Context, orderID string, b domain.CostBill) error
	// Bills lists the partner bills finance wrote for an order.
	Bills(ctx context.Context, orderID string) ([]domain.CostBill, error)

	Request(ctx context.Context, id string) (domain.ServiceRequest, error)
	InsertRequest(ctx context.Context, r *domain.ServiceRequest, villaID string) error
	UpdateRequest(ctx context.Context, r *domain.ServiceRequest, villaID string) error
}

// Catalog reads services' copy of the property catalog.
type Catalog interface {
	Villa(ctx context.Context, id string) (domain.Villa, bool, error)
	Place(ctx context.Context, unitID string) (domain.Place, bool, error)
	Units(ctx context.Context) ([]domain.Unit, error)
}

// Guests is the guest context as the QR page needs it.
type Guests interface {
	// Name returns the guest's full name, "" when unknown.
	Name(ctx context.Context, guestID string) (string, error)
}

// Payments is what billing knows of a stay's room service money.
type Payments struct {
	// Status is each payment's status by payment id (paid, pending, failed, ...).
	Status map[string]string
	// Rebated is what rebates and transfers took off each order, by order id.
	Rebated map[string]int64
	// PayToken is the open gateway link for the stay's room service, "" when none.
	PayToken string
}

// Billing is the billing context as services needs it. Billing owns payments, links, the business
// date and the payment policy.
type Billing interface {
	Payments(ctx context.Context, bookingID string) (Payments, error)
	BusinessDate(ctx context.Context) (string, error)
	DiscountLimitPct(ctx context.Context) (float64, error)
	// PayOrders opens (or returns the open) QRIS link for the delivered, unpaid orders of a stay.
	PayOrders(ctx context.Context, stay reservation.Stay, orders []domain.ServiceOrder, amount int64, payer string) (json.RawMessage, error)
}

// CodeNotAvailable answers a call that needs a context this deployment does not run yet.
const CodeNotAvailable = "NOT_AVAILABLE"

// NotAvailable is the refusal a client returns for a context that is not built yet.
func NotAvailable(what string) error {
	return errs.Newf(CodeNotAvailable, "%s is not available in this API yet.", what)
}

// DefaultDiscountLimitPct is DEFAULT_PAYMENT_POLICY.discountLimitPct.
const DefaultDiscountLimitPct = 10

// Deps is what every services command needs.
type Deps struct {
	DB      *db.DB
	Repo    Repository
	Catalog Catalog
	Stays   reservation.Stays
	Guests  Guests
	Billing Billing
	Authz   rbac.Authorizer
	Audit   audit.Recorder
	Clock   clock.Clock
}

// Permission sets the commands check, from the allow() calls in services.ts. The console's
// service requests check nothing; the API asks services/create and services/edit there.
var (
	servicesCreate = []rbac.Need{{Module: "services", Action: "create"}}
	servicesEdit   = []rbac.Need{{Module: "services", Action: "edit"}}
)

// guestActor is how the audit trail and the order history name a guest ordering from the QR card.
var guestActor = auth.Principal{UserID: "usr-guest", Name: "Guest", Role: "staff"}

func (d Deps) record(ctx context.Context, p auth.Principal, l audit.Line) error {
	return d.Audit.Record(ctx, audit.Actor{ID: p.UserID, Name: p.Name, Role: string(p.Role)}, l)
}

func (d Deps) today() string { return clock.Today(d.Clock) }

func (d Deps) stamp() string { return clock.Stamp(d.Clock) }

func (d Deps) minute() int {
	now := d.Clock.Now()
	return now.Hour()*60 + now.Minute()
}

func (d Deps) emit(ctx context.Context, eventType, aggregateType, aggregateID string, version int64, payload any) error {
	return outbox.Append(ctx, d.DB.Q(ctx), d.Clock.Now(), outbox.Event{Type: eventType, AggregateType: aggregateType, AggregateID: aggregateID, AggregateVersion: version, Payload: payload})
}

func (d Deps) can(ctx context.Context, p auth.Principal, module rbac.Module, action rbac.Action) (bool, error) {
	perms, err := d.Authz.Source.Permissions(ctx)
	if err != nil {
		return false, err
	}
	return rbac.Can(perms, p.Role, module, action), nil
}

// inScope refuses a villa outside the principal's villa or location scope.
func inScope(p auth.Principal, v domain.Villa) error {
	if p.Scope().AllowedVilla(v.ID, v.LocationID) {
		return nil
	}
	return errs.Forbidden(fmt.Sprintf("%s is outside the villas you work with.", v.Name))
}

// place finds where a unit sits; NOT_FOUND for a unit services has never seen.
func (d Deps) place(ctx context.Context, unitID string) (domain.Place, error) {
	pl, ok, err := d.Catalog.Place(ctx, unitID)
	if err != nil {
		return pl, err
	}
	if !ok {
		return pl, errs.NotFound("unit", unitID)
	}
	return pl, nil
}

// payments reads billing's view of a stay. Without billing, an order that carries a payment id
// (the seed's paid orders) reads as paid and nothing is rebated or on a link.
func (d Deps) payments(ctx context.Context, bookingID string) (func(*string) string, Payments, error) {
	pm, err := d.Billing.Payments(ctx, bookingID)
	if errs.HasCode(err, CodeNotAvailable) {
		return func(id *string) string {
			if id != nil {
				return "paid"
			}
			return ""
		}, Payments{}, nil
	}
	if err != nil {
		return nil, pm, err
	}
	return func(id *string) string {
		if id == nil {
			return ""
		}
		return pm.Status[*id]
	}, pm, nil
}

func mustJSON(v any) json.RawMessage {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return raw
}
