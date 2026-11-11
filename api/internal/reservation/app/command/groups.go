package command

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

// NewGroup is NewBookingGroup. The deposit is taken by billing after the stays exist, in the same
// transaction, so a refused deposit books nothing.
type NewGroup struct {
	Name              string                  `json:"name"`
	GuestID           *string                 `json:"guestId"`
	NewGuest          json.RawMessage         `json:"newGuest"`
	Source            string                  `json:"source"`
	Billing           string                  `json:"billing"`
	Stays             []domain.GroupStayInput `json:"stays"`
	Discount          *domain.GroupDiscount   `json:"discount"`
	Note              string                  `json:"note"`
	Confirm           bool                    `json:"confirm"`
	Deposit           json.RawMessage         `json:"deposit"`
	Override          *domain.Override        `json:"override"`
	CityLedger        json.RawMessage         `json:"cityLedger"`
	BlacklistOverride string                  `json:"blacklistOverride"`
}

// depositInput is what the group service checks of a deposit before booking.
type depositInput struct {
	Amount    float64 `json:"amount"`
	Method    string  `json:"method"`
	Reference string  `json:"reference"`
}

// GroupCreated is the answer of a new group.
type GroupCreated struct {
	Group domain.BookingGroup `json:"group"`
	Link  json.RawMessage     `json:"link"`
}

func (d Deps) assertAllFree(w world, stays []domain.GroupStayInput) error {
	clashes := domain.GroupClashes(w.cat, stays, w.avail.Bookings, w.cat.Blocks, func(groupID string) int { return domain.OverbookLimit(w.avail.Policies, groupID) })
	if len(clashes) > 0 {
		return domain.ErrGroupUnavailable(clashes)
	}
	return nil
}

// stayRange is the span every stay of a group covers, for loading what holds the units.
func stayRange(stays []domain.GroupStayInput) (string, string) {
	from, to := "", ""
	for _, s := range stays {
		if from == "" || s.CheckIn < from {
			from = s.CheckIn
		}
		if s.CheckOut > to {
			to = s.CheckOut
		}
	}
	return from, to
}

// overrides is what a group passes on to each stay.
type overrides struct {
	restriction *domain.Override
	blacklist   string
}

// addStays books each stay as a direct booking in the lead's name, with the group discount where
// the stay has none of its own.
func (d Deps) addStays(ctx context.Context, p auth.Principal, w *world, g domain.BookingGroup, stays []domain.GroupStayInput, confirm bool, o overrides) ([]domain.Booking, error) {
	var out []domain.Booking
	for _, s := range stays {
		in := NewBooking{GuestID: &g.LeadGuestID, UnitID: s.UnitID, Source: domain.Direct, CheckIn: s.CheckIn, CheckOut: s.CheckOut,
			Price: domain.StayPriceChange(s.Price, g.Discount), Confirm: confirm, Override: o.restriction, BlacklistOverride: o.blacklist}
		if s.Unit() == "" {
			in.UnitID, in.GroupID = nil, s.RoomTypeID
		}
		b, err := d.createStay(ctx, p, w, in, stayExtra{groupID: g.ID, partySize: &domain.PartySize{Adults: int(s.Adults), Children: int(s.Children)}})
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, nil
}

// saveGroup refreshes the villas from the stays, writes the group and appends group.saved.
func (d Deps) saveGroup(ctx context.Context, g *domain.BookingGroup, c domain.Catalog, insert bool) error {
	stays, err := d.Repo.GroupStays(ctx, g.ID)
	if err != nil {
		return err
	}
	g.VillaIDs = []string{}
	var villas []domain.Villa
	for _, b := range stays {
		u, _ := c.Unit(b.UnitID)
		if !slices.Contains(g.VillaIDs, u.VillaID) {
			g.VillaIDs = append(g.VillaIDs, u.VillaID)
			v, _ := c.Villa(u.VillaID)
			villas = append(villas, v)
		}
	}
	if insert {
		err = d.Repo.InsertGroup(ctx, g)
	} else {
		err = d.Repo.UpdateGroup(ctx, g)
	}
	if err != nil {
		return err
	}
	return d.emit(ctx, reservation.EventGroupSaved, "booking_group", g.ID, g.Version, recordOf(g.ID, villas, g))
}

// CreateGroup books a group, all or nothing: every unit is checked first and one clash refuses
// the whole group. It needs booking/create, and payments/create with a deposit.
type CreateGroup struct{ Deps }

// Handle creates the group.
func (h CreateGroup) Handle(ctx context.Context, p auth.Principal, in NewGroup) (GroupCreated, error) {
	if err := h.Authz.Require(ctx, p.Role, bookingCreate...); err != nil {
		return GroupCreated{}, err
	}
	f := domain.GroupFields(in.Name, str(in.GuestID) != "" || present(in.NewGuest), in.Stays, in.Discount)
	if present(in.Deposit) {
		var dep depositInput
		if err := json.Unmarshal(in.Deposit, &dep); err != nil {
			return GroupCreated{}, errs.Invalid("deposit", "The deposit is not valid.")
		}
		if dep.Amount <= 0 || dep.Amount != float64(int64(dep.Amount)) {
			f.Add("deposit.amount", "Enter the amount the group pays now.")
		}
		if dep.Method == "bank_transfer" && len([]rune(strings.TrimSpace(dep.Reference))) < 3 {
			f.Add("deposit.reference", "Enter the bank reference.")
		}
	}
	if err := f.Err(); err != nil {
		return GroupCreated{}, err
	}
	if present(in.Deposit) {
		if err := h.Authz.Require(ctx, p.Role, paymentsCreate...); err != nil {
			return GroupCreated{}, err
		}
	}
	out := GroupCreated{Link: json.RawMessage("null")}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		from, to := stayRange(in.Stays)
		w, err := h.load(ctx, from, to)
		if err != nil {
			return err
		}
		if err := h.assertAllFree(w, in.Stays); err != nil {
			return err
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
		g := domain.BookingGroup{ID: fmt.Sprintf("bg-%d", n), Code: fmt.Sprintf("GRP-%d", 1000+n), Name: strings.TrimSpace(in.Name), LeadGuestID: lead,
			VillaIDs: []string{}, Source: in.Source, Billing: in.Billing, Note: strings.TrimSpace(in.Note), CreatedBy: p.Name, CreatedAt: h.stamp()}
		if in.Discount != nil {
			g.Discount = &domain.GroupDiscount{Pct: in.Discount.Pct, Reason: strings.TrimSpace(in.Discount.Reason)}
		}
		stays, err := h.addStays(ctx, p, &w, g, in.Stays, in.Confirm, overrides{restriction: in.Override, blacklist: in.BlacklistOverride})
		if err != nil {
			return err
		}
		if present(in.CityLedger) {
			if g.CityLedger, err = h.Clients.Billing.CityLedger(ctx, p, in.CityLedger, stays); err != nil {
				return err
			}
		}
		if err := h.saveGroup(ctx, &g, w.cat, true); err != nil {
			return err
		}
		codes := make([]string, len(stays))
		for i, b := range stays {
			codes[i] = b.Code
		}
		verb := "Drafted"
		if in.Confirm {
			verb = "Confirmed"
		}
		if err := h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "booking-group", EntityID: g.Code, Summary: fmt.Sprintf("%s group %s %s: %s", verb, g.Code, g.Name, strings.Join(codes, ", "))}); err != nil {
			return err
		}
		out.Group = g
		if !present(in.Deposit) {
			return nil
		}
		taken, err := h.groupPayment(ctx, p, g, in.Deposit)
		if err != nil {
			return err
		}
		var paid struct {
			Link json.RawMessage `json:"link"`
		}
		if json.Unmarshal(taken, &paid) == nil && present(paid.Link) {
			out.Link = paid.Link
		}
		return nil
	})
	return out, err
}

// groupPayment splits one payment over the stays in order, each up to what it still owes, and
// hands it to billing. A master folio still carries the room of stays that already left.
func (d Deps) groupPayment(ctx context.Context, p auth.Principal, g domain.BookingGroup, input json.RawMessage) (json.RawMessage, error) {
	stays, err := d.Repo.GroupStays(ctx, g.ID)
	if err != nil {
		return nil, err
	}
	var dues []domain.Share
	for _, b := range domain.StayOrder(stays) {
		if !domain.LiveStay(b.Status) && !(g.Billing == "master" && b.Status == domain.CheckedOut) {
			continue
		}
		owed, err := d.Clients.Billing.Owed(ctx, b.ID)
		if err != nil {
			return nil, err
		}
		dues = append(dues, domain.Share{BookingID: b.ID, Amount: owed})
	}
	var amount struct {
		Amount float64 `json:"amount"`
	}
	_ = json.Unmarshal(input, &amount)
	return d.Clients.Billing.GroupPayment(ctx, p, g, domain.Allocate(int64(amount.Amount), dues), input)
}

// groupInScope loads a group with a lock and refuses one whose villas are all outside the scope.
func (d Deps) groupInScope(ctx context.Context, p auth.Principal, c domain.Catalog, id string) (domain.BookingGroup, error) {
	g, err := d.Repo.Group(ctx, id)
	if err != nil {
		return g, err
	}
	for _, villaID := range g.VillaIDs {
		v, _ := c.Villa(villaID)
		if inScope(p, v) == nil {
			return g, nil
		}
	}
	if len(g.VillaIDs) == 0 {
		return g, nil
	}
	return g, errs.Forbidden(fmt.Sprintf("%s is outside the villas you work with.", g.Code))
}

// StayInput is a stay added to a group with the same overrides as a new group.
type StayInput struct {
	domain.GroupStayInput
	Override          *domain.Override `json:"override"`
	BlacklistOverride string           `json:"blacklistOverride"`
}

// AddGroupStay adds a stay to a group; it meets the restrictions and the lead's blacklist.
type AddGroupStay struct{ Deps }

// Handle adds the stay.
func (h AddGroupStay) Handle(ctx context.Context, p auth.Principal, groupID string, in StayInput) (domain.Booking, error) {
	if err := h.Authz.Require(ctx, p.Role, bookingEdit...); err != nil {
		return domain.Booking{}, err
	}
	if err := domain.ValidateGroupStay(in.GroupStayInput); err != nil {
		return domain.Booking{}, err
	}
	var created domain.Booking
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		w, err := h.load(ctx, in.CheckIn, in.CheckOut)
		if err != nil {
			return err
		}
		g, err := h.groupInScope(ctx, p, w.cat, groupID)
		if err != nil {
			return err
		}
		stays, err := h.Repo.GroupStays(ctx, groupID)
		if err != nil {
			return err
		}
		live, confirmed := 0, false
		for _, b := range stays {
			if domain.LiveStay(b.Status) {
				live++
				confirmed = confirmed || b.Status != domain.Draft
			}
		}
		if live == 0 {
			return domain.ErrInvalidState(fmt.Sprintf("%s has no stay left to join; book a new group instead.", g.Code))
		}
		if err := h.assertAllFree(w, []domain.GroupStayInput{in.GroupStayInput}); err != nil {
			return err
		}
		made, err := h.addStays(ctx, p, &w, g, []domain.GroupStayInput{in.GroupStayInput}, confirmed, overrides{restriction: in.Override, blacklist: in.BlacklistOverride})
		if err != nil {
			return err
		}
		created = made[0]
		if err := h.saveGroup(ctx, &g, w.cat, false); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "booking-group", EntityID: g.Code, Summary: fmt.Sprintf("Added %s to %s", created.Code, g.Code)})
	})
	return created, err
}

// RemoveGroupStay takes a stay out of its group; it carries on as a booking of its own.
type RemoveGroupStay struct{ Deps }

// Handle removes the stay from the group.
func (h RemoveGroupStay) Handle(ctx context.Context, p auth.Principal, groupID, bookingID string) (domain.Booking, error) {
	if err := h.Authz.Require(ctx, p.Role, bookingEdit...); err != nil {
		return domain.Booking{}, err
	}
	var b domain.Booking
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		cat, err := h.Catalog.Catalog(ctx)
		if err != nil {
			return err
		}
		g, err := h.groupInScope(ctx, p, cat, groupID)
		if err != nil {
			return err
		}
		if b, _, err = h.booking(ctx, p, cat, bookingID); err != nil {
			return err
		}
		if b.BookingGroupID != groupID {
			return errs.Newf(errs.CodeValidation, "%s is not in %s.", b.Code, g.Code)
		}
		if !domain.LiveStay(b.Status) {
			return domain.ErrInvalidState(fmt.Sprintf("%s is over; it stays on the group's record.", b.Code))
		}
		stays, err := h.Repo.GroupStays(ctx, groupID)
		if err != nil {
			return err
		}
		if len(stays) <= 1 {
			return errs.Newf("GROUP_LAST_STAY", "%s is the only stay of %s; cancel the group instead.", b.Code, g.Code)
		}
		b.BookingGroupID = ""
		if err := h.saveBooking(ctx, &b, cat); err != nil {
			return err
		}
		if err := h.saveGroup(ctx, &g, cat, false); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "booking-group", EntityID: g.Code, Summary: fmt.Sprintf("Took %s out of %s; it carries on as a booking of its own", b.Code, g.Code)})
	})
	return b, err
}

// PayGroup takes one payment for the group through billing; it needs payments/create.
type PayGroup struct{ Deps }

// Handle takes the payment and returns billing's { payments, link }.
func (h PayGroup) Handle(ctx context.Context, p auth.Principal, groupID string, input json.RawMessage) (json.RawMessage, error) {
	if err := h.Authz.Require(ctx, p.Role, paymentsCreate...); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		cat, err := h.Catalog.Catalog(ctx)
		if err != nil {
			return err
		}
		g, err := h.groupInScope(ctx, p, cat, groupID)
		if err != nil {
			return err
		}
		out, err = h.groupPayment(ctx, p, g, input)
		return err
	})
	return out, err
}
