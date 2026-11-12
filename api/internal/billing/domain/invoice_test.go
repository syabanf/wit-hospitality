package domain

import "testing"

func TestInvoiceLinesForADirectStayAtAStaffRate(t *testing.T) {
	rate := int64(900_000)
	b := booking(func(b *Booking) {
		b.RateOverride = &rate
		b.Discount = &Discount{Kind: "percent", Value: 10, Per: "stay"}
		b.Departure = &Departure{ExtraCharges: 75_000}
	})
	voided := order(func(o *Order) { o.ID, o.Number, o.Status = "so-2", "SO-702", "voided" })
	got := InvoiceLines(InvoiceStay{Booking: b, Room: "U1 · Garden", DiscountReason: "Returning guest", Orders: []Order{order(nil), voided}})
	eq(t, got, []StayInvoiceLine{
		{Label: "U1 · Garden", Detail: "3 nights × 900.000, staff rate (list 3.200.000)", Amount: 2_700_000},
		{Label: "Discount", Detail: "Returning guest", Amount: -270_000},
		{Label: "Room service SO-701", Detail: "2 × Nasi goreng, 1 × Flowers (on the house), 10% off", Amount: 180_000, Separate: true},
		{Label: "Departure charges", Detail: "Charged at check-out", Amount: 75_000, Separate: true},
	})
	eq(t, StayPriceOf(b), StayPrice{List: 3_200_000, Subtotal: 2_700_000, Discount: 270_000, Total: 2_430_000, Reduction: float64(770_000) / 3_200_000})
}

func TestInvoiceLinesForAnAirbnbStay(t *testing.T) {
	b := booking(func(b *Booking) { b.Source, b.AirbnbFee = "airbnb", 300_000 })
	eq(t, InvoiceLines(InvoiceStay{Booking: b, Room: "Room · room to be assigned"}), []StayInvoiceLine{
		{Label: "Room · room to be assigned", Detail: "3 nights at the channel price", Amount: 3_200_000},
		{Label: "Airbnb host fee", Detail: "Kept by Airbnb from the payout", Amount: -300_000},
	})
}

func TestInvoiceLinesPrintChargedServiceRequestsBeforeRoomService(t *testing.T) {
	b := booking(nil)
	requests := []Request{
		{Number: "RQ-102", Kind: "minibar", Note: "Refill water and two Bintang", Charge: 90_000, Status: "open"},
		{Number: "RQ-103", Kind: "laundry", Charge: 180_000, Status: "done"},
		{Number: "RQ-104", Kind: "towels", Status: "done"},
		{Number: "RQ-105", Kind: "transfer", Note: "Airport", Charge: 350_000, Status: "cancelled"},
	}
	got := InvoiceLines(InvoiceStay{Booking: b, Room: "U1 · Garden", Requests: requests, Orders: []Order{order(nil)}})
	eq(t, got[1:], []StayInvoiceLine{
		{Label: "Room service RQ-102", Detail: "Refill water and two Bintang", Amount: 90_000, Separate: true},
		{Label: "Room service RQ-103", Detail: "laundry", Amount: 180_000, Separate: true},
		{Label: "Room service SO-701", Detail: "2 × Nasi goreng, 1 × Flowers (on the house), 10% off", Amount: 180_000, Separate: true},
	})
}
