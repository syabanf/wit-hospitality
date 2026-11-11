package command

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

// NewBooking is the booking form (NewBooking in ports.ts). The payment taken with the booking is
// recorded by the console through billing after the booking exists, so it is not read here.
type NewBooking struct {
	GuestID           *string             `json:"guestId"`
	NewGuest          json.RawMessage     `json:"newGuest"`
	UnitID            *string             `json:"unitId"`
	GroupID           *string             `json:"groupId"`
	Source            string              `json:"source"`
	AirbnbAccountID   *string             `json:"airbnbAccountId"`
	AirbnbCode        *string             `json:"airbnbCode"`
	CheckIn           string              `json:"checkIn"`
	CheckOut          string              `json:"checkOut"`
	ChannelRate       *float64            `json:"channelRate"`
	Price             *domain.PriceChange `json:"price"`
	Notes             string              `json:"notes"`
	Confirm           bool                `json:"confirm"`
	Override          *domain.Override    `json:"override"`
	BlacklistOverride string              `json:"blacklistOverride"`
	CityLedger        json.RawMessage     `json:"cityLedger"`
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// validate is the booking service's create check: every field error at once.
func (in NewBooking) validate() error {
	var f errs.Fields
	if msg := domain.ValidateStay(in.CheckIn, in.CheckOut); msg != "" {
		f.Add("checkOut", msg)
	}
	if str(in.UnitID) == "" && str(in.GroupID) == "" {
		f.Add("unitId", "Pick a unit or a room type.")
	}
	if str(in.GuestID) == "" && !present(in.NewGuest) {
		f.Add("guestId", "Pick a guest or add a new one.")
	}
	if in.Source == domain.Airbnb && str(in.AirbnbAccountID) == "" {
		f.Add("airbnbAccountId", "Pick the Airbnb account.")
	}
	if in.Source == domain.Airbnb && strings.TrimSpace(str(in.AirbnbCode)) == "" {
		f.Add("airbnbCode", "Enter the Airbnb confirmation code.")
	}
	if in.Source != domain.Direct && !wholePositive(in.ChannelRate) {
		f.Add("channelRate", "Enter the nightly price the channel sold.")
	}
	if in.Source == domain.Direct && in.Price != nil {
		if e, ok := errs.As(domain.ValidatePriceChange(*in.Price)); ok {
			f = append(f, e.Fields...)
		}
	}
	return f.Err()
}

func wholePositive(v *float64) bool { return v != nil && *v > 0 && *v == float64(int64(*v)) }

// airbnbCode is the mock's deterministic confirmation code for a booking number.
func airbnbCode(n int64) string {
	s := strings.ToUpper(strconv.FormatInt((n*2654435761)%2176782336, 36))
	if len(s) < 6 {
		s = strings.Repeat("0", 6-len(s)) + s
	}
	return "HM" + s[len(s)-6:]
}

// CreateBooking books a stay; it needs booking/create and the villa in scope.
type CreateBooking struct{ Deps }

// Handle creates the booking.
func (h CreateBooking) Handle(ctx context.Context, p auth.Principal, in NewBooking) (domain.Booking, error) {
	if err := h.Authz.Require(ctx, p.Role, bookingCreate...); err != nil {
		return domain.Booking{}, err
	}
	if err := in.validate(); err != nil {
		return domain.Booking{}, err
	}
	var b domain.Booking
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		w, err := h.load(ctx, in.CheckIn, in.CheckOut)
		if err != nil {
			return err
		}
		b, err = h.createStay(ctx, p, &w, in, stayExtra{})
		return err
	})
	return b, err
}

// stayExtra is what a group adds to each of its stays.
type stayExtra struct {
	groupID   string
	partySize *domain.PartySize
}

// createStay is the mock's createStay: a draft or confirmed stay, against a unit or, in a villa
// that sells the room type, against the type with a placeholder room so the villa still resolves.
func (d Deps) createStay(ctx context.Context, p auth.Principal, w *world, in NewBooking, extra stayExtra) (domain.Booking, error) {
	if msg := domain.ValidateStay(in.CheckIn, in.CheckOut); msg != "" {
		return domain.Booking{}, errs.New(errs.CodeValidation, msg)
	}
	var group *domain.UnitGroup
	if str(in.UnitID) == "" && str(in.GroupID) != "" {
		g, ok := w.cat.Group(*in.GroupID)
		if !ok {
			return domain.Booking{}, errs.NotFound("room type", *in.GroupID)
		}
		if !g.OperatorAssigns {
			return domain.Booking{}, errs.Newf(errs.CodeValidation, "%s rooms are booked one by one. Pick a unit.", g.Name)
		}
		group = &g
	}
	unitID := str(in.UnitID)
	if group != nil {
		for _, u := range w.cat.Units {
			if u.Group() == group.ID && u.Status != "inactive" {
				unitID = u.ID
				break
			}
		}
	}
	if unitID == "" {
		return domain.Booking{}, errs.New(errs.CodeValidation, "Pick a unit or a room type.")
	}
	pl, err := placeOf(w.cat, unitID)
	if err != nil {
		return domain.Booking{}, err
	}
	if err := inScope(p, pl.villa); err != nil {
		return domain.Booking{}, err
	}
	// A draft may sit on held nights; confirming it runs the exclusion check.
	if in.Confirm {
		if err := w.avail.AssertStayFree(domain.Holding{UnitID: unitID, UnitAssigned: group == nil}, in.CheckIn, in.CheckOut, ""); err != nil {
			return domain.Booking{}, err
		}
	}
	if in.Source != domain.Direct && !wholePositive(in.ChannelRate) {
		return domain.Booking{}, errs.New(errs.CodeValidation, "Enter the nightly price the channel sold.")
	}
	if in.Source != domain.Direct && in.Price != nil {
		return domain.Booking{}, errs.New("CHANNEL_PRICE_LOCKED", "A channel booking keeps the price the channel sold it for.")
	}
	shape := domain.StayShape{GroupID: pl.unit.Group(), UnitID: unitID, CheckIn: in.CheckIn, CheckOut: in.CheckOut}
	label := pl.unit.Code
	if group != nil {
		shape.GroupID, shape.UnitID, label = group.ID, "", group.Name
	}
	check, err := d.stayCheck(ctx, p)
	if err != nil {
		return domain.Booking{}, err
	}
	note, err := domain.CheckStay(w.rules, shape, in.Source, in.Override, fmt.Sprintf("%s, %s to %s,", label, in.CheckIn, in.CheckOut), check)
	if err != nil {
		return domain.Booking{}, err
	}
	guestID := str(in.GuestID)
	if guestID == "" && present(in.NewGuest) {
		if guestID, err = d.Clients.Guests.Create(ctx, p, in.NewGuest); err != nil {
			return domain.Booking{}, err
		}
	}
	if guestID == "" {
		return domain.Booking{}, errs.New(errs.CodeValidation, "A booking needs a guest.")
	}
	if err := optional(d.Clients.Guests.CheckBookable(ctx, p, guestID, in.BlacklistOverride)); err != nil {
		return domain.Booking{}, err
	}
	policy, err := d.Settings.Policy(ctx)
	if err != nil {
		return domain.Booking{}, err
	}
	var nights []domain.NightPrice
	if in.Source == domain.Direct {
		price, err := d.directPrice(ctx, w.cat, unitID)
		if err != nil {
			return domain.Booking{}, err
		}
		for _, date := range domain.EachDay(in.CheckIn, in.CheckOut) {
			if nights, err = appendNight(nights, price, date); err != nil {
				return domain.Booking{}, err
			}
		}
	} else {
		for _, date := range domain.EachDay(in.CheckIn, in.CheckOut) {
			nights = append(nights, domain.ChannelPrice(int64(*in.ChannelRate))(date))
		}
	}
	n, err := d.Repo.Next(ctx, "booking")
	if err != nil {
		return domain.Booking{}, err
	}
	b := domain.Booking{
		ID: fmt.Sprintf("bk-%d", n), Code: fmt.Sprintf("BK-%d", n), GuestID: guestID, UnitID: unitID, UnitAssigned: group == nil,
		RequestedUnitID: unitID, Source: in.Source, CheckIn: in.CheckIn, CheckOut: in.CheckOut, Status: domain.Draft,
		Notes: strings.TrimSpace(in.Notes), PaymentStatus: "unpaid", PriceMode: policy.ModeFor(in.Source),
		Movements: []domain.UnitMovement{}, CreatedOn: d.today(), BookingGroupID: extra.groupID, PartySize: extra.partySize,
		RestrictionNote: note,
	}
	if in.Confirm {
		b.Status = domain.Confirmed
	}
	if in.Source == domain.Airbnb {
		account := str(in.AirbnbAccountID)
		code := strings.TrimSpace(str(in.AirbnbCode))
		if code == "" {
			code = airbnbCode(n)
		}
		b.AirbnbAccountID, b.AirbnbCode = &account, &code
	}
	b.SetNights(nights)
	if in.Price != nil {
		approve, err := d.mayApprove(ctx, p)
		if err != nil {
			return domain.Booking{}, err
		}
		if _, err := b.ApplyPrice(*in.Price, actor(p), approve, policy.DiscountLimitPct, d.today()); err != nil {
			return domain.Booking{}, err
		}
	}
	if present(in.CityLedger) {
		if b.CityLedger, err = d.Clients.Billing.CityLedger(ctx, p, in.CityLedger, []domain.Booking{b}); err != nil {
			return domain.Booking{}, err
		}
	}
	if err := d.Repo.InsertBooking(ctx, &b); err != nil {
		return domain.Booking{}, err
	}
	w.avail.Bookings = append(w.avail.Bookings, b.Hold())
	if err := d.bookingEvent(ctx, b, w.cat); err != nil {
		return domain.Booking{}, err
	}
	where := pl.unit.Code
	if group != nil {
		where = group.Name + ", room to assign"
	}
	verb := "Drafted"
	if in.Confirm {
		verb = "Confirmed"
	}
	if err := d.record(ctx, p, audit.Line{Action: audit.Create, Entity: "booking", EntityID: b.Code, Summary: fmt.Sprintf("%s %s in %s", verb, b.Code, where)}); err != nil {
		return domain.Booking{}, err
	}
	if note != nil {
		return b, d.overrideAudit(ctx, p, b.Code, fmt.Sprintf("Sold %s past stay restrictions: %s", b.Code, note.Reason), note)
	}
	return b, nil
}

// nightPricer prices one night of a direct stay; it refuses only a night it has to price.
type nightPricer func(date string) (domain.NightPrice, error)

func appendNight(nights []domain.NightPrice, price nightPricer, date string) ([]domain.NightPrice, error) {
	n, err := price(date)
	if err != nil {
		return nights, err
	}
	return append(nights, n), nil
}

// directPrice is the mock's directPrice: the unit's live listing, else its room type's rate plan.
// The listing lives in the channel context; while it does not run, the rate plan prices the night.
func (d Deps) directPrice(ctx context.Context, c domain.Catalog, unitID string) (nightPricer, error) {
	unit, ok := c.Unit(unitID)
	if !ok {
		return nil, errs.NotFound("unit", unitID)
	}
	listing, err := d.Clients.Channel.Listing(ctx, unitID)
	if err = optional(err); err != nil {
		return nil, err
	}
	list := domain.PriceListFor(c, unit, listing)
	return func(date string) (domain.NightPrice, error) {
		if list == nil {
			return domain.NightPrice{}, domain.ErrNoPrice(unit.Code)
		}
		return list.Night(unit.NightlyRate, date), nil
	}, nil
}

// priceAll prices every date, stopping at the first refusal.
func priceAll(dates []string, price nightPricer) ([]domain.NightPrice, error) {
	var out []domain.NightPrice
	var err error
	for _, date := range dates {
		if out, err = appendNight(out, price, date); err != nil {
			return nil, err
		}
	}
	return out, nil
}
