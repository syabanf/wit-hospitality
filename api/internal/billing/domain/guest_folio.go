package domain

import "strings"

// GuestFolioLine is one posted line as the guest reads it: a charge above zero, a payment or credit
// below.
type GuestFolioLine struct {
	Date   string `json:"date"`
	Label  string `json:"label"`
	Amount int64  `json:"amount"`
}

// GuestFolioView is GuestFolioView: the folio the guest's stay page shows. Posted lines in order,
// taxes as billed, the balance so far; no references, notes, costs or who posted a line.
type GuestFolioView struct {
	Lines       []GuestFolioLine `json:"lines"`
	Subtotal    int64            `json:"subtotal"`
	Service     int64            `json:"service"`
	PB1         int64            `json:"pb1"`
	Balance     int64            `json:"balance"`
	ToCome      int64            `json:"toCome"`
	DepositHeld int64            `json:"depositHeld"`
}

var guestKindLabel = map[string]string{
	KindDiscount: "Discount", KindChannel: "Paid through Airbnb", KindComp: "On the house", KindDeparture: "Charged at check-out",
	KindRebate: "Rebate", KindPayment: "Payment", KindRefund: "Refund", KindTransfer: "Billed to the company account",
}

// GuestLineLabel is guestLineLabel: a room night loses its rate notes, a payment its reference, a
// rebate its reason; charges and room service keep what was sold.
func GuestLineLabel(l FolioLine) string {
	switch l.Kind {
	case KindRoom:
		label, _, _ := strings.Cut(l.Description, ",")
		return label
	case KindRoomService:
		if _, item, ok := strings.Cut(l.Description, ": "); ok {
			return item
		}
		return l.Description
	case KindCharge:
		return l.Description
	case KindTax:
		if label, ok := taxLabel[l.Code]; ok {
			return label
		}
		return "Tax"
	case KindDeposit:
		if l.Memo < 0 {
			return "Security deposit returned"
		}
		return "Security deposit held"
	}
	return guestKindLabel[l.Kind]
}

// settles are the lines that pay the bill rather than add to it.
var settles = map[string]bool{KindPayment: true, KindRefund: true, KindChannel: true, KindTransfer: true}

// GuestFolioOf is guestFolioView.
func GuestFolioOf(f GuestFolio) GuestFolioView {
	out := GuestFolioView{Lines: []GuestFolioLine{}, Balance: f.Balance, ToCome: max(0, f.Forecast), DepositHeld: f.DepositHeld}
	for _, l := range f.Lines {
		if l.Forecast || l.Kind == KindDeposit {
			continue
		}
		amount := l.Debit - l.Credit
		out.Lines = append(out.Lines, GuestFolioLine{Date: l.Date, Label: GuestLineLabel(l), Amount: amount})
		if settles[l.Kind] {
			continue
		}
		switch l.Code {
		case ServiceCode:
			out.Service += amount
		case PB1Code:
			out.PB1 += amount
		default:
			out.Subtotal += amount
		}
	}
	return out
}
