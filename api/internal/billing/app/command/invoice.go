package command

import (
	"context"
	"encoding/json"
	"sort"

	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Invoice is the payments service's invoice(bookingId) in the console's InvoiceView shape, for the
// public e-invoice link messaging serves. The booking carries the parts of BookingView the invoice
// sheet prints. The source label, the room type, the group chip and the service requests come from
// billing's copies of channel's accounts, property's room types, reservation's groups and services'
// requests.
func (h Desk) Invoice(ctx context.Context, bookingID string) (json.RawMessage, error) {
	var out json.RawMessage
	err := h.inTx(ctx, func(ctx context.Context) error {
		if err := h.expire(ctx); err != nil {
			return err
		}
		raw, err := h.Store.Stay(ctx, bookingID)
		if err != nil {
			return err
		}
		b, err := h.stayOf(ctx, raw)
		if err != nil {
			return err
		}
		view, err := decode[map[string]any](raw)
		if err != nil {
			return err
		}
		extra, err := decode[struct {
			Discount *struct {
				Reason string `json:"reason"`
			} `json:"discount"`
			AirbnbAccountID string `json:"airbnbAccountId"`
		}](raw)
		if err != nil {
			return err
		}
		pl, err := h.Store.Place(ctx, b.UnitID)
		if err != nil {
			return err
		}
		tax, err := h.tax(ctx)
		if err != nil {
			return err
		}
		policy, err := h.policy(ctx)
		if err != nil {
			return err
		}
		orders, err := h.orders(ctx, b.ID)
		if err != nil {
			return err
		}
		requests, err := h.Store.Requests(ctx, b.ID)
		if err != nil {
			return err
		}
		var account json.RawMessage
		if extra.AirbnbAccountID != "" {
			if account, err = h.Store.Account(ctx, extra.AirbnbAccountID); err != nil {
				return err
			}
		}
		pays, err := h.stayPayments(ctx, b.ID)
		if err != nil {
			return err
		}
		links, err := docs[json.RawMessage](h.Store.ByBooking(ctx, Links, b.ID))
		if err != nil {
			return err
		}
		expected, err := h.expected(ctx, b)
		if err != nil {
			return err
		}
		paid, err := h.paid(ctx, b)
		if err != nil {
			return err
		}

		guestName := h.guestName(ctx, b.GuestID)
		st := domain.StayTaxOf(b, &tax)
		room, unitCode, roomType := "Room · room to be assigned", "Unassigned", any(nil)
		if b.UnitAssigned {
			room, unitCode = pl.UnitCode+" · "+pl.UnitName, pl.UnitCode
		} else if pl.RoomType != "" {
			room, roomType = pl.RoomType+" · room to be assigned", pl.RoomType
		}
		reason := ""
		if extra.Discount != nil {
			reason = extra.Discount.Reason
		}
		view["guestName"], view["unitCode"], view["roomType"] = guestName, unitCode, roomType
		view["place"] = map[string]any{
			"villa":    map[string]string{"id": pl.VillaID, "name": pl.VillaName, "locationId": pl.LocationID},
			"location": map[string]string{"id": pl.LocationID, "name": pl.LocationName},
			"unit":     map[string]string{"id": b.UnitID, "code": pl.UnitCode, "name": pl.UnitName},
			"group":    pl.Group,
		}
		if view["group"], err = h.groupChip(ctx, b.BookingGroupID); err != nil {
			return err
		}
		view["account"], view["sourceLabel"] = nil, domain.SourceLabel[b.Source]
		if account != nil {
			name, err := decode[struct {
				Name string `json:"name"`
			}](account)
			if err != nil {
				return err
			}
			view["account"], view["sourceLabel"] = account, name.Name
		}
		view["nights"], view["rate"] = domain.DaysBetween(b.CheckIn, b.CheckOut), domain.AverageRate(b)
		view["total"], view["taxes"], view["price"] = st.Total, st, domain.StayPriceOf(b)
		view["payout"] = st.Total - int64(b.AirbnbFee)

		sort.SliceStable(pays, func(i, j int) bool {
			if pays[i].CreatedOn != pays[j].CreatedOn {
				return pays[i].CreatedOn < pays[j].CreatedOn
			}
			return pays[i].Number < pays[j].Number
		})
		payments := make([]map[string]any, len(pays))
		for i, p := range pays {
			row, err := decode[map[string]any](mustJSON(p))
			if err != nil {
				return err
			}
			row["bookingCode"], row["guestName"], row["unitCode"] = b.Code, guestName, unitCode
			row["villaId"], row["villaName"], row["locationId"] = pl.VillaID, pl.VillaName, pl.LocationID
			row["link"], row["transactionStatus"], row["transactionNumber"], row["proofs"] = nil, nil, nil, []any{}
			for _, l := range links {
				if link, err := decode[domain.PaymentLink](l); err == nil && link.PaymentID == p.ID {
					row["link"] = l
				}
			}
			payments[i] = row
		}

		var charged, ordersPaid, ordersOwed int64
		for _, o := range orders {
			if o.Status != "delivered" {
				continue
			}
			c := domain.OrderCharge(o)
			charged += c
			switch payState(o, pays) {
			case "paid":
				ordersPaid += c
			case "unpaid", "pending":
				ordersOwed += c
			}
		}
		dueOn := domain.BalanceDueOn(b.CheckIn, policy)
		if b.Source == "airbnb" {
			dueOn = domain.AddDays(b.CheckIn, 1)
		}
		out = mustJSON(map[string]any{
			"booking":     view,
			"lines":       domain.InvoiceLines(domain.InvoiceStay{Booking: b, Room: room, DiscountReason: reason, Requests: requests, Orders: orders}),
			"total":       st.Total,
			"expected":    expected,
			"paid":        paid,
			"outstanding": max(0, expected-paid),
			"overpaid":    max(0, paid-expected),
			"dueOn":       dueOn,
			"payments":    payments,
			"links":       links,
			"roomService": map[string]int64{"charged": charged, "paid": ordersPaid, "outstanding": ordersOwed},
			"tax":         map[string]any{"subtotal": st.Net, "service": st.Service, "pb1": st.PB1, "total": st.Total, "note": domain.TaxNote(st)},
		})
		return nil
	})
	return out, err
}

// groupChip is the part of a booking group BookingView carries; nil for a stay in no group.
func (h Desk) groupChip(ctx context.Context, groupID string) (map[string]any, error) {
	if groupID == "" {
		return nil, nil
	}
	raw, err := h.Store.Group(ctx, groupID)
	if errs.HasCode(err, errs.CodeNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	g, err := decode[map[string]any](raw)
	if err != nil {
		return nil, err
	}
	chip := map[string]any{}
	for _, k := range []string{"id", "code", "name", "billing", "cityLedger"} {
		if v, ok := g[k]; ok {
			chip[k] = v
		}
	}
	return chip, nil
}
