// Package command holds the channel context's write side: one handler per command. Each handler
// checks the permission and villa scope, loads, applies the domain rules, saves, and appends its
// events and audit line in one transaction.
package command

import (
	"context"
	"fmt"
	"maps"

	"github.com/syabanf/wit-hospitality/api/internal/channel"
	"github.com/syabanf/wit-hospitality/api/internal/channel/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Repository is the write model on the channel schema. Loads lock the row for the transaction.
type Repository interface {
	Account(ctx context.Context, id string) (domain.Account, error)
	AccountNameTaken(ctx context.Context, name, excludeID string) (bool, error)
	CountAccounts(ctx context.Context) (int, error)
	InsertAccount(ctx context.Context, a *domain.Account) error
	UpdateAccount(ctx context.Context, a *domain.Account) error

	Listing(ctx context.Context, id string) (domain.Listing, error)
	ListingUnitTaken(ctx context.Context, unitID, excludeID string) (bool, error)
	ListingAirbnbIDTaken(ctx context.Context, airbnbID, excludeID string) (bool, error)
	ListingIDTaken(ctx context.Context, id string) (bool, error)
	InsertListing(ctx context.Context, l *domain.Listing) error
	UpdateListing(ctx context.Context, l *domain.Listing) error

	Enquiry(ctx context.Context, id string) (domain.Enquiry, error)
	NextEnquirySeq(ctx context.Context) (int64, error)
	InsertEnquiry(ctx context.Context, e *domain.Enquiry) error
	UpdateEnquiry(ctx context.Context, e *domain.Enquiry) error
}

// Catalog reads the property records channel projects into its own schema.
type Catalog interface {
	// Unit returns the unit, or nil when property has not published it.
	Unit(ctx context.Context, id string) (*domain.Unit, error)
	Villa(ctx context.Context, id string) (*domain.Villa, error)
	// GroupVilla returns the villa of a room type, empty when unknown.
	GroupVilla(ctx context.Context, groupID string) (string, error)
	// VillaTakesStays reports a unit of the villa (and room type, when given) that is not inactive.
	VillaTakesStays(ctx context.Context, villaID string, groupID *string) (bool, error)
}

// Bookings answers what channel needs to know about bookings, which reservation owns: the code of
// the booking an enquiry became. adapters/sources.None answers until reservation is wired in.
type Bookings interface {
	BookingCode(ctx context.Context, id string) (string, bool, error)
}

// Deps is what every channel command needs.
type Deps struct {
	DB       *db.DB
	Repo     Repository
	Catalog  Catalog
	Bookings Bookings
	Authz    rbac.Authorizer
	Audit    audit.Recorder
	Clock    clock.Clock
}

// Permission sets, from the Airbnb pages' actions; the TypeScript adapter checks only the price
// edit (allow('airbnb', 'edit')), the API checks every write.
var (
	airbnbCreate = []rbac.Need{{Module: "airbnb", Action: "create"}}
	airbnbEdit   = []rbac.Need{{Module: "airbnb", Action: "edit"}}
)

// GuestActor is who the audit names for a guest writing from the public website.
var GuestActor = audit.Actor{ID: "usr-guest", Name: "Guest", Role: "staff"}

func actorOf(p auth.Principal) audit.Actor {
	return audit.Actor{ID: p.UserID, Name: p.Name, Role: string(p.Role)}
}

// allowEnquiries is the enquiry adapter's allow(): booking view or edit, in its own words.
func (d Deps) allowEnquiries(ctx context.Context, p auth.Principal, action rbac.Action) error {
	perms, err := d.Authz.Source.Permissions(ctx)
	if err != nil {
		return fmt.Errorf("load permissions: %w", err)
	}
	if rbac.Can(perms, p.Role, "booking", action) {
		return nil
	}
	return errs.Forbidden(fmt.Sprintf("%s cannot %s web enquiries.", rbac.RoleLabel[p.Role], action))
}

// unitInScope loads the unit from the projected catalog and refuses one outside the scope.
func (d Deps) unitInScope(ctx context.Context, p auth.Principal, unitID string) (domain.Unit, error) {
	u, err := d.Catalog.Unit(ctx, unitID)
	if err != nil {
		return domain.Unit{}, err
	}
	if u == nil {
		return domain.Unit{}, errs.NotFound("unit", unitID)
	}
	if !p.Scope().AllowedVilla(u.VillaID, u.LocationID) {
		return domain.Unit{}, errs.Forbidden(fmt.Sprintf("%s is outside the villas you work with.", u.Code))
	}
	return *u, nil
}

func (d Deps) emit(ctx context.Context, eventType, aggregateType, aggregateID string, version int64, payload any) error {
	return outbox.Append(ctx, d.DB.Q(ctx), d.Clock.Now(), outbox.Event{Type: eventType, AggregateType: aggregateType, AggregateID: aggregateID, AggregateVersion: version, Payload: payload})
}

func (d Deps) record(ctx context.Context, actor audit.Actor, l audit.Line) error {
	return d.Audit.Record(ctx, actor, l)
}

func accountState(a domain.Account) channel.Account {
	return channel.Account{ID: a.ID, Name: a.Name, Email: a.Email, Status: a.Status, Slot: a.Slot}
}

// ListingState is the published state of a listing.
func ListingState(l domain.Listing) channel.Listing {
	return channel.Listing{ID: l.ID, AccountID: l.AccountID, UnitID: l.UnitID, Title: l.Title, AirbnbID: l.AirbnbID, Status: l.Status, DateRates: maps.Clone(l.DateRates)}
}

// EnquiryState is the published state of an enquiry, without the guest's contact details.
func EnquiryState(e domain.Enquiry) channel.Enquiry {
	return channel.Enquiry{ID: e.ID, Number: e.Number, Topic: e.Topic, VillaID: e.VillaID, GroupID: e.GroupID, CheckIn: e.CheckIn, CheckOut: e.CheckOut, Guests: e.Guests, Status: e.Status, BookingID: e.BookingID, CreatedOn: e.CreatedOn}
}

func (d Deps) accountEvent(ctx context.Context, eventType string, a domain.Account) error {
	return d.emit(ctx, eventType, "airbnb_account", a.ID, a.Version, channel.AccountEvent{Account: accountState(a)})
}

func (d Deps) listingEvent(ctx context.Context, eventType string, l domain.Listing, u domain.Unit) error {
	return d.emit(ctx, eventType, "listing", l.ID, l.Version, channel.ListingEvent{Listing: ListingState(l), VillaID: u.VillaID, LocationID: u.LocationID})
}

func (d Deps) enquiryEvent(ctx context.Context, eventType string, e domain.Enquiry) error {
	return d.emit(ctx, eventType, "enquiry", e.ID, e.Version, channel.EnquiryEvent{Enquiry: EnquiryState(e)})
}
