package command

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

// NewWholeVilla is POST /whole-villa-bookings: one guest party renting every villa unit of a villa.
type NewWholeVilla struct {
	VillaID  string             `json:"villaId"`
	GuestID  *string            `json:"guestId"`
	NewGuest json.RawMessage    `json:"newGuest"`
	CheckIn  string             `json:"checkIn"`
	CheckOut string             `json:"checkOut"`
	Adults   float64            `json:"adults"`
	Children float64            `json:"children"`
	Source   string             `json:"source"`
	Note     string             `json:"note"`
	Price    *domain.WholePrice `json:"price"`
}

// CreateWholeVilla books a whole villa as a booking group with wholeVilla set, one confirmed stay
// per villa unit that is not inactive, on a master folio, through the group booking path. The
// nightly price is the staff price when given (the discount limit applies as on any direct price
// change), else the villa's whole nightly rate, each shared evenly over the stays with the
// remainder on the first; with neither, each unit keeps its own price. It needs booking/create.
type CreateWholeVilla struct{ Deps }

// Handle books the villa and returns the group.
func (h CreateWholeVilla) Handle(ctx context.Context, p auth.Principal, in NewWholeVilla) (domain.BookingGroup, error) {
	var g domain.BookingGroup
	if err := h.Authz.Require(ctx, p.Role, bookingCreate...); err != nil {
		return g, err
	}
	hasGuest := str(in.GuestID) != "" || present(in.NewGuest)
	if err := domain.WholeVillaFields(in.VillaID, hasGuest, in.CheckIn, in.CheckOut, in.Adults, in.Children, in.Source, in.Price).Err(); err != nil {
		return g, err
	}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		w, err := h.load(ctx, in.CheckIn, in.CheckOut)
		if err != nil {
			return err
		}
		villa, ok := w.cat.Villa(in.VillaID)
		if !ok {
			return errs.NotFound("villa", in.VillaID)
		}
		if err := inScope(p, villa); err != nil {
			return err
		}
		units := domain.WholeVillaUnits(w.cat, villa.ID)
		if err := domain.CheckWholeRental(villa, units); err != nil {
			return err
		}
		if err := domain.CheckWholeVillaFree(villa, units, in.CheckIn, in.CheckOut, w.avail.Bookings, w.cat.Blocks); err != nil {
			return err
		}
		adults, children := int(in.Adults), int(in.Children)
		if room, ok := domain.WholeVillaCapacity(villa, units); ok {
			if err := room.Check(adults, children); err != nil {
				return err
			}
		}
		lead := str(in.GuestID)
		if lead == "" {
			if lead, err = h.Clients.Guests.Create(ctx, p, in.NewGuest); err != nil {
				return err
			}
		}
		n, err := h.Repo.Next(ctx, "bookingGroup")
		if err != nil {
			return err
		}
		g = domain.BookingGroup{ID: fmt.Sprintf("bg-%d", n), Code: fmt.Sprintf("GRP-%d", 1000+n), Name: "Whole " + villa.Name, LeadGuestID: lead,
			VillaIDs: []string{}, Source: in.Source, Billing: "master", Note: strings.TrimSpace(in.Note), CreatedBy: p.Name, CreatedAt: h.stamp(), WholeVilla: true}
		stays, err := h.wholeVillaStays(ctx, p, &w, g, villa, units, in)
		if err != nil {
			return err
		}
		if err := h.saveGroup(ctx, &g, w.cat, true); err != nil {
			return err
		}
		codes := make([]string, len(stays))
		for i, b := range stays {
			codes[i] = b.Code
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "booking-group", EntityID: g.Code,
			Summary: fmt.Sprintf("Booked %s as %s, %s to %s: %s", villa.Name, g.Code, in.CheckIn, in.CheckOut, strings.Join(codes, ", "))})
	})
	return g, err
}

// wholeVillaStays books one confirmed stay per unit with its share of the party and the price.
func (d Deps) wholeVillaStays(ctx context.Context, p auth.Principal, w *world, g domain.BookingGroup, villa domain.Villa, units []domain.Unit, in NewWholeVilla) ([]domain.Booking, error) {
	var list, staff []int64
	if villa.WholeNightlyRate > 0 {
		list = domain.SplitNightly(villa.WholeNightlyRate, len(units))
	}
	if in.Price != nil {
		staff = domain.SplitNightly(int64(in.Price.Nightly), len(units))
	}
	party := domain.SpreadParty(units, int(in.Adults), int(in.Children))
	var out []domain.Booking
	for i, u := range units {
		unitID := u.ID
		stay := NewBooking{GuestID: &g.LeadGuestID, UnitID: &unitID, Source: domain.Direct, CheckIn: in.CheckIn, CheckOut: in.CheckOut, Confirm: true}
		extra := stayExtra{groupID: g.ID, partySize: party[i]}
		if list != nil {
			extra.listRate = &list[i]
		}
		if staff != nil {
			rate := float64(staff[i])
			stay.Price = &domain.PriceChange{RateOverride: &rate, Reason: strings.TrimSpace(in.Price.Reason)}
		}
		b, err := d.createStay(ctx, p, w, stay, extra)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, nil
}
