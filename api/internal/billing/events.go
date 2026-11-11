// Package billing is the published language of the billing context: the events it publishes, the
// client other contexts call, and the guest revenue categories that follow a transaction code.
// Other contexts may import this package and nothing below it.
package billing

import "encoding/json"

// Facts finance consumes. ARCHITECTURE.md, "Billing to finance events", documents each payload.
const (
	EventFolioLinePosted         = "billing.folio_line.posted.v1"
	EventFolioLineVoided         = "billing.folio_line.voided.v1"
	EventPaymentRecorded         = "billing.payment.recorded.v1"
	EventPaymentRefunded         = "billing.payment.refunded.v1"
	EventNightAudited            = "billing.night.audited.v1"
	EventStayCheckedOut          = "billing.stay.checked_out.v1"
	EventCityLedgerTransferred   = "billing.city_ledger.transferred.v1"
	EventCityLedgerInvoiceIssued = "billing.city_ledger.invoice_issued.v1"
	EventCityLedgerPaymentRecvd  = "billing.city_ledger.payment_received.v1"
	EventCityLedgerWrittenOff    = "billing.city_ledger.written_off.v1"
	EventTaxSettingsChanged      = "billing.tax_settings.changed.v1"
)

// Facts for reservation and finance beyond the money.
const (
	// EventStayBillingSet carries who pays a booking or a group; reservation keeps it on the record.
	EventStayBillingSet = "billing.stay_billing.set.v1"
	// EventShiftClosed carries a counted drawer; finance books the count and its difference.
	EventShiftClosed = "billing.cashier_shift.closed.v1"
	// EventShiftDropped carries cash leaving a counted drawer; finance books the transfer.
	EventShiftDropped = "billing.cashier_shift.dropped.v1"
	// EventTransactionCodeSaved carries a code and the account it books to from now on.
	EventTransactionCodeSaved = "billing.transaction_code.saved.v1"
)

// CategoryCode is CATEGORY_CODE: a guest revenue category books to its transaction code's account,
// so finance refuses to map it (CATEGORY_FOLLOWS_CODE).
var CategoryCode = map[string]string{
	"cat-room": "ROOM", "cat-airbnb": "ROOM", "cat-extra": "DMG", "cat-svc-fnb": "FNB", "cat-svc-laundry": "LDRY",
	"cat-svc-transport": "TRNS", "cat-svc-spa": "SPA", "cat-svc-tours": "TOUR", "cat-svc-other": "XTRA",
}

// Where is the stay and day every fact names.
type Where struct {
	BookingID  string `json:"bookingId"`
	VillaID    string `json:"villaId"`
	LocationID string `json:"locationId"`
	Date       string `json:"date"`
}

// TaxLine is the service or PB1 on a line and the payable it books to.
type TaxLine struct {
	Code    string `json:"code"`
	Account string `json:"account"`
	Amount  int64  `json:"amount"`
}

// StayPaid is what a stay has paid after a fact; reservation keeps it on the booking.
type StayPaid struct {
	PaidAmount    int64  `json:"paidAmount"`
	PaymentStatus string `json:"paymentStatus"`
}

// LedgerRef names the city ledger account a transfer bills.
type LedgerRef struct {
	AccountID   string `json:"accountId"`
	Instruction string `json:"instruction"`
}

// FolioLinePosted is the payload of folio_line.posted.
type FolioLinePosted struct {
	Where
	PostingID   string     `json:"postingId"`
	BookingCode string     `json:"bookingCode"`
	Kind        string     `json:"kind"`
	Code        string     `json:"code"`
	Account     string     `json:"account"`
	Description string     `json:"description"`
	Amount      int64      `json:"amount"`
	Service     int64      `json:"service"`
	PB1         int64      `json:"pb1"`
	Gross       int64      `json:"gross"`
	TaxLines    []TaxLine  `json:"taxLines"`
	Part        string     `json:"part"`
	LineID      *string    `json:"lineId"`
	OrderID     *string    `json:"orderId"`
	ApprovedBy  *string    `json:"approvedBy"`
	PostedBy    string     `json:"postedBy"`
	PostedAt    string     `json:"postedAt"`
	CityLedger  *LedgerRef `json:"cityLedger,omitempty"`
}

// VoidedLine is one folio line of a voided delivery.
type VoidedLine struct {
	LineID   string    `json:"lineId"`
	Code     string    `json:"code"`
	Account  string    `json:"account"`
	Amount   int64     `json:"amount"`
	TaxLines []TaxLine `json:"taxLines"`
}

// FolioLineVoided is the payload of folio_line.voided.
type FolioLineVoided struct {
	Where
	OrderID     string       `json:"orderId"`
	OrderNumber string       `json:"orderNumber"`
	BookingCode string       `json:"bookingCode"`
	Reason      string       `json:"reason"`
	Lines       []VoidedLine `json:"lines"`
}

// Revenue is one income category of an order payment.
type Revenue struct {
	CategoryID string `json:"categoryId"`
	Amount     int64  `json:"amount"`
}

// PaymentRecorded is the payload of payment.recorded, and the base of payment.refunded.
type PaymentRecorded struct {
	Where
	PaymentID     string    `json:"paymentId"`
	Number        string    `json:"number"`
	BookingCode   string    `json:"bookingCode"`
	UnitID        string    `json:"unitId"`
	Kind          string    `json:"kind"`
	Method        string    `json:"method"`
	Code          string    `json:"code"`
	AccountKind   string    `json:"accountKind"`
	CashAccountID string    `json:"cashAccountId"`
	Amount        int64     `json:"amount"`
	Fee           int64     `json:"fee"`
	CategoryID    string    `json:"categoryId"`
	Revenue       []Revenue `json:"revenue"`
	OrderIDs      []string  `json:"orderIds"`
	OrderAmounts  []int64   `json:"orderAmounts"`
	GroupID       string    `json:"groupId"`
	Batch         string    `json:"batch"`
	ShiftID       string    `json:"shiftId"`
	Origin        string    `json:"origin"`
	Reference     string    `json:"reference"`
	Payer         string    `json:"payer"`
	AttachmentIDs []string  `json:"attachmentIds"`
	RecordedBy    string    `json:"recordedBy"`
	Stay          StayPaid  `json:"stay"`
}

// PaymentRefunded is the payload of payment.refunded.
type PaymentRefunded struct {
	PaymentRecorded
	RefundOf       string `json:"refundOf"`
	OriginalNumber string `json:"originalNumber"`
	Reason         string `json:"reason"`
}

// AuditLine is one night the audit posts on a stay.
type AuditLine struct {
	Night    int       `json:"night"`
	Code     string    `json:"code"`
	Account  string    `json:"account"`
	Amount   int64     `json:"amount"`
	TaxLines []TaxLine `json:"taxLines"`
}

// AuditedStay is one stay the audit posted.
type AuditedStay struct {
	BookingID    string      `json:"bookingId"`
	Code         string      `json:"code"`
	VillaID      string      `json:"villaId"`
	LocationID   string      `json:"locationId"`
	Nights       int         `json:"nights"`
	NightsPosted []string    `json:"nightsPosted"`
	Lines        []AuditLine `json:"lines"`
}

// NightAudited is the payload of night.audited.
type NightAudited struct {
	Where
	AuditID          string        `json:"auditId"`
	RanBy            string        `json:"ranBy"`
	RanAt            string        `json:"ranAt"`
	NextBusinessDate string        `json:"nextBusinessDate"`
	NoShows          []string      `json:"noShows"`
	Nights           int           `json:"nights"`
	RoomRevenue      int64         `json:"roomRevenue"`
	Stays            []AuditedStay `json:"stays"`
}

// Taxes is the bill's subtotal, service and PB1.
type Taxes struct {
	Subtotal int64 `json:"subtotal"`
	Service  int64 `json:"service"`
	PB1      int64 `json:"pb1"`
	Total    int64 `json:"total"`
}

// StayCheckedOut is the payload of stay.checked_out.
type StayCheckedOut struct {
	Where
	BookingCode      string      `json:"bookingCode"`
	UnitID           string      `json:"unitId"`
	Method           string      `json:"method"`
	CashAccountID    string      `json:"cashAccountId"`
	DepositReturned  int64       `json:"depositReturned"`
	ExtraCharges     int64       `json:"extraCharges"`
	FolioCharges     int64       `json:"folioCharges"`
	ChargePostingIDs []string    `json:"chargePostingIds"`
	RoomLines        []AuditLine `json:"roomLines"`
	Balance          int64       `json:"balance"`
	RefundDue        int64       `json:"refundDue"`
	Taxes            Taxes       `json:"taxes"`
}

// TransferredPart is one slice of a transfer.
type TransferredPart struct {
	PostingID string  `json:"postingId"`
	Part      string  `json:"part"`
	OrderID   *string `json:"orderId"`
	Amount    int64   `json:"amount"`
	Service   int64   `json:"service"`
	PB1       int64   `json:"pb1"`
}

// CityLedgerTransferred is the payload of city_ledger.transferred.
type CityLedgerTransferred struct {
	Where
	AccountID   string            `json:"accountId"`
	AccountCode string            `json:"accountCode"`
	BookingCode string            `json:"bookingCode"`
	Instruction string            `json:"instruction"`
	Code        string            `json:"code"`
	Parts       []TransferredPart `json:"parts"`
	Total       int64             `json:"total"`
	Stay        StayPaid          `json:"stay"`
}

// CityLedgerInvoiceIssued is the payload of city_ledger.invoice_issued. Invoice is the
// CityLedgerInvoice in the console's shape.
type CityLedgerInvoiceIssued struct {
	Where
	InvoiceID         string          `json:"invoiceId"`
	Number            string          `json:"number"`
	AccountID         string          `json:"accountId"`
	Invoice           json.RawMessage `json:"invoice"`
	Gross             int64           `json:"gross"`
	Service           int64           `json:"service"`
	PB1               int64           `json:"pb1"`
	CommissionPct     float64         `json:"commissionPct"`
	Commission        int64           `json:"commission"`
	Net               int64           `json:"net"`
	CommissionAccount string          `json:"commissionAccount"`
	ReceivableAccount string          `json:"receivableAccount"`
}

// Allocation is one invoice a city ledger payment pays.
type Allocation struct {
	InvoiceID string `json:"invoiceId"`
	Amount    int64  `json:"amount"`
}

// CityLedgerPaymentReceived is the payload of city_ledger.payment_received.
type CityLedgerPaymentReceived struct {
	Where
	PaymentID     string       `json:"paymentId"`
	Number        string       `json:"number"`
	AccountID     string       `json:"accountId"`
	Method        string       `json:"method"`
	CashAccountID string       `json:"cashAccountId"`
	Amount        int64        `json:"amount"`
	Reference     string       `json:"reference"`
	Note          string       `json:"note"`
	Allocations   []Allocation `json:"allocations"`
	Unapplied     int64        `json:"unapplied"`
	CategoryID    string       `json:"categoryId"`
	Origin        string       `json:"origin"`
	RecordedBy    string       `json:"recordedBy"`
}

// CityLedgerWrittenOff is the payload of city_ledger.written_off.
type CityLedgerWrittenOff struct {
	Where
	WriteOffID    string `json:"writeOffId"`
	Number        string `json:"number"`
	AccountID     string `json:"accountId"`
	InvoiceID     string `json:"invoiceId"`
	InvoiceNumber string `json:"invoiceNumber"`
	Amount        int64  `json:"amount"`
	Reason        string `json:"reason"`
	DebitAccount  string `json:"debitAccount"`
	CreditAccount string `json:"creditAccount"`
	CreatedBy     string `json:"createdBy"`
}

// TaxSettingsChanged is the payload of tax_settings.changed; Settings and ChangedRates are the
// console's TaxSettings and TaxRates.
type TaxSettingsChanged struct {
	Where
	Settings     json.RawMessage `json:"settings"`
	ChangedRates json.RawMessage `json:"changedRates"`
	SavedBy      string          `json:"savedBy"`
}

// StayBillingSet is the payload of stay_billing.set: Billing is the CityLedgerBilling, null when the
// guest pays again. Exactly one of BookingID and GroupID is set.
type StayBillingSet struct {
	BookingID string          `json:"bookingId"`
	GroupID   string          `json:"groupId"`
	Billing   json.RawMessage `json:"billing"`
}

// ShiftClosed is the payload of cashier_shift.closed: Shift is the CashierShift once closed or
// signed off, the difference ready to book.
type ShiftClosed struct {
	Where
	ShiftID    string          `json:"shiftId"`
	AccountID  string          `json:"accountId"`
	Expected   int64           `json:"expected"`
	Counted    int64           `json:"counted"`
	Difference int64           `json:"difference"`
	Note       string          `json:"note"`
	Shift      json.RawMessage `json:"shift"`
}

// ShiftDropped is the payload of cashier_shift.dropped.
type ShiftDropped struct {
	Where
	ShiftID       string `json:"shiftId"`
	FromAccountID string `json:"fromAccountId"`
	ToAccountID   string `json:"toAccountId"`
	Amount        int64  `json:"amount"`
	Description   string `json:"description"`
	Reference     string `json:"reference"`
}

// TransactionCodeSaved is the payload of transaction_code.saved; Code is the TransactionCode.
type TransactionCodeSaved struct {
	Code json.RawMessage `json:"code"`
}
