package domain

import (
	"fmt"
	"sort"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Folio line kinds.
const (
	KindRoom        = "room"
	KindDiscount    = "discount"
	KindChannel     = "channel"
	KindRoomService = "room_service"
	KindComp        = "comp"
	KindCharge      = "charge"
	KindDeparture   = "departure"
	KindTax         = "tax"
	KindRebate      = "rebate"
	KindPayment     = "payment"
	KindRefund      = "refund"
	KindDeposit     = "deposit"
	KindTransfer    = "transfer"
)

// Parts of the check-out bill.
const (
	PartRoom    = "room"
	PartOrders  = "orders"
	PartCharges = "charges"
)

var debits = map[string]bool{KindRoom: true, KindRoomService: true, KindCharge: true, KindDeparture: true, KindTax: true, KindRefund: true}

// Side is folioSide: the deposit is a memo, kept out of the balance.
func Side(kind string) string {
	switch {
	case kind == KindDeposit:
		return "memo"
	case debits[kind]:
		return "debit"
	}
	return "credit"
}

// FolioRef is the record behind a line.
type FolioRef struct {
	Type  string `json:"type"`
	ID    string `json:"id"`
	Label string `json:"label"`
}

// FolioLine is FolioLine with the balance after it.
type FolioLine struct {
	ID          string   `json:"id"`
	Date        string   `json:"date"`
	Kind        string   `json:"kind"`
	Description string   `json:"description"`
	Debit       int64    `json:"debit"`
	Credit      int64    `json:"credit"`
	Memo        int64    `json:"memo"`
	Ref         FolioRef `json:"ref"`
	PostedBy    string   `json:"postedBy"`
	PostedAt    string   `json:"postedAt"`
	Part        string   `json:"part"`
	OrderID     *string  `json:"orderId"`
	Code        string   `json:"code"`
	Of          *string  `json:"of"`
	Forecast    bool     `json:"forecast"`
	Balance     int64    `json:"balance"`
}

// PostingCityLedger is the city ledger side of a transfer posting.
type PostingCityLedger struct {
	AccountID   string `json:"accountId"`
	Instruction string `json:"instruction"`
	Service     int64  `json:"service"`
	PB1         int64  `json:"pb1"`
}

// Posting is FolioPosting: a charge, a rebate or a city ledger transfer the desk posts.
type Posting struct {
	ID            string             `json:"id"`
	BookingID     string             `json:"bookingId"`
	Kind          string             `json:"kind"`
	Code          string             `json:"code"`
	Description   string             `json:"description"`
	Amount        int64              `json:"amount"`
	Date          string             `json:"date"`
	Part          string             `json:"part"`
	LineID        *string            `json:"lineId"`
	OrderID       *string            `json:"orderId"`
	PostedBy      string             `json:"postedBy"`
	PostedByID    string             `json:"postedById"`
	PostedAt      string             `json:"postedAt"`
	Service       *int64             `json:"service,omitempty"`
	PB1           *int64             `json:"pb1,omitempty"`
	ApprovedBy    *string            `json:"approvedBy"`
	TransactionID *string            `json:"transactionId"`
	PaidBy        *string            `json:"paidBy,omitempty"`
	CityLedger    *PostingCityLedger `json:"cityLedger,omitempty"`
}

func deref(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

// Gross is postingGross: the net with its service and PB1.
func (p Posting) Gross() int64 { return p.Amount + deref(p.Service) + deref(p.PB1) }

// ChargeInput is ChargeInput.
type ChargeInput struct {
	Code        string  `json:"code"`
	Description string  `json:"description"`
	Amount      float64 `json:"amount"`
}

// RebateInput is RebateInput.
type RebateInput struct {
	LineID string  `json:"lineId"`
	Amount float64 `json:"amount"`
	Reason string  `json:"reason"`
}

func whole(v float64) bool { return v == float64(int64(v)) }

// ValidateCharge is validateCharge.
func ValidateCharge(in ChargeInput, codes []TransactionCode) error {
	var f errs.Fields
	ok := false
	for _, c := range ChargeCodes(codes) {
		if c.Code == in.Code {
			ok = true
		}
	}
	if !ok {
		f.Add("code", "Pick the transaction code the charge posts on.")
	}
	if len([]rune(strings.TrimSpace(in.Description))) < 3 {
		f.Add("description", "Say what was charged.")
	}
	if !whole(in.Amount) || in.Amount <= 0 {
		f.Add("amount", "Enter the charge in whole rupiah.")
	}
	return f.Err()
}

var rebatable = map[string]bool{KindRoom: true, KindRoomService: true, KindCharge: true}

// RebateTarget is the line a rebate corrects and what is left of it.
type RebateTarget struct {
	Line    FolioLine `json:"line"`
	Net     int64     `json:"net"`
	Rebated int64     `json:"rebated"`
	Open    int64     `json:"open"`
}

// TargetOf is rebateTarget; nil when the line cannot take a rebate.
func TargetOf(lines []FolioLine, lineID string) *RebateTarget {
	var line *FolioLine
	for i := range lines {
		if lines[i].ID == lineID {
			line = &lines[i]
			break
		}
	}
	if line == nil || line.Forecast || !rebatable[line.Kind] || line.Debit == 0 {
		return nil
	}
	off := func(kinds ...string) int64 {
		var s int64
		for _, l := range lines {
			if l.Of != nil && *l.Of == line.ID && contains(kinds, l.Kind) {
				s += l.Credit
			}
		}
		return s
	}
	net := line.Debit - off(KindComp, KindDiscount)
	rebated := off(KindRebate)
	return &RebateTarget{Line: *line, Net: net, Rebated: rebated, Open: net - rebated}
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// ValidateRebate is validateRebate.
func ValidateRebate(in RebateInput, t *RebateTarget) error {
	var f errs.Fields
	if t == nil {
		f.Add("lineId", "Pick a posted night, room service line or charge to correct.")
	}
	switch {
	case !whole(in.Amount) || in.Amount <= 0:
		f.Add("amount", "Enter the rebate in whole rupiah.")
	case t != nil && int64(in.Amount) > t.Open:
		if t.Open > 0 {
			f.Add("amount", fmt.Sprintf("Only %d is left on that line.", t.Open))
		} else {
			f.Add("amount", "That line is already rebated in full.")
		}
	}
	if len([]rune(strings.TrimSpace(in.Reason))) < 3 {
		f.Add("reason", "Say why the guest gets the rebate.")
	}
	return f.Err()
}

// RebateTax is rebateTax: the service and PB1 a rebate takes back, in proportion to the line's.
func RebateTax(lines []FolioLine, t RebateTarget, amount int64) TaxSplit {
	tax := func(code string) int64 {
		id := t.Line.ID + "-" + strings.ToLower(code)
		for _, l := range lines {
			if l.ID == id {
				return l.Debit
			}
		}
		return 0
	}
	return RebateSplit(TaxSplit{Net: t.Net, Service: tax(ServiceCode), PB1: tax(PB1Code)}, t.Rebated, amount)
}

// RebateBeyondLimit is rebateBeyondLimit: past limitPct of the line, a rebate needs an approver.
func RebateBeyondLimit(t RebateTarget, amount int64, limitPct float64) bool {
	return float64((t.Rebated+amount)*100) > float64(t.Net)*limitPct+1e-9
}

// FolioSources is what a folio reads.
type FolioSources struct {
	Booking      Booking
	Payments     []Payment
	Orders       []Order
	Postings     []Posting
	RoomOnMaster bool
	Tax          *TaxSettings
}

// OnMaster is folioOnMaster: the room lines a master-billed group carries, deposit aside.
func OnMaster(l FolioLine) bool { return l.Part == PartRoom && l.Kind != KindDeposit }

// OrderDue is one order still owed.
type OrderDue struct {
	OrderID string `json:"orderId"`
	Amount  int64  `json:"amount"`
}

// FolioDue is FolioDue.
type FolioDue struct {
	Room    int64      `json:"room"`
	Orders  []OrderDue `json:"orders"`
	Charges int64      `json:"charges"`
}

// BillTaxes is the bill's subtotal, service and PB1.
type BillTaxes struct {
	Subtotal int64 `json:"subtotal"`
	Service  int64 `json:"service"`
	PB1      int64 `json:"pb1"`
	Total    int64 `json:"total"`
}

// GuestFolio is GuestFolio.
type GuestFolio struct {
	Lines       []FolioLine `json:"lines"`
	Debits      int64       `json:"debits"`
	Credits     int64       `json:"credits"`
	Balance     int64       `json:"balance"`
	Forecast    int64       `json:"forecast"`
	Estimated   int64       `json:"estimated"`
	Due         FolioDue    `json:"due"`
	RefundDue   int64       `json:"refundDue"`
	DepositHeld int64       `json:"depositHeld"`
	Taxes       BillTaxes   `json:"taxes"`
}

// Owed is folioOwed: the room, each unpaid order and the open charges.
func (f GuestFolio) Owed() int64 {
	s := f.Due.Room + f.Due.Charges
	for _, o := range f.Due.Orders {
		s += o.Amount
	}
	return s
}

func at(date, t string) string { return date + "T" + t }

func clockOf(minutes int) string { return fmt.Sprintf("%02d:%02d:00", minutes/60, minutes%60) }

var kindOrder = map[string]float64{KindRoom: 0, KindDiscount: 1, KindChannel: 2, KindRoomService: 3, KindComp: 4, KindCharge: 5, KindDeparture: 6,
	KindTax: 6.5, KindRebate: 7, KindDeposit: 8, KindRefund: 9, KindPayment: 10, KindTransfer: 11}

// byPosting orders by time, then debits before the credits that settle them.
func byPosting(x, y FolioLine) bool {
	if x.PostedAt != y.PostedAt {
		return x.PostedAt < y.PostedAt
	}
	if kindOrder[x.Kind] != kindOrder[y.Kind] {
		return kindOrder[x.Kind] < kindOrder[y.Kind]
	}
	return x.ID < y.ID
}

// draft is a line before post sets its side.
type draft struct {
	FolioLine
	amount int64
}

// post puts the amount on the side the kind takes, never the caller's.
func post(d draft) FolioLine {
	l := d.FolioLine
	l.Debit, l.Credit, l.Memo = 0, 0, 0
	switch Side(l.Kind) {
	case "debit":
		l.Debit = d.amount
	case "credit":
		l.Credit = d.amount
	default:
		l.Memo = d.amount
	}
	return l
}

func str(s string) *string { return &s }

var taxLabel = map[string]string{ServiceCode: "Service charge", PB1Code: "PB1, regional hotel tax"}

// taxLines are the service and PB1 lines of `line`; a rebate's reversal credits them against the
// corrected line's own tax lines.
func taxLines(line FolioLine, tax TaxSplit, rebateOf *string) []FolioLine {
	var out []FolioLine
	for _, k := range []struct {
		code   string
		amount int64
	}{{ServiceCode, tax.Service}, {PB1Code, tax.PB1}} {
		if k.amount <= 0 {
			continue
		}
		suffix := strings.ToLower(k.code)
		l := line
		l.ID, l.Code, l.Kind, l.Of = line.ID+"-"+suffix, k.code, KindTax, str(line.ID)
		l.Description = taxLabel[k.code] + " on " + line.Code
		if rebateOf != nil {
			l.Kind, l.Of = KindRebate, str(*rebateOf+"-"+suffix)
			l.Description = taxLabel[k.code] + " back on " + line.Code
		}
		out = append(out, post(draft{l, k.amount}))
	}
	return out
}

func roomLines(b Booking, payments []Payment, tax *TaxSettings) []FolioLine {
	ref := FolioRef{Type: "booking", ID: b.ID, Label: b.Code}
	by := "Console"
	if b.PriceSetBy != nil {
		by = b.PriceSetBy.By
	}
	room := FolioLine{Ref: ref, Part: PartRoom, Code: RoomCode}
	if b.Status == Cancelled || b.Status == NoShow {
		var kept int64
		if !b.IsChannel() {
			kept = NetPaid(payments, b.ID)
		}
		if kept <= 0 {
			return nil
		}
		l := room
		l.ID, l.Date, l.Kind, l.PostedBy, l.PostedAt = b.ID+"-kept", b.CheckIn, KindRoom, "Console", at(b.CheckIn, "00:00:00")
		l.Description = "Kept on the cancellation"
		if b.Status == NoShow {
			l.Description = "Kept on the no-show"
		}
		return []FolioLine{post(draft{l, kept})}
	}
	charges := NightCharges(b)
	splits := NightSplits(b, tax)
	dates := NightDates(b)
	audited := b.Posted()
	var nights []FolioLine
	for i, amount := range charges {
		wasAudited := i < len(audited) && audited[i] != ""
		on := wasAudited || b.Status == CheckedOut
		date := AddDays(b.CheckIn, i)
		if i < len(dates) {
			date = dates[i]
		}
		listed := int64(0)
		if b.RateOverride != nil {
			listed = *b.RateOverride
		} else if i < len(b.ListRates) {
			listed = b.ListRates[i]
		}
		share := listed - amount
		desc := fmt.Sprintf("Night %d of %d", i+1, len(charges))
		if b.RateOverride != nil {
			desc += ", staff rate"
		}
		if share > 0 {
			desc += ", less " + Rupiah(share) + " discount"
		}
		split := TaxSplit{Net: amount}
		if i < len(splits) {
			split = splits[i]
		}
		l := room
		l.ID, l.Date, l.Kind, l.Description, l.Forecast = fmt.Sprintf("%s-night-%d", b.ID, i+1), date, KindRoom, desc, !on
		switch {
		case !on:
			l.PostedBy, l.PostedAt = by, at(date, "23:00:00")
		case wasAudited:
			l.PostedBy, l.PostedAt = "Night audit", at(date, "23:00:00")
		default:
			l.PostedBy, l.PostedAt = "Check-out", at(date, "10:58:00")
		}
		line := post(draft{l, split.Net})
		nights = append(nights, line)
		nights = append(nights, taxLines(line, split, nil)...)
	}
	if !b.IsChannel() {
		return nights
	}
	// Airbnb collected the room: the posted and the forecast nights come off the guest's folio.
	channel := func(forecast bool) []FolioLine {
		var amount int64
		for _, l := range nights {
			if l.Forecast == forecast {
				amount += l.Debit
			}
		}
		if amount <= 0 {
			return nil
		}
		l := room
		l.Code, l.ID, l.Date, l.Kind, l.Forecast = PaymentMethodCode["airbnb_payout"], b.ID+"-channel", b.CheckIn, KindChannel, forecast
		if forecast {
			l.ID += "-forecast"
		}
		l.Description, l.PostedBy, l.PostedAt = "The guest paid the room to Airbnb; the payout settles with the villa", "Console", at(b.CheckIn, "23:00:01")
		return []FolioLine{post(draft{l, amount})}
	}
	return append(append(nights, channel(false)...), channel(true)...)
}

type orderShare struct {
	orderID string
	order   *Order
	amount  int64
}

// orderShares is what an order payment paid for each order: the amounts it recorded, else the charge.
func orderShares(p Payment, orders []Order) []orderShare {
	out := make([]orderShare, len(p.OrderIDs))
	for i, id := range p.OrderIDs {
		var o *Order
		for j := range orders {
			if orders[j].ID == id {
				o = &orders[j]
			}
		}
		amount := p.Amount
		switch {
		case i < len(p.OrderAmounts):
			amount = p.OrderAmounts[i]
		case len(p.OrderIDs) != 1 && o != nil:
			amount = 0
			for _, r := range CodeSplit(*o) {
				amount += r.Amount
			}
		}
		out[i] = orderShare{orderID: id, order: o, amount: amount}
	}
	return out
}

func paymentLines(b Booking, payments, all []Payment, orders []Order) []FolioLine {
	var out []FolioLine
	for _, p := range payments {
		if p.BookingID != b.ID || (p.Status != "paid" && p.Status != "refunded") {
			continue
		}
		date := p.CreatedOn
		if p.PaidOn != nil {
			date = *p.PaidOn
		}
		postedAt := at(date, "12:00:00")
		for i := len(p.History) - 1; i >= 0; i-- {
			if p.History[i].Kind == "paid" {
				postedAt = p.History[i].At
				break
			}
		}
		base := FolioLine{Date: date, Ref: FolioRef{Type: "payment", ID: p.ID, Label: p.Number}, PostedBy: p.CreatedBy, PostedAt: postedAt, Code: MethodCode(p.Method)}
		kind := KindPayment
		if p.Kind == "refund" {
			kind = KindRefund
		}
		description := p.Number
		if p.RefundOf != nil {
			for _, x := range all {
				if x.ID == *p.RefundOf {
					description += " back from " + x.Number
				}
			}
		}
		if p.Note != "" {
			description += ", " + p.Note
		}
		if p.ForOrders() {
			for _, s := range orderShares(p, orders) {
				l := base
				l.ID, l.Kind, l.Part, l.OrderID = p.ID+"-"+s.orderID, kind, PartOrders, str(s.orderID)
				l.Description = description
				if kind != KindRefund {
					number := "room service"
					if s.order != nil {
						number = s.order.Number
					}
					l.Description = p.Number + " for " + number
				}
				out = append(out, post(draft{l, s.amount}))
			}
			continue
		}
		if b.IsChannel() {
			continue
		}
		l := base
		l.ID, l.Kind, l.Description, l.Part = p.ID, kind, description, PartRoom
		out = append(out, post(draft{l, p.Amount}))
	}
	return out
}

// orderLines: a delivered order posts one line per code with its items on the house, its share of
// the discount and its service and PB1; menu prices include the tax.
func orderLines(b Booking, orders []Order, tax *TaxSettings) []FolioLine {
	var out []FolioLine
	for _, o := range orders {
		if o.BookingID != b.ID || o.Status != "delivered" {
			continue
		}
		date := o.RequestedOn
		if o.DeliveredOn != nil {
			date = *o.DeliveredOn
		}
		minutes := o.RequestedAt
		if o.DeliveredAt != nil {
			minutes = *o.DeliveredAt
		}
		postedBy := o.Assignee
		for i := len(o.History) - 1; i >= 0; i-- {
			if o.History[i].Kind == "delivered" {
				postedBy = o.History[i].By
				break
			}
		}
		base := FolioLine{Date: date, Ref: FolioRef{Type: "order", ID: o.ID, Label: o.Number}, PostedBy: postedBy, PostedAt: at(date, clockOf(minutes)), Part: PartOrders, OrderID: str(o.ID)}
		net := CodeSplit(o)
		var codes []string
		for _, l := range o.Lines {
			if c := MenuCategoryCode[l.Category]; !contains(codes, c) {
				codes = append(codes, c)
			}
		}
		for _, code := range codes {
			var mine []OrderLine
			var gross, comp, charged int64
			for _, l := range o.Lines {
				if MenuCategoryCode[l.Category] == code {
					mine = append(mine, l)
					gross += LineAmount(l)
					if l.Comp {
						comp += LineAmount(l)
					}
				}
			}
			for _, r := range net {
				if r.Key == code {
					charged = r.Amount
				}
			}
			discount := gross - comp - charged
			rates := RatesOn(tax, date)
			split := Split(charged, code, rates, ModeInclusive)
			factor := 1.0
			switch {
			case charged > 0:
				factor = float64(split.Net) / float64(charged)
			case gross > 0:
				factor = float64(Split(gross, code, rates, ModeInclusive).Net) / float64(gross)
			}
			compNet := jsRound(float64(comp) * factor)
			discountNet := jsRound(float64(discount) * factor)
			id := o.ID + "-" + code
			l := base
			l.Code, l.ID, l.Kind, l.Description = code, id, KindRoomService, o.Number+": "+OrderSummary(mine)
			line := post(draft{l, split.Net + compNet + discountNet})
			lines := []FolioLine{line}
			if compNet > 0 {
				c := base
				c.Code, c.Of, c.ID, c.Kind, c.Description = code, str(id), id+"-comp", KindComp, o.CompReason
				if c.Description == "" {
					c.Description = "Items on the house"
				}
				lines = append(lines, post(draft{c, compNet}))
			}
			if discountNet > 0 {
				d := base
				d.Code, d.Of, d.ID, d.Kind = code, str(id), id+"-discount", KindDiscount
				d.Description = pct(o.DiscountPct) + "% off " + o.Number
				if o.DiscountReason != "" {
					d.Description += ": " + o.DiscountReason
				}
				lines = append(lines, post(draft{d, discountNet}))
			}
			if gross > 0 {
				out = append(out, lines...)
				out = append(out, taxLines(line, split, nil)...)
			}
		}
	}
	return out
}

func postingLines(b Booking, postings []Posting) []FolioLine {
	var mine []Posting
	for _, p := range postings {
		if p.BookingID == b.ID {
			mine = append(mine, p)
		}
	}
	var out []FolioLine
	for _, p := range mine {
		base := FolioLine{ID: p.ID, Date: p.Date, Kind: p.Kind, Code: p.Code, Description: p.Description, PostedBy: p.PostedBy, PostedAt: p.PostedAt, Part: p.Part, OrderID: p.OrderID}
		if p.Kind == KindTransfer {
			base.Ref = FolioRef{Type: "posting", ID: p.ID, Label: p.Code}
			out = append(out, post(draft{base, p.Amount}))
			continue
		}
		base.Ref = FolioRef{Type: "posting", ID: p.ID, Label: "Rebate " + p.Code}
		if p.Kind == KindCharge {
			base.Ref.Label = p.Code
		}
		base.Of = p.LineID
		line := post(draft{base, p.Amount})
		out = append(out, line)
		var rebateOf *string
		if p.Kind == KindRebate {
			rebateOf = p.LineID
		}
		out = append(out, taxLines(line, TaxSplit{Service: deref(p.Service), PB1: deref(p.PB1)}, rebateOf)...)
	}
	// Charges taken at check-out: one credit per cash-in for the charges less the rebates it covered.
	var txIDs []string
	for _, p := range mine {
		if p.Part == PartCharges && p.TransactionID != nil && !contains(txIDs, *p.TransactionID) {
			txIDs = append(txIDs, *p.TransactionID)
		}
	}
	for _, txID := range txIDs {
		var amount int64
		var last *Posting
		for i, p := range mine {
			if p.Part != PartCharges || p.TransactionID == nil || *p.TransactionID != txID {
				continue
			}
			if p.Kind == KindCharge {
				amount += p.Gross()
			} else {
				amount -= p.Gross()
			}
			if last == nil || p.PostedAt > last.PostedAt {
				last = &mine[i]
			}
		}
		date := last.Date
		if b.CheckedOutOn != nil {
			date = *b.CheckedOutOn
		}
		if amount > 0 {
			method := ""
			if last.PaidBy != nil {
				method = *last.PaidBy
			}
			l := FolioLine{ID: txID + "-charges", Date: date, Kind: KindPayment, Code: MethodCode(method), Description: "Charges paid at check-out",
				Ref: FolioRef{Type: "booking", ID: b.ID, Label: b.Code}, PostedBy: "Front desk", PostedAt: at(date, "11:00:00"), Part: PartCharges}
			out = append(out, post(draft{l, amount}))
		}
	}
	return out
}

func deskLines(b Booking) []FolioLine {
	ref := FolioRef{Type: "booking", ID: b.ID, Label: b.Code}
	inOn, outOn := b.CheckIn, b.CheckOut
	if b.CheckedInOn != nil {
		inOn = *b.CheckedInOn
	}
	if b.CheckedOutOn != nil {
		outOn = *b.CheckedOutOn
	}
	held := FolioLine{Ref: ref, PostedBy: "Front desk", Part: PartRoom, Code: PaymentMethodCode["cash"], Kind: KindDeposit}
	var out []FolioLine
	if b.Arrival != nil && b.Arrival.Deposit > 0 {
		l := held
		l.ID, l.Date, l.Description, l.PostedAt = b.ID+"-deposit", inOn, "Security deposit held", at(inOn, "14:00:00")
		out = append(out, post(draft{l, int64(b.Arrival.Deposit)}))
	}
	if b.Departure != nil && b.Departure.DepositReturned > 0 {
		l := held
		l.ID, l.Date, l.Description, l.PostedAt = b.ID+"-deposit-back", outOn, "Security deposit returned", at(outOn, "11:00:00")
		out = append(out, post(draft{l, -int64(b.Departure.DepositReturned)}))
	}
	if b.Departure != nil && b.Departure.ExtraCharges > 0 {
		base := FolioLine{Date: outOn, Ref: ref, PostedBy: "Front desk", PostedAt: at(outOn, "10:59:00"), Part: PartCharges}
		d := base
		d.Code, d.ID, d.Kind, d.Description = OtherCode, b.ID+"-departure", KindDeparture, b.Departure.Notes
		if d.Description == "" {
			d.Description = "Charged at check-out"
		}
		p := base
		p.Code, p.ID, p.Kind, p.Description = PaymentMethodCode["cash"], b.ID+"-departure-paid", KindPayment, "Departure charges paid at check-out"
		amount := int64(b.Departure.ExtraCharges)
		out = append(out, post(draft{d, amount}), post(draft{p, amount}))
	}
	return out
}

func net(lines []FolioLine, keep func(FolioLine) bool) int64 {
	var s int64
	for _, l := range lines {
		if keep(l) {
			s += l.Debit - l.Credit
		}
	}
	return s
}

// RunningBalance is runningBalance: the balance after each line; a forecast line leaves it be.
func RunningBalance(sorted []FolioLine) (lines []FolioLine, debits, credits, forecast int64) {
	var running int64
	lines = make([]FolioLine, len(sorted))
	for i, l := range sorted {
		if !l.Forecast {
			running += l.Debit - l.Credit
			debits += l.Debit
			credits += l.Credit
		} else {
			forecast += l.Debit - l.Credit
		}
		l.Balance = running
		lines[i] = l
	}
	return lines, debits, credits, forecast
}

func chargeSide(l FolioLine) bool {
	return l.Kind != KindPayment && l.Kind != KindRefund && l.Kind != KindDeposit && l.Kind != KindChannel && l.Kind != KindTransfer
}

func billTaxes(lines []FolioLine) BillTaxes {
	on := func(pick func(string) bool) int64 {
		return net(lines, func(l FolioLine) bool { return chargeSide(l) && pick(l.Code) })
	}
	t := BillTaxes{
		Service:  on(func(c string) bool { return c == ServiceCode }),
		PB1:      on(func(c string) bool { return c == PB1Code }),
		Subtotal: on(func(c string) bool { return c != ServiceCode && c != PB1Code }),
	}
	t.Total = t.Subtotal + t.Service + t.PB1
	return t
}

// Folio is guestFolio.
func Folio(src FolioSources) GuestFolio {
	b := src.Booking
	var all []FolioLine
	all = append(all, roomLines(b, src.Payments, src.Tax)...)
	all = append(all, orderLines(b, src.Orders, src.Tax)...)
	all = append(all, postingLines(b, src.Postings)...)
	all = append(all, deskLines(b)...)
	all = append(all, paymentLines(b, src.Payments, src.Payments, src.Orders)...)
	sorted := make([]FolioLine, 0, len(all))
	for _, l := range all {
		if !(src.RoomOnMaster && OnMaster(l)) {
			sorted = append(sorted, l)
		}
	}
	sort.SliceStable(sorted, func(i, j int) bool { return byPosting(sorted[i], sorted[j]) })
	lines, debitSum, creditSum, forecast := RunningBalance(sorted)
	room := net(lines, func(l FolioLine) bool { return l.Part == PartRoom })
	charges := net(lines, func(l FolioLine) bool { return l.Part == PartCharges })
	var orderIDs []string
	for _, l := range lines {
		if l.OrderID != nil && !contains(orderIDs, *l.OrderID) {
			orderIDs = append(orderIDs, *l.OrderID)
		}
	}
	f := GuestFolio{Lines: lines, Debits: debitSum, Credits: creditSum, Balance: debitSum - creditSum, Forecast: forecast,
		Estimated: debitSum - creditSum + forecast, Due: FolioDue{Room: max(0, room), Orders: []OrderDue{}, Charges: max(0, charges)}, Taxes: billTaxes(lines)}
	f.RefundDue = max(0, -room) + max(0, -charges)
	for _, id := range orderIDs {
		amount := net(lines, func(l FolioLine) bool { return l.OrderID != nil && *l.OrderID == id })
		if amount > 0 {
			f.Due.Orders = append(f.Due.Orders, OrderDue{OrderID: id, Amount: amount})
		}
		f.RefundDue += max(0, -amount)
	}
	for _, l := range lines {
		f.DepositHeld += l.Memo
	}
	if f.Lines == nil {
		f.Lines = []FolioLine{}
	}
	return f
}

// Refundable is refundable: the credit a refund of p may pay back, never more than p still holds.
func Refundable(f GuestFolio, p Payment, refunded int64) int64 {
	var credit int64
	if p.ForOrders() {
		for _, id := range p.OrderIDs {
			credit += max(0, -net(f.Lines, func(l FolioLine) bool { return l.OrderID != nil && *l.OrderID == id }))
		}
	} else {
		credit = max(0, -net(f.Lines, func(l FolioLine) bool { return l.Part == PartRoom }))
	}
	return max(0, min(credit, p.Amount-refunded))
}
