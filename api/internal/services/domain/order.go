package domain

import (
	"fmt"
	"math"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Order statuses.
const (
	OrderNew       = "new"
	OrderConfirmed = "confirmed"
	OrderPreparing = "preparing"
	OrderDelivered = "delivered"
	OrderCancelled = "cancelled"
	OrderVoided    = "voided"
)

// OrderStatusLabel is ORDER_STATUS_LABEL.
var OrderStatusLabel = map[string]string{
	OrderNew: "New", OrderConfirmed: "Accepted", OrderPreparing: "Preparing", OrderDelivered: "Delivered",
	OrderCancelled: "Cancelled", OrderVoided: "Voided",
}

// OrderTransitions is ORDER_TRANSITIONS.
var OrderTransitions = map[string][]string{
	OrderNew:       {OrderConfirmed, OrderCancelled},
	OrderConfirmed: {OrderPreparing, OrderDelivered, OrderCancelled},
	OrderPreparing: {OrderDelivered, OrderCancelled},
	OrderDelivered: {OrderVoided},
	OrderCancelled: {},
	OrderVoided:    {},
}

// CanTransitionOrder is canTransitionOrder.
func CanTransitionOrder(from, to string) bool { return slices.Contains(OrderTransitions[from], to) }

// IsOpenOrder is isOpenOrder: new, accepted or preparing.
func IsOpenOrder(status string) bool {
	return status == OrderNew || status == OrderConfirmed || status == OrderPreparing
}

// CheckStep refuses a step the board does not allow, and a cancellation or void without a reason.
func (o ServiceOrder) CheckStep(to, note string) error {
	if !CanTransitionOrder(o.Status, to) {
		return errs.New(CodeOrderState, fmt.Sprintf("A %s order cannot become %s.", strings.ToLower(OrderStatusLabel[o.Status]), strings.ToLower(OrderStatusLabel[to])))
	}
	short := len([]rune(strings.TrimSpace(note))) < 3
	if to == OrderCancelled && short {
		return errs.New(errs.CodeValidation, "Say why the order is cancelled.")
	}
	if to == OrderVoided && short {
		return errs.New(errs.CodeValidation, "Say why the delivery is voided.")
	}
	return nil
}

// CheckVoid is the mock's voidDelivery guard: a delivery voids only on its business day, while it
// is neither paid, on a link, nor rebated, and no partner bill of it is paid.
func (o ServiceOrder) CheckVoid(businessDate, payState string, rebated bool, bills []CostBill) error {
	on := ""
	if o.DeliveredOn != nil {
		on = *o.DeliveredOn
	}
	if on != businessDate {
		return errs.New(CodeVoidDayClosed, fmt.Sprintf("%s was delivered on %s, a business day already closed; post a rebate on its line instead.", o.Number, on))
	}
	switch {
	case payState == PayPaid:
		return errs.New(CodeOrderVoidPaid, o.Number+" is paid; post a rebate and refund the guest instead.")
	case payState == PayPending:
		return errs.New(CodeOrderVoidPaid, o.Number+" is on a payment link; post a rebate and refund the guest instead.")
	case rebated:
		return errs.New(CodeOrderVoidPaid, o.Number+" already has a rebate; post another rebate instead.")
	case slices.ContainsFunc(bills, func(b CostBill) bool { return b.Status == BillPosted }):
		return errs.New(CodeOrderVoidPaid, "A partner bill of "+o.Number+" is already paid; post a rebate instead.")
	}
	return nil
}

// Step moves the order to `to` and adds the history line; delivery stamps the day and minute.
func (o *ServiceOrder) Step(to, note, by, at, today string, minute int) {
	o.Status = to
	if to == OrderDelivered {
		o.DeliveredOn, o.DeliveredAt = &today, &minute
	}
	o.History = append(o.History, OrderEvent{Kind: to, By: by, At: at, Note: strings.TrimSpace(note)})
}

// OrderLine is a menu item as it was ordered: name and prices are copied so later menu edits
// leave the bill alone.
type OrderLine struct {
	ItemID    string  `json:"itemId"`
	Name      string  `json:"name"`
	Category  string  `json:"category"`
	Unit      string  `json:"unit"`
	Price     int64   `json:"price"`
	Quantity  float64 `json:"quantity"`
	CostPrice int64   `json:"costPrice"`
	PartnerID *string `json:"partnerId"`
	// Comp is on the house: the guest pays nothing for it, the partner is still paid.
	Comp bool `json:"comp"`
}

// OrderEvent is one step in an order's history.
type OrderEvent struct {
	Kind string `json:"kind"`
	By   string `json:"by"`
	At   string `json:"at"`
	Note string `json:"note"`
}

// ServiceOrder is ServiceOrder.
type ServiceOrder struct {
	ID                 string       `json:"id"`
	Number             string       `json:"number"`
	BookingID          string       `json:"bookingId"`
	UnitID             string       `json:"unitId"`
	VillaID            string       `json:"villaId"`
	Lines              []OrderLine  `json:"lines"`
	Note               string       `json:"note"`
	RequestedOn        string       `json:"requestedOn"`
	RequestedAt        int          `json:"requestedAt"`
	Priority           string       `json:"priority"`
	Status             string       `json:"status"`
	Assignee           string       `json:"assignee"`
	PlacedBy           string       `json:"placedBy"`
	CreatedOn          string       `json:"createdOn"`
	DeliveredOn        *string      `json:"deliveredOn"`
	DeliveredAt        *int         `json:"deliveredAt"`
	DiscountPct        float64      `json:"discountPct"`
	DiscountReason     string       `json:"discountReason"`
	CompReason         string       `json:"compReason"`
	PaymentID          *string      `json:"paymentId"`
	CostTransactionIDs []string     `json:"costTransactionIds"`
	History            []OrderEvent `json:"history"`
	Version            int64        `json:"-"`
}

// jsRound is Math.round for the positive amounts orders carry.
func jsRound(v float64) int64 { return int64(math.Floor(v + 0.5)) }

// LineAmount is lineAmount.
func LineAmount(l OrderLine) int64 { return jsRound(float64(l.Price) * l.Quantity) }

// LineCost is lineCost.
func LineCost(l OrderLine) int64 { return jsRound(float64(l.CostPrice) * l.Quantity) }

// Totals is OrderTotals.
type Totals struct {
	Gross, Comp, Discount, Charge, Cost, Margin int64
}

// OrderTotals is orderTotals.
func OrderTotals(lines []OrderLine, discountPct float64) Totals {
	var t Totals
	for _, l := range lines {
		t.Gross += LineAmount(l)
		t.Cost += LineCost(l)
		if l.Comp {
			t.Comp += LineAmount(l)
		}
	}
	t.Discount = jsRound(float64(t.Gross-t.Comp) * discountPct / 100)
	t.Charge = t.Gross - t.Comp - t.Discount
	t.Margin = t.Charge - t.Cost
	return t
}

// Totals returns the order's totals.
func (o ServiceOrder) Totals() Totals { return OrderTotals(o.Lines, o.DiscountPct) }

// Share is one part of a split charge.
type Share struct {
	Key    string
	Amount int64
}

// chargeSplit splits the charge by a key of the line; the discount spreads pro rata and rounding
// lands on the biggest share.
func chargeSplit(o ServiceOrder, keyOf func(OrderLine) string) []Share {
	charge := o.Totals().Charge
	var gross []Share
	index := map[string]int{}
	var before int64
	for _, l := range o.Lines {
		if l.Comp {
			continue
		}
		k := keyOf(l)
		i, ok := index[k]
		if !ok {
			i = len(gross)
			index[k] = i
			gross = append(gross, Share{Key: k})
		}
		gross[i].Amount += LineAmount(l)
		before += LineAmount(l)
	}
	if before == 0 || charge == 0 {
		return []Share{}
	}
	shares := make([]Share, len(gross))
	var sum int64
	for i, g := range gross {
		shares[i] = Share{Key: g.Key, Amount: int64(math.Floor(float64(g.Amount) * float64(charge) / float64(before)))}
		sum += shares[i].Amount
	}
	sort.SliceStable(shares, func(a, b int) bool { return shares[a].Amount > shares[b].Amount })
	shares[0].Amount += charge - sum
	out := shares[:0]
	for _, s := range shares {
		if s.Amount > 0 {
			out = append(out, s)
		}
	}
	return out
}

// RevenueSplit is revenueSplit: the charge per income category.
func RevenueSplit(o ServiceOrder) []Share {
	return chargeSplit(o, func(l OrderLine) string { return RevenueCategory[l.Category] })
}

// CodeSplit is codeSplit: the charge per transaction code, for the folio.
func CodeSplit(o ServiceOrder) []Share {
	return chargeSplit(o, func(l OrderLine) string { return CategoryCode[l.Category] })
}

// PartnerBill is one partner's bill for an order.
type PartnerBill struct {
	PartnerID string
	Amount    int64
	Lines     []OrderLine
}

// PartnerCosts is partnerCosts: the bill per partner, in the order partners first appear.
func PartnerCosts(o ServiceOrder) []PartnerBill {
	var out []PartnerBill
	index := map[string]int{}
	for _, l := range o.Lines {
		if l.PartnerID == nil || l.CostPrice <= 0 {
			continue
		}
		i, ok := index[*l.PartnerID]
		if !ok {
			i = len(out)
			index[*l.PartnerID] = i
			out = append(out, PartnerBill{PartnerID: *l.PartnerID})
		}
		out[i].Lines = append(out[i].Lines, l)
		out[i].Amount += LineCost(l)
	}
	return out
}

// CostBill is where finance stands on one partner's bill for a delivered order.
type CostBill struct {
	TransactionID string
	PartnerID     string
	Status        string
	Version       int64
}

// BillPosted is the status of a bill finance has paid.
const BillPosted = "posted"

// CostTransactionIDs lists the order's bills in the order of PartnerCosts, as the mock stores
// costTransactionIds: the reports and the partner balances read a bill's partner by its index.
func CostTransactionIDs(o ServiceOrder, bills []CostBill) []string {
	at := map[string]int{}
	for i, c := range PartnerCosts(o) {
		at[c.PartnerID] = i
	}
	rank := func(b CostBill) int {
		if i, ok := at[b.PartnerID]; ok {
			return i
		}
		return len(at)
	}
	sorted := slices.Clone(bills)
	slices.SortStableFunc(sorted, func(a, b CostBill) int { return rank(a) - rank(b) })
	ids := make([]string, len(sorted))
	for i, b := range sorted {
		ids[i] = b.TransactionID
	}
	return ids
}

// Pay states.
const (
	PayNotDue  = "not_due"
	PayFree    = "free"
	PayUnpaid  = "unpaid"
	PayPending = "pending"
	PayPaid    = "paid"
)

// PayState is payState; paymentStatus is the status of the order's latest payment, "" when it
// has none.
func PayState(o ServiceOrder, paymentStatus string) string {
	switch {
	case o.Status != OrderDelivered:
		return PayNotDue
	case o.Totals().Charge == 0:
		return PayFree
	case paymentStatus == "paid":
		return PayPaid
	case paymentStatus == "pending":
		return PayPending
	default:
		return PayUnpaid
	}
}

// Folio is room service on one stay: what delivered orders charge and what is settled.
type Folio struct {
	Charged, Paid, Pending, Outstanding int64
}

// StayFolio is folio; statusOf returns the status of a payment id ("" for none).
func StayFolio(orders []ServiceOrder, statusOf func(paymentID *string) string) Folio {
	var f Folio
	for _, o := range orders {
		if o.Status != OrderDelivered {
			continue
		}
		charge := o.Totals().Charge
		f.Charged += charge
		switch PayState(o, statusOf(o.PaymentID)) {
		case PayPaid:
			f.Paid += charge
		case PayPending:
			f.Pending += charge
			f.Outstanding += charge
		case PayUnpaid:
			f.Outstanding += charge
		}
	}
	return f
}

// OrderSLAMinutes is ORDER_SLA_MINUTES.
const OrderSLAMinutes = 30

// OrderLate is orderLate: an open order past its requested time and the SLA.
func OrderLate(o ServiceOrder, today string, nowMinutes int) bool {
	if !IsOpenOrder(o.Status) {
		return false
	}
	return o.RequestedOn < today || (o.RequestedOn == today && nowMinutes > o.RequestedAt+OrderSLAMinutes)
}

// DeliveryDelay is deliveryDelay: minutes from the requested time to delivery, zero when early,
// nil before delivery.
func DeliveryDelay(o ServiceOrder) *int {
	if o.DeliveredOn == nil || o.DeliveredAt == nil {
		return nil
	}
	d := max(0, clock.DaysBetween(o.RequestedOn, *o.DeliveredOn)*24*60+*o.DeliveredAt-o.RequestedAt)
	return &d
}

// OrderArrivalDays is ORDER_ARRIVAL_DAYS.
const OrderArrivalDays = 3

// OrderableStay is orderableStay: in house, or confirmed and arriving within three days.
func OrderableStay(status, checkIn, today string) bool {
	return status == "checked_in" || (status == "confirmed" && checkIn >= today && checkIn <= clock.AddDays(today, OrderArrivalDays))
}

// OrderLineInput is OrderLineInput.
type OrderLineInput struct {
	ItemID   string  `json:"itemId"`
	Quantity float64 `json:"quantity"`
	Comp     bool    `json:"comp"`
}

// OrderInput is OrderInput; a guest's order fills only the lines, note and time.
type OrderInput struct {
	BookingID      string           `json:"bookingId"`
	Lines          []OrderLineInput `json:"lines"`
	Note           string           `json:"note"`
	RequestedOn    string           `json:"requestedOn"`
	RequestedAt    float64          `json:"requestedAt"`
	Priority       string           `json:"priority"`
	DiscountPct    float64          `json:"discountPct"`
	DiscountReason string           `json:"discountReason"`
	CompReason     string           `json:"compReason"`
}

// MaxQuantity is MAX_QUANTITY.
const MaxQuantity = 50

var isoDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// ValidateOrder is validateOrder.
func ValidateOrder(in OrderInput) error {
	var f errs.Fields
	badQuantity := func(q float64) bool {
		return !(q >= 0.1) || q > MaxQuantity || math.Abs(float64(jsRound(q*10))-q*10) > 1e-9
	}
	if len(in.Lines) == 0 {
		f.Add("lines", "Add at least one item.")
	} else if slices.ContainsFunc(in.Lines, func(l OrderLineInput) bool { return badQuantity(l.Quantity) }) {
		f.Add("lines", fmt.Sprintf("Quantities run from 0.1 to %d, in steps of 0.1.", MaxQuantity))
	}
	if !isoDate.MatchString(in.RequestedOn) {
		f.Add("requestedOn", "Pick the day.")
	}
	if !isInt(in.RequestedAt) || in.RequestedAt < 0 || in.RequestedAt >= 24*60 {
		f.Add("requestedAt", "Pick the time.")
	}
	if !(in.DiscountPct >= 0 && in.DiscountPct <= 100) {
		f.Add("discountPct", "A percentage from 0 to 100.")
	} else if in.DiscountPct > 0 && len([]rune(strings.TrimSpace(in.DiscountReason))) < 3 {
		f.Add("discountReason", "Say why the order is discounted.")
	}
	if slices.ContainsFunc(in.Lines, func(l OrderLineInput) bool { return l.Comp }) && len([]rune(strings.TrimSpace(in.CompReason))) < 3 {
		f.Add("compReason", "Say why it is on the house.")
	}
	return f.Err()
}

// Codes an order refusal carries.
const (
	CodeOrderNoStay      = "ORDER_NO_STAY"
	CodeItemUnavailable  = "ITEM_UNAVAILABLE"
	CodeItemLeadTime     = "ITEM_LEAD_TIME"
	CodeCompForbidden    = "COMP_FORBIDDEN"
	CodeDiscountLimit    = "DISCOUNT_LIMIT"
	CodeOrderState       = "ORDER_INVALID_STATE"
	CodeOrderNotBillable = "ORDER_NOT_BILLABLE"
	CodeVoidDayClosed    = "VOID_DAY_CLOSED"
	CodeOrderVoidPaid    = "ORDER_VOID_PAID"
)

// ItemProblem is itemProblem: why an item cannot be ordered for that time, or nil.
func ItemProblem(item MenuItem, requestedOn string, requestedAt int, today string, nowMinutes int) error {
	if !item.Active {
		return errs.New(CodeItemUnavailable, item.Name+" is off the menu.")
	}
	if !AvailableAt(item.AvailableFrom, item.AvailableTo, requestedAt) {
		return errs.New(CodeItemUnavailable, fmt.Sprintf("%s is served %s.", item.Name, HoursLabel(item.AvailableFrom, item.AvailableTo)))
	}
	if requestedOn < today {
		return errs.New(errs.CodeValidation, "Pick a time from now on.")
	}
	if requestedOn == today && requestedAt < nowMinutes+item.LeadMinutes {
		return errs.New(CodeItemLeadTime, fmt.Sprintf("%s needs %s; pick %s or later.", item.Name, LeadLabel(item.LeadMinutes), ClockLabel(min(24*60-1, nowMinutes+item.LeadMinutes))))
	}
	return nil
}

// Quantity formats a quantity as JavaScript prints a number: 2, 2.5.
func Quantity(q float64) string { return strconv.FormatFloat(q, 'f', -1, 64) }

// OrderSummary is orderSummary: "2 × Balinese breakfast, 1 × Fresh coconut".
func OrderSummary(lines []OrderLine) string {
	parts := make([]string, len(lines))
	for i, l := range lines {
		parts[i] = Quantity(l.Quantity) + " × " + l.Name
	}
	return strings.Join(parts, ", ")
}

// OrderToken is orderTokenFor: the token printed on a room's QR card, the unit code with a short
// FNV-1a hash, readable and hard to guess for another room.
func OrderToken(unitCode string) string {
	h := uint32(2166136261)
	for _, c := range "menu:" + unitCode {
		h = (h ^ uint32(c)) * 16777619
	}
	tail := strconv.FormatUint(uint64(h), 36)
	if len(tail) > 5 {
		tail = tail[:5]
	}
	return strings.ToLower(unitCode) + "-" + tail
}

// SortOrders is sortOrders: live orders first, urgent and earliest requested on top; finished
// ones newest first.
func SortOrders(list []ServiceOrder) []ServiceOrder {
	rank := map[string]int{OrderNew: 0, OrderConfirmed: 1, OrderPreparing: 1, OrderDelivered: 2, OrderCancelled: 3, OrderVoided: 3}
	urgent := func(o ServiceOrder) int {
		if o.Priority == "urgent" {
			return 0
		}
		return 1
	}
	when := func(o ServiceOrder) string { return fmt.Sprintf("%s %04d", o.RequestedOn, o.RequestedAt) }
	out := slices.Clone(list)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if rank[a.Status] != rank[b.Status] {
			return rank[a.Status] < rank[b.Status]
		}
		if urgent(a) != urgent(b) {
			return urgent(a) < urgent(b)
		}
		if rank[a.Status] >= 2 {
			return when(b) < when(a)
		}
		return when(a) < when(b)
	})
	return out
}

// PaymentMethodLabel is PAYMENT_METHOD_LABEL.
var PaymentMethodLabel = map[string]string{"cash": "Cash", "bank_transfer": "Bank transfer", "card": "Card", "qris": "QRIS",
	"virtual_account": "Virtual account", "airbnb_payout": "Airbnb payout"}

// MarkPaid is markOrdersPaid for one order: it points at the payment that settled it, with a
// paid step naming the payment and its method. It reports false when the order already points at
// that payment, so a redelivered payment changes nothing.
func MarkPaid(o *ServiceOrder, paymentID, number, method, by, at string) bool {
	if o.PaymentID != nil && *o.PaymentID == paymentID {
		return false
	}
	o.PaymentID = &paymentID
	o.History = append(o.History, OrderEvent{Kind: "paid", By: by, At: at, Note: number + ", " + PaymentMethodLabel[method]})
	return true
}
