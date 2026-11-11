// Package command holds the messaging context's write side: sending and resending, the settings,
// the provider's progress and the triggers. Each handler checks the permission and scope, applies
// the domain rules and saves with its event and audit line in one transaction.
package command

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/messaging"
	"github.com/syabanf/wit-hospitality/api/internal/messaging/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Store is the write model on the messaging schema plus its copies of stays, guests, the catalog
// and payment links.
type Store interface {
	Next(ctx context.Context, key string) (int64, error)
	// LockSweep serialises the provider sweep and the time triggers.
	LockSweep(ctx context.Context) error

	Settings(ctx context.Context) (domain.Settings, int64, error)
	SaveSettings(ctx context.Context, s domain.Settings, version int64) (int64, error)

	Message(ctx context.Context, id string) (domain.Message, error)
	InsertMessage(ctx context.Context, m *domain.Message, villaID string) error
	UpdateMessage(ctx context.Context, m *domain.Message) error
	// Moving lists the messages the provider may still move on: queued and sent.
	Moving(ctx context.Context) ([]domain.Message, error)
	// Triggered reports whether a trigger already sent the template for the stay.
	Triggered(ctx context.Context, bookingID, key string) (bool, error)

	Stay(ctx context.Context, id string) (domain.Stay, error)
	StayByInvoiceToken(ctx context.Context, token string) (*domain.Stay, error)
	Stays(ctx context.Context) ([]domain.Stay, error)
	Guest(ctx context.Context, id string) (domain.Guest, error)
	Place(ctx context.Context, unitID string) (domain.Place, error)
	PendingLink(ctx context.Context, bookingID string) (*messaging.PaymentLink, error)
}

// Receipt is the provider's answer to a send: queued, sent or failed with its error.
type Receipt struct {
	Status string
	Error  string
}

// Provider hands messages to a WhatsApp gateway or a mail server.
type Provider interface {
	Send(ctx context.Context, m domain.Message) (Receipt, error)
	// Track is the status a message has reached at now; a gateway that reports by webhook keeps it.
	Track(m domain.Message, now string) string
}

// Billing renders the stay invoice behind an e-invoice link.
type Billing interface {
	Invoice(ctx context.Context, bookingID string) (json.RawMessage, error)
}

// CodeNotAvailable answers a call that needs a context this deployment does not run yet.
const CodeNotAvailable = "NOT_AVAILABLE"

// NotAvailable is the refusal a client returns for a context that is not built yet.
func NotAvailable(what string) error {
	return errs.Newf(CodeNotAvailable, "%s is not available in this API yet.", what)
}

// Deps is what every messaging command needs.
type Deps struct {
	DB       *db.DB
	Store    Store
	Provider Provider
	Billing  Billing
	Authz    rbac.Authorizer
	Audit    audit.Recorder
	Clock    clock.Clock
}

func (d Deps) now() string { return clock.Stamp(d.Clock) }

func (d Deps) record(ctx context.Context, p auth.Principal, l audit.Line) error {
	return d.Audit.Record(ctx, audit.Actor{ID: p.UserID, Name: p.Name, Role: string(p.Role)}, l)
}

func (d Deps) emit(ctx context.Context, m domain.Message, villaID string) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return outbox.Append(ctx, d.DB.Q(ctx), d.Clock.Now(), outbox.Event{Type: messaging.EventMessageSaved, AggregateType: "message", AggregateID: m.ID,
		AggregateVersion: m.Version, Payload: messaging.MessageSaved{ID: m.ID, VillaID: villaID, Data: data}})
}

// sender is the service's allow('booking', 'edit'), which also covers the mock's assertSender.
func (d Deps) sender(ctx context.Context, p auth.Principal) error {
	return d.Authz.Require(ctx, p.Role, rbac.Need{Module: "booking", Action: "edit"})
}

// stayInScope loads a stay and its place, refusing one outside the caller's scope.
func (d Deps) stayInScope(ctx context.Context, p auth.Principal, id string) (domain.Stay, domain.Place, error) {
	b, err := d.Store.Stay(ctx, id)
	if err != nil {
		return b, domain.Place{}, err
	}
	pl, err := d.Store.Place(ctx, b.UnitID)
	if err != nil {
		return b, pl, err
	}
	if !p.Scope().AllowedVilla(pl.VillaID, pl.LocationID) {
		return b, pl, errs.Forbidden(pl.VillaName + " is outside the villas you work with.")
	}
	return b, pl, nil
}

// fields are what a send may set over the template's defaults.
type fields struct {
	channel  string
	language string
	body     *string
	vars     domain.Vars
}

// varsFor is the mock's varsFor plus the link a template carries when the caller gave none.
func (d Deps) varsFor(ctx context.Context, b domain.Stay, pl domain.Place, g domain.Guest, s domain.Settings, key string) (domain.Vars, error) {
	unit := pl.GroupName
	if b.UnitAssigned {
		unit = pl.UnitCode
	}
	wifi, ok := s.Wifi[pl.VillaID]
	if !ok {
		wifi = "ask the front desk"
	}
	v := domain.Vars{"guest": domain.FirstName(g.Name), "villa": pl.VillaName, "unit": unit, "code": b.Code, "checkIn": b.CheckIn, "checkOut": b.CheckOut, "wifi": wifi}
	switch key {
	case "pre_arrival":
		v["link"] = domain.CheckinURL(b.ID)
	case "post_stay":
		v["link"] = domain.InvoiceURL(b.ID)
	case "payment_link":
		link, err := d.Store.PendingLink(ctx, b.ID)
		if err != nil {
			return v, err
		}
		if link != nil {
			v["link"], v["amount"] = domain.PayURL(link.Token), link.Amount
		}
	}
	return v, nil
}

// queue is the mock's queue: renders the template or the free text for the stay's guest, hands it
// to the provider and saves it with its event. actor nil is a trigger.
func (d Deps) queue(ctx context.Context, b domain.Stay, key *string, f fields, actor *auth.Principal) (domain.Message, error) {
	var m domain.Message
	s, _, err := d.Store.Settings(ctx)
	if err != nil {
		return m, err
	}
	g, err := d.Store.Guest(ctx, b.GuestID)
	if err != nil {
		return m, err
	}
	pl, err := d.Store.Place(ctx, b.UnitID)
	if err != nil {
		return m, err
	}
	var t domain.Template
	hasTemplate := false
	k := ""
	if key != nil {
		k = *key
		t, hasTemplate = s.Template(k)
	}
	channel := f.channel
	if channel == "" {
		channel = domain.WhatsApp
		if hasTemplate {
			channel = t.Channel
		}
	}
	language := f.language
	if language == "" {
		language = domain.LanguageFor(g.Nationality)
	}
	vars, err := d.varsFor(ctx, b, pl, g, s, k)
	if err != nil {
		return m, err
	}
	for name, v := range f.vars {
		vars[name] = v
	}
	n, err := d.Store.Next(ctx, "message")
	if err != nil {
		return m, err
	}
	m.ID, m.Number = domain.MessageNumber(n)
	m.BookingID, m.GuestID, m.To, m.Channel, m.TemplateKey, m.Language = b.ID, g.ID, domain.AddressFor(g.Phone, g.Email, channel), channel, key, language
	body := ""
	if hasTemplate {
		m.Subject = domain.Render(t.Subject[language], vars)
		body = t.Body[language]
	}
	if f.body != nil {
		body = *f.body
	}
	m.Body = domain.Render(body, vars)
	m.SentBy = domain.SystemSender
	if actor != nil {
		m.SentBy, m.SentByID = actor.Name, &actor.UserID
	}
	if err := d.deliver(ctx, &m); err != nil {
		return m, err
	}
	if err := d.Store.InsertMessage(ctx, &m, pl.VillaID); err != nil {
		return m, err
	}
	return m, d.emit(ctx, m, pl.VillaID)
}

// deliver stamps the attempt and hands a message with an address to the provider.
func (d Deps) deliver(ctx context.Context, m *domain.Message) error {
	now := d.now()
	domain.Deliver(m, now)
	if m.Status != domain.Queued {
		return nil
	}
	r, err := d.Provider.Send(ctx, *m)
	if err != nil {
		return err
	}
	switch r.Status {
	case domain.Sent:
		m.Status, m.SentAt = domain.Sent, &now
	case domain.Failed:
		m.Status, m.FailedAt, m.Error = domain.Failed, &now, r.Error
	}
	return nil
}

// fire is the mock's fire: a trigger sends once per stay and template, and only while its template
// is switched on. once false repeats it (payment links and receipts).
func (d Deps) fire(ctx context.Context, b domain.Stay, key string, vars domain.Vars, once bool) error {
	s, _, err := d.Store.Settings(ctx)
	if err != nil {
		return err
	}
	if t, ok := s.Template(key); !ok || !t.Enabled {
		return nil
	}
	if once {
		sent, err := d.Store.Triggered(ctx, b.ID, key)
		if err != nil || sent {
			return err
		}
	}
	_, err = d.queue(ctx, b, &key, fields{vars: vars}, nil)
	return err
}
