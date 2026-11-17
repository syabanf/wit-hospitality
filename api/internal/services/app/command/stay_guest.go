package command

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/services"
	"github.com/syabanf/wit-hospitality/api/internal/services/domain"
)

// StayGuest answers reservation's stay page: what services shows a guest of their stay, and the
// guest's orders and requests. Reservation checked the stay token; the audit trail names the guest.
type StayGuest struct{ Deps }

var _ services.StayGuests = StayGuest{}

// guestMenuItem is GuestMenuItem: a menu item without what it costs the house or who delivers it.
type guestMenuItem struct {
	ID             string          `json:"id"`
	VillaID        string          `json:"villaId"`
	Category       string          `json:"category"`
	Name           string          `json:"name"`
	Description    string          `json:"description"`
	Photo          json.RawMessage `json:"photo"`
	Price          int64           `json:"price"`
	Unit           string          `json:"unit"`
	AvailableFrom  int             `json:"availableFrom"`
	AvailableTo    int             `json:"availableTo"`
	LeadMinutes    int             `json:"leadMinutes"`
	Active         bool            `json:"active"`
	VillaOnRequest bool            `json:"villaOnRequest"`
}

type guestOrderLine struct {
	Name     string  `json:"name"`
	Quantity float64 `json:"quantity"`
	Price    int64   `json:"price"`
	Comp     bool    `json:"comp"`
}

// guestOrder is GuestOrder.
type guestOrder struct {
	Number      string           `json:"number"`
	Status      string           `json:"status"`
	Lines       []guestOrderLine `json:"lines"`
	RequestedOn string           `json:"requestedOn"`
	RequestedAt int              `json:"requestedAt"`
	Charge      int64            `json:"charge"`
}

// guestRequest is GuestRequest.
type guestRequest struct {
	Number      string `json:"number"`
	Kind        string `json:"kind"`
	Status      string `json:"status"`
	RequestedOn string `json:"requestedOn"`
	RequestedAt int    `json:"requestedAt"`
}

// GuestStay is the villa's menu and the stay's orders and requests, newest first.
func (h StayGuest) GuestStay(ctx context.Context, bookingID string) (services.GuestStay, error) {
	stay, err := h.Stays.Stay(ctx, bookingID)
	if err != nil {
		return services.GuestStay{}, err
	}
	pl, err := h.place(ctx, stay.UnitID)
	if err != nil {
		return services.GuestStay{}, err
	}
	items, err := h.Repo.ActiveMenu(ctx, pl.Villa.ID)
	if err != nil {
		return services.GuestStay{}, err
	}
	menu := make([]guestMenuItem, len(items))
	for i, m := range items {
		menu[i] = guestMenuItem{ID: m.ID, VillaID: m.VillaID, Category: m.Category, Name: m.Name, Description: m.Description, Photo: m.Photo, Price: m.Price,
			Unit: m.Unit, AvailableFrom: m.AvailableFrom, AvailableTo: m.AvailableTo, LeadMinutes: m.LeadMinutes, Active: m.Active, VillaOnRequest: m.VillaOnRequest}
	}
	list, err := h.Repo.StayOrders(ctx, bookingID)
	if err != nil {
		return services.GuestStay{}, err
	}
	orders := make([]guestOrder, 0, len(list))
	for _, o := range slices.Backward(list) {
		lines := make([]guestOrderLine, len(o.Lines))
		for i, l := range o.Lines {
			lines[i] = guestOrderLine{Name: l.Name, Quantity: l.Quantity, Price: l.Price, Comp: l.Comp}
		}
		orders = append(orders, guestOrder{Number: o.Number, Status: o.Status, Lines: lines, RequestedOn: o.RequestedOn, RequestedAt: o.RequestedAt, Charge: o.Totals().Charge})
	}
	reqs, err := h.Repo.StayRequests(ctx, bookingID)
	if err != nil {
		return services.GuestStay{}, err
	}
	requests := make([]guestRequest, 0, len(reqs))
	for _, r := range slices.Backward(reqs) {
		requests = append(requests, guestRequest{Number: r.Number, Kind: r.Kind, Status: r.Status, RequestedOn: r.RequestedOn, RequestedAt: r.RequestedAt})
	}
	return services.GuestStay{Menu: mustJSON(menu), Orders: mustJSON(orders), Requests: mustJSON(requests)}, nil
}

// GuestOrder places the guest's order at menu prices, as the QR card does.
func (h StayGuest) GuestOrder(ctx context.Context, bookingID string, raw json.RawMessage) (string, error) {
	var in domain.OrderInput
	if err := json.Unmarshal(raw, &in); err != nil {
		return "", errs.New(errs.CodeValidation, "The order is not valid JSON.")
	}
	guestIn := domain.OrderInput{BookingID: bookingID, Note: in.Note, RequestedOn: in.RequestedOn, RequestedAt: in.RequestedAt, Priority: "normal"}
	for _, l := range in.Lines {
		guestIn.Lines = append(guestIn.Lines, domain.OrderLineInput{ItemID: l.ItemID, Quantity: l.Quantity})
	}
	if err := domain.ValidateOrder(guestIn); err != nil {
		return "", err
	}
	var summary string
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		stay, err := h.Stays.Stay(ctx, bookingID)
		if err != nil {
			return err
		}
		o, err := h.placeOrder(ctx, guestActor, "guest", guestIn, stay)
		summary = fmt.Sprintf("%s (%s)", domain.OrderSummary(o.Lines), o.Number)
		return err
	})
	return summary, err
}

// GuestRequest logs the guest's request, open, for the villa host on a villa stay and for the desk
// on a room.
func (h StayGuest) GuestRequest(ctx context.Context, bookingID, kind, note string) (string, error) {
	in := domain.ServiceRequestInput{BookingID: &bookingID, Kind: kind, Priority: "normal", Note: note}
	var number string
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		stay, err := h.Stays.Stay(ctx, bookingID)
		if err != nil {
			return err
		}
		in.UnitID = stay.UnitID
		if err := domain.ValidateServiceRequest(in); err != nil {
			return err
		}
		pl, err := h.place(ctx, stay.UnitID)
		if err != nil {
			return err
		}
		host, err := h.hostName(ctx, stay.HostID)
		if err != nil {
			return err
		}
		n, err := h.Repo.Next(ctx, "request")
		if err != nil {
			return err
		}
		r := domain.ServiceRequest{ID: "rq-" + strconv.FormatInt(n, 10), Number: "RQ-" + strconv.FormatInt(100+n, 10), Status: domain.RequestOpen,
			RequestedOn: h.today(), RequestedAt: h.minute(), Assignee: host}
		r.Apply(in)
		if err := h.Repo.InsertRequest(ctx, &r, pl.Villa.ID); err != nil {
			return err
		}
		number = r.Number
		if err := h.record(ctx, guestActor, audit.Line{Action: audit.Create, Entity: "service-request", EntityID: r.Number,
			Summary: fmt.Sprintf("Guest of %s asked for %s: %s", stay.Code, strings.ToLower(domain.ServiceKindLabel[r.Kind]), r.Number)}); err != nil {
			return err
		}
		return h.requestEvent(ctx, r, pl.Villa)
	})
	return number, err
}
