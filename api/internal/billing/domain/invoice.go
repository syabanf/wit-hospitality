package domain

import (
	"fmt"
	"strconv"
	"strings"
)

// SourceLabel is SOURCE_LABEL.
var SourceLabel = map[string]string{Direct: "Direct", "airbnb": "Airbnb"}

// StayPrice is stayPrice: the list, the price after the staff rate, the discount and the charge.
type StayPrice struct {
	List      int64   `json:"list"`
	Subtotal  int64   `json:"subtotal"`
	Discount  int64   `json:"discount"`
	Total     int64   `json:"total"`
	Reduction float64 `json:"reduction"`
}

// StayPriceOf is stayPrice.
func StayPriceOf(b Booking) StayPrice {
	list := sum(b.ListRates)
	subtotal := list
	if b.RateOverride != nil {
		subtotal = *b.RateOverride * int64(len(b.ListRates))
	}
	charged := sum(NightCharges(b))
	p := StayPrice{List: list, Subtotal: subtotal, Discount: subtotal - charged, Total: charged}
	if list > 0 {
		p.Reduction = max(0, float64(list-charged)/float64(list))
	}
	return p
}

// StayInvoiceLine is InvoiceLine, a line of a stay invoice.
type StayInvoiceLine struct {
	Label  string `json:"label"`
	Detail string `json:"detail"`
	Amount int64  `json:"amount"`
	// Separate is settled at the desk, outside the stay balance.
	Separate bool `json:"separate,omitempty"`
}

// InvoiceStay is what the invoice lines read of a stay beyond billing's copy.
type InvoiceStay struct {
	Booking        Booking
	Room           string
	DiscountReason string
	Orders         []Order
}

// InvoiceLines is the line list of the payments service's invoice: the room, the discount, the
// Airbnb fee, delivered room service and the departure charges. Service requests are services'
// and not on billing's copy.
func InvoiceLines(s InvoiceStay) []StayInvoiceLine {
	b := s.Booking
	nights := DaysBetween(b.CheckIn, b.CheckOut)
	price := StayPriceOf(b)
	var lines []StayInvoiceLine
	if b.RateOverride != nil {
		lines = append(lines, StayInvoiceLine{Label: s.Room, Detail: fmt.Sprintf("%d nights × %s, staff rate (list %s)", nights, Rupiah(*b.RateOverride), Rupiah(price.List)), Amount: price.Subtotal})
	} else {
		sold := "Airbnb listing"
		if b.IsChannel() {
			sold = "channel"
		}
		lines = append(lines, StayInvoiceLine{Label: s.Room, Detail: fmt.Sprintf("%d nights at the %s price", nights, sold), Amount: price.List})
	}
	if price.Discount > 0 && b.Discount != nil {
		lines = append(lines, StayInvoiceLine{Label: "Discount", Detail: s.DiscountReason, Amount: -price.Discount})
	}
	if b.Source == "airbnb" {
		lines = append(lines, StayInvoiceLine{Label: "Airbnb host fee", Detail: "Kept by Airbnb from the payout", Amount: -int64(b.AirbnbFee)})
	}
	for _, o := range s.Orders {
		if o.Status != "delivered" {
			continue
		}
		var gross, comp int64
		items := make([]string, len(o.Lines))
		for i, l := range o.Lines {
			gross += LineAmount(l)
			items[i] = strconv.FormatFloat(l.Quantity, 'f', -1, 64) + " × " + l.Name
			if l.Comp {
				comp += LineAmount(l)
				items[i] += " (on the house)"
			}
		}
		if gross <= 0 {
			continue
		}
		detail := strings.Join(items, ", ")
		if jsRound(float64(gross-comp)*o.DiscountPct/100) > 0 {
			detail += ", " + Pct(o.DiscountPct) + "% off"
		}
		lines = append(lines, StayInvoiceLine{Label: "Room service " + o.Number, Detail: detail, Amount: OrderCharge(o), Separate: true})
	}
	if b.Departure != nil && b.Departure.ExtraCharges > 0 {
		detail := b.Departure.Notes
		if detail == "" {
			detail = "Charged at check-out"
		}
		lines = append(lines, StayInvoiceLine{Label: "Departure charges", Detail: detail, Amount: int64(b.Departure.ExtraCharges), Separate: true})
	}
	return lines
}
