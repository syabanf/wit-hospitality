package command

import (
	"context"
	"encoding/json"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	"github.com/syabanf/wit-hospitality/api/internal/services/domain"
)

// PublicStay is the stay the guest's menu page shows.
type PublicStay struct {
	BookingCode string `json:"bookingCode"`
	GuestName   string `json:"guestName"`
	CheckIn     string `json:"checkIn"`
	CheckOut    string `json:"checkOut"`
	Status      string `json:"status"`
}

// PublicOrder is one of the stay's orders on the guest's menu page.
type PublicOrder struct {
	Number      string             `json:"number"`
	Status      string             `json:"status"`
	Lines       []domain.OrderLine `json:"lines"`
	RequestedOn string             `json:"requestedOn"`
	RequestedAt int                `json:"requestedAt"`
	Note        string             `json:"note"`
	Charge      int64              `json:"charge"`
	PayState    string             `json:"payState"`
}

// PublicMenu is PublicMenu: what the room's QR card opens, read without a session.
type PublicMenu struct {
	Token        string            `json:"token"`
	VillaName    string            `json:"villaName"`
	LocationName string            `json:"locationName"`
	UnitCode     string            `json:"unitCode"`
	UnitName     string            `json:"unitName"`
	Stay         *PublicStay       `json:"stay"`
	Items        []domain.MenuItem `json:"items"`
	Orders       []PublicOrder     `json:"orders"`
	Outstanding  int64             `json:"outstanding"`
	PayToken     *string           `json:"payToken"`
	Today        string            `json:"today"`
}

// Room serves the public token pages: GET, POST /order/{token} and POST /order/{token}/pay. The
// token is the credential; the audit trail names the guest.
type Room struct{ Deps }

// unit finds the room a QR card token opens.
func (h Room) unit(ctx context.Context, token string) (domain.Place, error) {
	units, err := h.Catalog.Units(ctx)
	if err != nil {
		return domain.Place{}, err
	}
	for _, u := range units {
		if domain.OrderToken(u.Code) == token {
			return h.place(ctx, u.ID)
		}
	}
	return domain.Place{}, errs.NotFound("room menu", token)
}

// stayInRoom is the mock's stayInRoom: the guest in house, else the next arrival within the
// ordering window; nil when the room is empty.
func (h Room) stayInRoom(ctx context.Context, unitID string) (*reservation.Stay, error) {
	stays, err := h.Stays.InUnit(ctx, unitID)
	if err != nil {
		return nil, err
	}
	today := h.today()
	stays = slices.DeleteFunc(stays, func(s reservation.Stay) bool { return !domain.OrderableStay(s.Status, s.CheckIn, today) })
	if i := slices.IndexFunc(stays, func(s reservation.Stay) bool { return s.Status == "checked_in" }); i >= 0 {
		return &stays[i], nil
	}
	if len(stays) == 0 {
		return nil, nil
	}
	first := slices.MinFunc(stays, func(a, b reservation.Stay) int { return strings.Compare(a.CheckIn, b.CheckIn) })
	return &first, nil
}

func (h Room) occupied(ctx context.Context, pl domain.Place) (reservation.Stay, error) {
	stay, err := h.stayInRoom(ctx, pl.Unit.ID)
	if err != nil {
		return reservation.Stay{}, err
	}
	if stay == nil {
		return reservation.Stay{}, errs.New(domain.CodeOrderNoStay, pl.Unit.Code+" has no guest staying right now.")
	}
	return *stay, nil
}

func (h Room) guestName(ctx context.Context, guestID string) (string, error) {
	name, err := h.Guests.Name(ctx, guestID)
	if errs.HasCode(err, CodeNotAvailable) || errs.HasCode(err, errs.CodeNotFound) {
		return "", nil
	}
	return name, err
}

// View is GET /order/{token}.
func (h Room) View(ctx context.Context, token string) (PublicMenu, error) {
	pl, err := h.unit(ctx, token)
	if err != nil {
		return PublicMenu{}, err
	}
	items, err := h.Repo.ActiveMenu(ctx, pl.Villa.ID)
	if err != nil {
		return PublicMenu{}, err
	}
	out := PublicMenu{Token: token, VillaName: pl.Villa.Name, LocationName: pl.LocationName, UnitCode: pl.Unit.Code, UnitName: pl.Unit.Name,
		Items: items, Orders: []PublicOrder{}, Today: h.today()}
	if out.Items == nil {
		out.Items = []domain.MenuItem{}
	}
	stay, err := h.stayInRoom(ctx, pl.Unit.ID)
	if err != nil || stay == nil {
		return out, err
	}
	name, err := h.guestName(ctx, stay.GuestID)
	if err != nil {
		return out, err
	}
	first, _, _ := strings.Cut(name, " ")
	out.Stay = &PublicStay{BookingCode: stay.Code, GuestName: first, CheckIn: stay.CheckIn, CheckOut: stay.CheckOut, Status: stay.Status}
	orders, err := h.Repo.StayOrders(ctx, stay.ID)
	if err != nil {
		return out, err
	}
	statusOf, pm, err := h.payments(ctx, stay.ID)
	if err != nil {
		return out, err
	}
	for i := len(orders) - 1; i >= 0; i-- {
		o := orders[i]
		state := domain.PayState(o, statusOf(o.PaymentID))
		out.Orders = append(out.Orders, PublicOrder{Number: o.Number, Status: o.Status, Lines: o.Lines, RequestedOn: o.RequestedOn, RequestedAt: o.RequestedAt,
			Note: o.Note, Charge: o.Totals().Charge, PayState: state})
		if state == domain.PayUnpaid || state == domain.PayPending {
			out.Outstanding += max(0, o.Totals().Charge-pm.Rebated[o.ID])
		}
	}
	if pm.PayToken != "" {
		out.PayToken = &pm.PayToken
	}
	return out, nil
}

// Place is POST /order/{token}: the guest orders for the stay in that room at menu prices.
func (h Room) Place(ctx context.Context, token string, in domain.OrderInput) (PublicMenu, error) {
	guestIn := domain.OrderInput{Note: in.Note, RequestedOn: in.RequestedOn, RequestedAt: in.RequestedAt, Priority: "normal"}
	for _, l := range in.Lines {
		guestIn.Lines = append(guestIn.Lines, domain.OrderLineInput{ItemID: l.ItemID, Quantity: l.Quantity})
	}
	if err := domain.ValidateOrder(guestIn); err != nil {
		return PublicMenu{}, err
	}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		pl, err := h.unit(ctx, token)
		if err != nil {
			return err
		}
		stay, err := h.occupied(ctx, pl)
		if err != nil {
			return err
		}
		_, err = h.placeOrder(ctx, guestActor, "guest", guestIn, stay)
		return err
	})
	if err != nil {
		return PublicMenu{}, err
	}
	return h.View(ctx, token)
}

// Pay is POST /order/{token}/pay: a QRIS link for everything delivered and still unpaid. Billing
// opens the link; until it runs, a bill to pay answers NOT_AVAILABLE.
func (h Room) Pay(ctx context.Context, token string) (json.RawMessage, error) {
	pl, err := h.unit(ctx, token)
	if err != nil {
		return nil, err
	}
	stay, err := h.occupied(ctx, pl)
	if err != nil {
		return nil, err
	}
	orders, err := h.Repo.StayOrders(ctx, stay.ID)
	if err != nil {
		return nil, err
	}
	statusOf, pm, err := h.payments(ctx, stay.ID)
	if err != nil {
		return nil, err
	}
	var unpaid []domain.ServiceOrder
	var amount int64
	for _, o := range orders {
		due := o.Totals().Charge - pm.Rebated[o.ID]
		if domain.PayState(o, statusOf(o.PaymentID)) == domain.PayUnpaid && due > 0 {
			unpaid = append(unpaid, o)
			amount += due
		}
	}
	if pm.PayToken == "" && len(unpaid) == 0 {
		return nil, errs.New(domain.CodeOrderNotBillable, "Nothing delivered is waiting to be paid.")
	}
	payer, err := h.guestName(ctx, stay.GuestID)
	if err != nil {
		return nil, err
	}
	return h.Billing.PayOrders(ctx, stay, unpaid, amount, payer)
}
