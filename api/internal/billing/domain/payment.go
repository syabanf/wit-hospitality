package domain

import (
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Payment kinds, methods and their labels, from payment.ts.
var (
	PaymentKinds     = []string{"deposit", "balance", "full", "extra", "refund", "payout"}
	PaymentKindLabel = map[string]string{"deposit": "Deposit", "balance": "Balance", "full": "Full payment", "extra": "Extras", "refund": "Refund", "payout": "Airbnb payout"}
	PaymentMethods   = []string{"cash", "bank_transfer", "card", "qris", "virtual_account", "airbnb_payout"}
	MethodLabel      = map[string]string{"cash": "Cash", "bank_transfer": "Bank transfer", "card": "Card", "qris": "QRIS", "virtual_account": "Virtual account", "airbnb_payout": "Airbnb payout"}
	GatewayMethods   = []string{"qris", "virtual_account", "card"}
	DeskMethods      = []string{"cash", "bank_transfer"}
)

// IsGateway is isGateway.
func IsGateway(method string) bool { return slices.Contains(GatewayMethods, method) }

// PaymentEvent is one step of a payment.
type PaymentEvent struct {
	Kind string `json:"kind"`
	By   string `json:"by"`
	At   string `json:"at"`
	Note string `json:"note"`
}

// Payment is Payment.
type Payment struct {
	ID                  string         `json:"id"`
	Number              string         `json:"number"`
	BookingID           string         `json:"bookingId"`
	Kind                string         `json:"kind"`
	Method              string         `json:"method"`
	Amount              int64          `json:"amount"`
	Status              string         `json:"status"`
	DueOn               *string        `json:"dueOn"`
	PaidOn              *string        `json:"paidOn"`
	Reference           string         `json:"reference"`
	Payer               string         `json:"payer"`
	Note                string         `json:"note"`
	TransactionID       *string        `json:"transactionId"`
	FeeTransactionID    *string        `json:"feeTransactionId"`
	GatewayFee          int64          `json:"gatewayFee"`
	RefundOf            *string        `json:"refundOf"`
	OrderIDs            []string       `json:"orderIds,omitempty"`
	OrderAmounts        []int64        `json:"orderAmounts,omitempty"`
	ExtraTransactionIDs []string       `json:"extraTransactionIds,omitempty"`
	GroupID             string         `json:"groupId,omitempty"`
	Batch               string         `json:"batch,omitempty"`
	ShiftID             string         `json:"shiftId,omitempty"`
	CreatedBy           string         `json:"createdBy"`
	CreatedOn           string         `json:"createdOn"`
	History             []PaymentEvent `json:"history"`
}

// ForOrders is forOrders: the payment settles room service orders.
func (p Payment) ForOrders() bool { return len(p.OrderIDs) > 0 }

// NetPaid is netPaid: money in less refunds out on the stay itself.
func NetPaid(payments []Payment, bookingID string) int64 {
	var s int64
	for _, p := range payments {
		if p.BookingID != bookingID || p.ForOrders() || (p.Status != "paid" && p.Status != "refunded") {
			continue
		}
		if p.Kind == "refund" {
			s -= p.Amount
		} else {
			s += p.Amount
		}
	}
	return s
}

// SettledStatus is settledStatus.
func SettledStatus(paid, total int64) string {
	switch {
	case paid <= 0:
		return "unpaid"
	case paid >= total:
		return "paid"
	}
	return "partial"
}

// CheckOut is a settle link's check-out: the departure record, who asked and the charges it takes.
type CheckOut struct {
	Details      Departure `json:"details"`
	By           string    `json:"by"`
	FolioCharges int64     `json:"folioCharges,omitempty"`
}

// PaymentLink is PaymentLink.
type PaymentLink struct {
	Token      string            `json:"token"`
	BookingID  string            `json:"bookingId"`
	PaymentID  string            `json:"paymentId"`
	Method     string            `json:"method"`
	Amount     int64             `json:"amount"`
	CreatedAt  string            `json:"createdAt"`
	ExpiresAt  string            `json:"expiresAt"`
	Status     string            `json:"status"`
	VABank     string            `json:"vaBank"`
	VANumber   string            `json:"vaNumber"`
	QRPayload  string            `json:"qrPayload"`
	GatewayFee int64             `json:"gatewayFee"`
	Proofs     []json.RawMessage `json:"proofs"`
	Bundle     []string          `json:"bundle,omitempty"`
	CheckOut   *CheckOut         `json:"checkOut,omitempty"`
}

// Policy is PaymentPolicy.
type Policy struct {
	DepositPct       float64 `json:"depositPct"`
	BalanceDueDays   float64 `json:"balanceDueDays"`
	LinkExpiryHours  float64 `json:"linkExpiryHours"`
	CardFeePct       float64 `json:"cardFeePct"`
	QRISFeePct       float64 `json:"qrisFeePct"`
	VAFee            float64 `json:"vaFee"`
	AutoCancelDays   float64 `json:"autoCancelDays"`
	FreeCancelDays   float64 `json:"freeCancelDays"`
	DiscountLimitPct float64 `json:"discountLimitPct"`
}

// DefaultPolicy is DEFAULT_PAYMENT_POLICY.
var DefaultPolicy = Policy{DepositPct: 30, BalanceDueDays: 7, LinkExpiryHours: 24, CardFeePct: 2.9, QRISFeePct: 0.7, VAFee: 4000, AutoCancelDays: 3, FreeCancelDays: 14, DiscountLimitPct: 10}

func intIn(v, lo, hi float64) bool { return whole(v) && v >= lo && v <= hi }

// ValidatePolicy is validatePolicy.
func ValidatePolicy(p Policy) error {
	var f errs.Fields
	if !(p.DepositPct >= 0 && p.DepositPct <= 100) {
		f.Add("depositPct", "A percentage from 0 to 100.")
	}
	if !intIn(p.BalanceDueDays, 0, 60) {
		f.Add("balanceDueDays", "0 to 60 days.")
	}
	if !intIn(p.LinkExpiryHours, 1, 168) {
		f.Add("linkExpiryHours", "1 to 168 hours.")
	}
	if !(p.CardFeePct >= 0 && p.CardFeePct <= 10) {
		f.Add("cardFeePct", "0 to 10 percent.")
	}
	if !(p.QRISFeePct >= 0 && p.QRISFeePct <= 10) {
		f.Add("qrisFeePct", "0 to 10 percent.")
	}
	if !whole(p.VAFee) || p.VAFee < 0 {
		f.Add("vaFee", "Whole rupiah, zero or more.")
	}
	if !intIn(p.AutoCancelDays, 1, 30) {
		f.Add("autoCancelDays", "1 to 30 days.")
	}
	if !intIn(p.FreeCancelDays, 0, 90) {
		f.Add("freeCancelDays", "0 to 90 days.")
	}
	if !(p.DiscountLimitPct >= 0 && p.DiscountLimitPct <= 100) {
		f.Add("discountLimitPct", "A percentage from 0 to 100.")
	}
	return f.Err()
}

// GatewayFee is gatewayFee.
func GatewayFee(method string, amount int64, p Policy) int64 {
	switch method {
	case "card":
		return jsRound(float64(amount) * p.CardFeePct / 100)
	case "qris":
		return jsRound(float64(amount) * p.QRISFeePct / 100)
	case "virtual_account":
		return int64(p.VAFee)
	}
	return 0
}

// DepositAmount is depositAmount: the deposit share rounded to Rp 10,000.
func DepositAmount(total int64, p Policy) int64 {
	return jsRound(float64(total)*p.DepositPct/100/10_000) * 10_000
}

// BalanceDueOn is balanceDueOn.
func BalanceDueOn(checkIn string, p Policy) string { return AddDays(checkIn, -int(p.BalanceDueDays)) }

// PaymentInput is PaymentInput.
type PaymentInput struct {
	BookingID     string   `json:"bookingId"`
	Kind          string   `json:"kind"`
	Method        string   `json:"method"`
	Amount        float64  `json:"amount"`
	Reference     string   `json:"reference"`
	Payer         string   `json:"payer"`
	Note          string   `json:"note"`
	AttachmentIDs []string `json:"-"`
	OrderIDs      []string `json:"orderIds"`
}

// ValidatePayment is validatePayment: outstanding is what the stay still owes; a refund checks paid.
func ValidatePayment(in PaymentInput, outstanding, paid int64) error {
	var f errs.Fields
	if in.BookingID == "" {
		f.Add("bookingId", "Pick the booking.")
	}
	if !slices.Contains(PaymentMethods, in.Method) {
		f.Add("method", "Pick the method.")
	}
	switch {
	case !whole(in.Amount) || in.Amount <= 0:
		f.Add("amount", "Enter a whole rupiah amount above zero.")
	case in.Kind == "refund" && int64(in.Amount) > paid:
		f.Add("amount", fmt.Sprintf("Only %d has been paid on this booking.", paid))
	case in.Kind != "refund" && int64(in.Amount) > outstanding:
		if outstanding > 0 {
			f.Add("amount", fmt.Sprintf("Only %d is still owed.", outstanding))
		} else {
			f.Add("amount", "Nothing is owed on this booking.")
		}
	}
	if in.Method == "bank_transfer" && len([]rune(strings.TrimSpace(in.Reference))) < 3 {
		f.Add("reference", "Enter the bank reference.")
	}
	if in.Kind == "refund" && len([]rune(strings.TrimSpace(in.Note))) < 3 {
		f.Add("note", "Say why the money goes back.")
	}
	return f.Err()
}

// SettleLine is SettleLine.
type SettleLine struct {
	Kind   string `json:"kind"`
	Label  string `json:"label"`
	Detail string `json:"detail"`
	Amount int64  `json:"amount"`
}

// OrderBill is one order on the check-out bill.
type OrderBill struct {
	Number string
	Items  string
	Amount int64
}

// SettlementLines is settlementLines.
func SettlementLines(roomDue int64, orders []OrderBill, charges, folioCharges int64) []SettleLine {
	lines := []SettleLine{}
	if roomDue > 0 {
		lines = append(lines, SettleLine{Kind: PartRoom, Label: "Room balance", Detail: "What is left on the stay", Amount: roomDue})
	}
	for _, o := range orders {
		if o.Amount > 0 {
			lines = append(lines, SettleLine{Kind: PartOrders, Label: "Room service " + o.Number, Detail: o.Items, Amount: o.Amount})
		}
	}
	if folioCharges > 0 {
		lines = append(lines, SettleLine{Kind: PartCharges, Label: "Folio charges", Detail: "Posted during the stay, less allowances", Amount: folioCharges})
	}
	if charges > 0 {
		lines = append(lines, SettleLine{Kind: PartCharges, Label: "Departure charges", Detail: "Minibar, damage or late check-out", Amount: charges})
	}
	return lines
}

// ValidateSettle is validateSettle.
func ValidateSettle(method, reference string, lines []SettleLine) error {
	var f errs.Fields
	beyondCharges := false
	for _, l := range lines {
		if l.Kind != PartCharges {
			beyondCharges = true
		}
	}
	switch {
	case !slices.Contains(DeskMethods, method) && !IsGateway(method):
		f.Add("method", "Pick cash, transfer, QRIS, virtual account or card.")
	case IsGateway(method) && !beyondCharges:
		f.Add("method", "Only charges are left; take them in cash or by transfer.")
	}
	if method == "bank_transfer" && len(lines) > 0 && len([]rune(strings.TrimSpace(reference))) < 3 {
		f.Add("reference", "Enter the bank reference.")
	}
	return f.Err()
}

// hash is the mock's FNV-1a over the token.
func hash(text string) uint32 {
	h := uint32(2166136261)
	for _, c := range text {
		h = (h ^ uint32(c)) * 16777619
	}
	return h
}

// VANumberFor is vaNumberFor.
func VANumberFor(token string) string {
	s := fmt.Sprintf("%010d", hash(token))
	return "8808" + s[:10]
}

// QRPayloadFor is qrPayloadFor.
func QRPayloadFor(token string, amount int64) string {
	return "00020101021226580016ID.CO.BALIVILLA" + strings.ToUpper(token) + "5204701153033605406" + strconv.FormatInt(amount, 10) +
		"5802ID6304" + fmt.Sprintf("%04s", strings.ToUpper(strconv.FormatUint(uint64(hash(token)%65536), 16)))
}

// LinkToken is the mock's link token for counter n on a booking.
func LinkToken(n int64, bookingID string) string {
	var clean strings.Builder
	for _, c := range bookingID {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') {
			clean.WriteRune(c)
		}
	}
	tail := (n * 2654435761) % 1_000_000
	return "pl" + strconv.FormatInt(n, 10) + clean.String() + strconv.FormatInt(tail, 36)
}

// PublicCheckout is PublicCheckout: what /pay/{token} shows.
type PublicCheckout struct {
	Link          PaymentLink  `json:"link"`
	PaymentNumber string       `json:"paymentNumber"`
	PaymentStatus string       `json:"paymentStatus"`
	Kind          string       `json:"kind"`
	GuestName     string       `json:"guestName"`
	VillaName     string       `json:"villaName"`
	LocationName  string       `json:"locationName"`
	UnitCode      string       `json:"unitCode"`
	UnitName      string       `json:"unitName"`
	CheckIn       string       `json:"checkIn"`
	CheckOut      string       `json:"checkOut"`
	Nights        int          `json:"nights"`
	BookingCode   string       `json:"bookingCode"`
	Total         int64        `json:"total"`
	PaidBefore    int64        `json:"paidBefore"`
	PaidOn        *string      `json:"paidOn"`
	Reference     string       `json:"reference"`
	OrderNumbers  []string     `json:"orderNumbers,omitempty"`
	Lines         []SettleLine `json:"lines,omitempty"`
	TaxNote       *string      `json:"taxNote,omitempty"`
}
