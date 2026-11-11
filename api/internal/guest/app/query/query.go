// Package query holds the guest context's read side: the lists the console reads, filtered to the
// signed-in user's villa and location scope, the Immigration list per day and villa with its APOA
// export rows, and the answers the guest client gives other contexts.
package query

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/guest/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// ReadStore reads the guest schema's views.
type ReadStore interface {
	Guests(ctx context.Context) ([]domain.Guest, error)
	Guest(ctx context.Context, id string) (domain.Guest, error)
	Companions(ctx context.Context, s rbac.Scope) ([]domain.Companion, error)
	CompanionsOf(ctx context.Context, bookingID string) ([]domain.Companion, error)
	Reports(ctx context.Context, s rbac.Scope) ([]domain.ForeignReport, error)
	LostItems(ctx context.Context, s rbac.Scope) ([]domain.LostItem, error)
	Settings(ctx context.Context) (domain.LostFoundSettings, error)
	StartedStays(ctx context.Context, s rbac.Scope) ([]domain.StayPlace, error)
}

// Queries bundles the read handlers. It is also the in-process guest.Client.
type Queries struct {
	Store ReadStore
	Authz rbac.Authorizer
	Clock clock.Clock
}

func scope(ctx context.Context) (rbac.Scope, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return rbac.Scope{}, err
	}
	return p.Scope(), nil
}

// Guests is GET /guests: every profile, for any signed-in user. Profiles are shared across villas.
func (q Queries) Guests(ctx context.Context) ([]domain.Guest, error) {
	if _, err := auth.Require(ctx); err != nil {
		return nil, err
	}
	return q.Store.Guests(ctx)
}

// Duplicates is GET /guests/duplicates: profile pairs sharing an email, phone or document number.
func (q Queries) Duplicates(ctx context.Context) ([]domain.Duplicate, error) {
	list, err := q.Guests(ctx)
	if err != nil {
		return nil, err
	}
	return domain.FindDuplicates(list), nil
}

// Companions is GET /stay-companions.
func (q Queries) Companions(ctx context.Context) ([]domain.Companion, error) {
	s, err := scope(ctx)
	if err != nil {
		return nil, err
	}
	return q.Store.Companions(ctx, s)
}

// Reports is GET /foreign-reports.
func (q Queries) Reports(ctx context.Context) ([]domain.ForeignReport, error) {
	s, err := scope(ctx)
	if err != nil {
		return nil, err
	}
	return q.Store.Reports(ctx, s)
}

// LostItems is GET /lost-found.
func (q Queries) LostItems(ctx context.Context) ([]domain.LostItem, error) {
	s, err := scope(ctx)
	if err != nil {
		return nil, err
	}
	return q.Store.LostItems(ctx, s)
}

// Settings is GET /lost-found/settings.
func (q Queries) Settings(ctx context.Context) (domain.LostFoundSettings, error) {
	if _, err := auth.Require(ctx); err != nil {
		return domain.LostFoundSettings{}, err
	}
	return q.Store.Settings(ctx)
}

// ForeignStay is the stay part of a row on the Immigration list.
type ForeignStay struct {
	ID           string  `json:"id"`
	Code         string  `json:"code"`
	GuestID      string  `json:"guestId"`
	VillaID      string  `json:"villaId"`
	VillaName    string  `json:"villaName"`
	UnitCode     string  `json:"unitCode"`
	Status       string  `json:"status"`
	CheckIn      string  `json:"checkIn"`
	CheckOut     string  `json:"checkOut"`
	CheckedInOn  *string `json:"checkedInOn"`
	CheckedOutOn *string `json:"checkedOutOn"`
}

// ForeignPerson is a person's name and travel document.
type ForeignPerson struct {
	Name string `json:"name"`
	domain.TravelDocument
}

// ForeignRow is one foreign adult on one stay, with what Immigration still needs and whether the
// desk sent it.
type ForeignRow struct {
	Key      string                `json:"key"`
	PersonID string                `json:"personId"`
	Kind     string                `json:"kind"`
	Person   ForeignPerson         `json:"person"`
	Booking  ForeignStay           `json:"booking"`
	Address  string                `json:"address"`
	Missing  []string              `json:"missing"`
	Report   *domain.ForeignReport `json:"report"`
	DueAt    string                `json:"dueAt"`
	Overdue  bool                  `json:"overdue"`
	apoa     []string
}

// ForeignList is the Immigration list of one day.
type ForeignList struct {
	Date    string       `json:"date"`
	Columns []string     `json:"columns"`
	Rows    []ForeignRow `json:"rows"`
	Apoa    [][]string   `json:"apoa"`
	Today   string       `json:"today"`
}

// Foreign is GET /foreign-guests: who checked in on date or is in house that night, in villaID
// when given, with the APOA rows in the export's column order. It needs guest/view.
func (q Queries) Foreign(ctx context.Context, date, villaID string) (ForeignList, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return ForeignList{}, err
	}
	if err := q.Authz.Require(ctx, p.Role, rbac.Need{Module: "guest", Action: "view"}); err != nil {
		return ForeignList{}, err
	}
	today := clock.Today(q.Clock)
	if date == "" {
		date = today
	}
	stays, err := q.Store.StartedStays(ctx, p.Scope())
	if err != nil {
		return ForeignList{}, err
	}
	guests, err := q.Store.Guests(ctx)
	if err != nil {
		return ForeignList{}, err
	}
	reports, err := q.Store.Reports(ctx, p.Scope())
	if err != nil {
		return ForeignList{}, err
	}
	now := q.Clock.Now().Format("2006-01-02T15:04")
	out := ForeignList{Date: date, Columns: domain.ApoaColumns, Rows: []ForeignRow{}, Apoa: [][]string{}, Today: today}
	for _, s := range stays {
		inOn := s.CheckedIn()
		leave := s.CheckOut
		if s.Status == "checked_in" {
			leave = max(s.CheckOut, clock.AddDays(today, 1))
		} else if s.CheckedOutOn != nil {
			leave = *s.CheckedOutOn
		}
		if (villaID != "" && s.VillaID != villaID) || inOn > date || (inOn != date && leave <= date) {
			continue
		}
		rows, err := q.peopleOn(ctx, s, guests, reports, now)
		if err != nil {
			return ForeignList{}, err
		}
		out.Rows = append(out.Rows, rows...)
	}
	slices.SortStableFunc(out.Rows, func(a, b ForeignRow) int {
		ra, rb := a.Report != nil, b.Report != nil
		if ra != rb {
			if ra {
				return 1
			}
			return -1
		}
		if c := strings.Compare(a.Booking.Code, b.Booking.Code); c != 0 {
			return c
		}
		return strings.Compare(a.Kind, b.Kind)
	})
	for _, r := range out.Rows {
		out.Apoa = append(out.Apoa, r.apoa)
	}
	return out, nil
}

// peopleOn lists the foreign lead guest and foreign adult companions of a stay.
func (q Queries) peopleOn(ctx context.Context, s domain.StayPlace, guests []domain.Guest, reports []domain.ForeignReport, now string) ([]ForeignRow, error) {
	type person struct {
		id, kind string
		p        ForeignPerson
	}
	var people []person
	for _, g := range guests {
		if g.ID == s.GuestID {
			people = append(people, person{g.ID, "guest", ForeignPerson{Name: g.Name, TravelDocument: g.TravelDocument}})
		}
	}
	companions, err := q.Store.CompanionsOf(ctx, s.ID)
	if err != nil {
		return nil, err
	}
	for _, c := range companions {
		if c.Adult {
			people = append(people, person{c.ID, "companion", ForeignPerson{Name: c.Name, TravelDocument: c.TravelDocument}})
		}
	}
	stay := ForeignStay{ID: s.ID, Code: s.Code, GuestID: s.GuestID, VillaID: s.VillaID, VillaName: s.VillaName, UnitCode: s.UnitCode, Status: s.Status, CheckIn: s.CheckIn, CheckOut: s.CheckOut, CheckedInOn: s.CheckedInOn, CheckedOutOn: s.CheckedOutOn}
	place := fmt.Sprintf("%s, %s, %s", s.VillaName, s.LocationName, s.LocationArea)
	inOn := s.CheckedIn()
	var rows []ForeignRow
	for _, pp := range people {
		if !pp.p.IsForeign() {
			continue
		}
		var report *domain.ForeignReport
		for i := range reports {
			if reports[i].BookingID == s.ID && reports[i].PersonID == pp.id {
				report = &reports[i]
				break
			}
		}
		address := pp.p.AddressInIndonesia
		if address == "" {
			address = place
		}
		rows = append(rows, ForeignRow{
			Key: s.ID + ":" + pp.id, PersonID: pp.id, Kind: pp.kind, Person: pp.p, Booking: stay, Address: address,
			Missing: domain.ForeignDataMissing(pp.p.TravelDocument), Report: report,
			DueAt: domain.ReportDueAt(inOn, s.ArrivalTime), Overdue: report == nil && domain.ReportOverdue(inOn, s.ArrivalTime, now),
			apoa: domain.ApoaRow(pp.p.Name, pp.p.TravelDocument, domain.ApoaStay{CheckIn: inOn, CheckOut: s.CheckOut, Room: s.UnitCode, Address: address}),
		})
	}
	return rows, nil
}

// people lists the lead guest and every companion of a stay.
func (q Queries) people(ctx context.Context, stay guest.StayPeople) ([]domain.Person, error) {
	lead, err := q.Store.Guest(ctx, stay.GuestID)
	if err != nil {
		return nil, err
	}
	companions, err := q.Store.CompanionsOf(ctx, stay.BookingID)
	if err != nil {
		return nil, err
	}
	people := []domain.Person{{ID: lead.ID, Name: lead.Name, Adult: true, Doc: lead.TravelDocument}}
	for _, c := range companions {
		people = append(people, domain.Person{ID: c.ID, Name: c.Name, Adult: c.Adult, Doc: c.TravelDocument})
	}
	return people, nil
}

func (q Queries) on(stay guest.StayPeople) string {
	if stay.On != "" {
		return stay.On
	}
	return clock.Today(q.Clock)
}

// Registration answers guest.Client.Registration.
func (q Queries) Registration(ctx context.Context, stay guest.StayPeople) (guest.Registration, error) {
	people, err := q.people(ctx, stay)
	if err != nil {
		return guest.Registration{}, err
	}
	on := q.on(stay)
	out := guest.Registration{BookingID: stay.BookingID, People: []guest.RegisteredPerson{}}
	for i, p := range people {
		kind := "companion"
		if i == 0 {
			kind = "guest"
		}
		missing := []string{}
		if p.Adult {
			out.RegisteredAdults++
			missing = domain.ForeignDataMissing(p.Doc)
		}
		out.People = append(out.People, guest.RegisteredPerson{
			ID: p.ID, Name: p.Name, Kind: kind, Adult: p.Adult, Foreign: p.Doc.IsForeign(), Missing: missing,
			Expired: p.Adult && p.Doc.IsForeign() && domain.DocumentExpired(p.Doc, on),
		})
	}
	out.Unregistered = domain.UnregisteredAdults(stay.Adults, out.RegisteredAdults)
	return out, nil
}

// CheckRegistration answers guest.Client.CheckRegistration.
func (q Queries) CheckRegistration(ctx context.Context, stay guest.StayPeople) error {
	people, err := q.people(ctx, stay)
	if err != nil {
		return err
	}
	return domain.CheckInReady(people, q.on(stay))
}

// Guest answers guest.Client.Guest.
func (q Queries) Guest(ctx context.Context, id string) (guest.Guest, error) {
	g, err := q.Store.Guest(ctx, id)
	if err != nil {
		return guest.Guest{}, err
	}
	return g.Summary(), nil
}

// BlacklistStatus answers guest.Client.BlacklistStatus.
func (q Queries) BlacklistStatus(ctx context.Context, id string) (guest.BlacklistStatus, error) {
	s, err := q.Guest(ctx, id)
	if err != nil {
		return guest.BlacklistStatus{}, err
	}
	return guest.BlacklistStatus{GuestID: s.ID, Name: s.Name, Blacklisted: s.Blacklist != nil, Blacklist: s.Blacklist}, nil
}

var _ guest.Client = Queries{}
