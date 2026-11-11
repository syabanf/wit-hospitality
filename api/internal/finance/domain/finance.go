// Package domain holds the finance context's rules, ported from src/domain/finance.ts,
// approval.ts, attachment.ts, journal.ts, transactionCode.ts, tax.ts, cashier.ts and revenue.ts
// (budgets). Records keep the console's JSON shape, so a read returns what the mock returns.
// Errors carry the TypeScript RuleError codes and wording.
package domain

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Transaction kinds and statuses.
const (
	CashIn  = "cash_in"
	CashOut = "cash_out"

	Draft     = "draft"
	Submitted = "submitted"
	Approved  = "approved"
	Posted    = "posted"
	Rejected  = "rejected"
	Reversed  = "reversed"
)

// KindLabel is KIND_LABEL.
var KindLabel = map[string]string{CashIn: "Cash in", CashOut: "Cash out"}

// Origins is TransactionOrigin.
var Origins = []string{"manual", "front_desk", "transfer", "adjustment", "reconciliation", "payroll", "reversal", "payment", "maintenance", "room_service", "stock", "owner_payout"}

// Account kinds.
const (
	Cashbox = "cashbox"
	Bank    = "bank"
	Petty   = "petty"
)

var accountKinds = []string{Cashbox, Bank, Petty}

// CashAccount is a cashbox, the bank account or a villa's petty cash.
type CashAccount struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	Kind           string  `json:"kind"`
	LocationID     *string `json:"locationId"`
	VillaID        *string `json:"villaId"`
	FloatLimit     *int64  `json:"floatLimit"`
	CustodianID    *string `json:"custodianId"`
	OpeningBalance int64   `json:"openingBalance"`
	OpenedOn       string  `json:"openedOn"`
}

// Location is the account's location id, or "".
func (a CashAccount) Location() string { return deref(a.LocationID) }

// Villa is the petty cash villa id, or "".
func (a CashAccount) Villa() string { return deref(a.VillaID) }

// CashAccountInput is the account form. Numbers arrive as JSON numbers and are checked whole.
type CashAccountInput struct {
	Name           string   `json:"name"`
	Kind           string   `json:"kind"`
	LocationID     *string  `json:"locationId"`
	VillaID        *string  `json:"villaId"`
	FloatLimit     *float64 `json:"floatLimit"`
	CustodianID    *string  `json:"custodianId"`
	OpeningBalance float64  `json:"openingBalance"`
	OpenedOn       string   `json:"openedOn"`
}

var dateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// IsDate reports a YYYY-MM-DD string.
func IsDate(s string) bool { return dateRe.MatchString(s) }

func whole(f float64) bool { return !math.IsInf(f, 0) && !math.IsNaN(f) && f == math.Trunc(f) }

func runes(s string) int { return utf8.RuneCountInString(s) }

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// Ptr returns a pointer to v.
func Ptr[T any](v T) *T { return &v }

// ValidateAccount is validateAccount.
func ValidateAccount(in CashAccountInput, accounts []CashAccount, excludeID string) error {
	var f errs.Fields
	name := strings.TrimSpace(in.Name)
	if runes(name) < 2 {
		f.Add("name", "Enter the account name.")
	} else if slices.ContainsFunc(accounts, func(a CashAccount) bool { return strings.EqualFold(a.Name, name) && a.ID != excludeID }) {
		f.Add("name", name+" already exists.")
	}
	if in.Kind == Cashbox && deref(in.LocationID) == "" {
		f.Add("locationId", "A cashbox sits at one location.")
	}
	if in.Kind == Petty {
		if deref(in.VillaID) == "" {
			f.Add("villaId", "Petty cash belongs to one villa.")
		} else if slices.ContainsFunc(accounts, func(a CashAccount) bool { return a.Kind == Petty && a.Villa() == *in.VillaID && a.ID != excludeID }) {
			f.Add("villaId", "That villa already has petty cash.")
		}
		if in.FloatLimit == nil || !whole(*in.FloatLimit) || *in.FloatLimit <= 0 {
			f.Add("floatLimit", "Enter the float in whole rupiah.")
		}
		if deref(in.CustodianID) == "" {
			f.Add("custodianId", "Pick who holds the cash.")
		}
	}
	if !whole(in.OpeningBalance) || in.OpeningBalance < 0 {
		f.Add("openingBalance", "Enter the opening balance in whole rupiah, zero or more.")
	}
	if !IsDate(in.OpenedOn) {
		f.Add("openedOn", "Pick the opening date.")
	}
	if !slices.Contains(accountKinds, in.Kind) && !f.Has("kind") {
		f.Add("kind", "Pick the account kind.")
	}
	return f.Err()
}

// Account turns a checked input into the stored record.
func (in CashAccountInput) Account(id string) CashAccount {
	a := CashAccount{ID: id, Name: strings.TrimSpace(in.Name), Kind: in.Kind, LocationID: in.LocationID, VillaID: in.VillaID, CustodianID: in.CustodianID,
		OpeningBalance: int64(in.OpeningBalance), OpenedOn: in.OpenedOn}
	if in.FloatLimit != nil {
		a.FloatLimit = Ptr(int64(*in.FloatLimit))
	}
	return a
}

// systemCategories is SYSTEM_CATEGORY_IDS.
var systemCategories = []string{"cat-transfer-in", "cat-transfer-out", "cat-adjust-in", "cat-adjust-out", "cat-payroll", "cat-deposit", "cat-extra", "cat-fees", "cat-svc-fnb", "cat-svc-laundry", "cat-svc-transport", "cat-svc-spa", "cat-svc-tours", "cat-svc-other", "cat-svc-partner", "cat-bpjs", "cat-pph21", "cat-owner-payout", "cat-owner-topup", "cat-city-ledger"}

// IsSystemCategory is isSystemCategory.
func IsSystemCategory(id string) bool { return slices.Contains(systemCategories, id) }

// Category is an income or expense line.
type Category struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Kind     string   `json:"kind"`
	Slot     int      `json:"slot"`
	Active   bool     `json:"active"`
	VillaIDs []string `json:"villaIds"`
}

// CategoryInput is the category form; Active is set only by the activate call.
type CategoryInput struct {
	Name     *string  `json:"name"`
	Kind     *string  `json:"kind"`
	VillaIDs []string `json:"villaIds"`
	Active   *bool    `json:"active"`
}

// Attachment is a receipt or invoice kept as proof.
type Attachment struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Type       string `json:"type"`
	Size       int64  `json:"size"`
	URL        string `json:"url"`
	UploadedBy string `json:"uploadedBy"`
	UploadedAt string `json:"uploadedAt"`
}

// Attachment limits.
const (
	MaxAttachmentBytes = 5 * 1024 * 1024
	MaxAttachments     = 10
)

var attachmentTypes = []string{"image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"}

// uploadProblem is uploadProblem.
func uploadProblem(a Attachment) *errs.Error {
	if !slices.Contains(attachmentTypes, a.Type) {
		return errs.New("ATTACHMENT_TYPE", a.Name+" is not a photo or a PDF.")
	}
	if a.Size <= 0 {
		return errs.New("ATTACHMENT_EMPTY", a.Name+" is empty.")
	}
	if a.Size > MaxAttachmentBytes {
		return errs.New("ATTACHMENT_SIZE", a.Name+" is over 5 MB.")
	}
	return nil
}

// AssertFiles is the mock's assertFiles: at most ten files, and uploaded ones of the right type and size.
func AssertFiles(files []Attachment) error {
	if len(files) > MaxAttachments {
		return errs.New("ATTACHMENT_COUNT", fmt.Sprintf("Attach at most %d files.", MaxAttachments))
	}
	for _, f := range files {
		if f.Size > 0 || f.URL != "" {
			if p := uploadProblem(f); p != nil {
				return p
			}
		}
	}
	return nil
}

// ProofPolicy is the receipt rule for cash-outs.
type ProofPolicy struct {
	Threshold int64 `json:"threshold"`
}

// DefaultProofPolicy is DEFAULT_PROOF_POLICY.
var DefaultProofPolicy = ProofPolicy{Threshold: 1_000_000}

var handWritten = []string{"manual", "maintenance", "stock"}

// NeedsProof is needsProof.
func NeedsProof(kind string, amount int64, origin string, attachments int, p ProofPolicy, pettyCash bool) bool {
	return p.Threshold > 0 && kind == CashOut && slices.Contains(handWritten, origin) && (pettyCash || amount >= p.Threshold) && attachments == 0
}

// ProofRequired is the mock's assertProof refusal.
func ProofRequired(p ProofPolicy, petty bool) *errs.Error {
	if petty {
		return errs.New("PROOF_REQUIRED", "Attach the receipt: every petty cash spend needs one.")
	}
	return errs.New("PROOF_REQUIRED", fmt.Sprintf("Attach a receipt or invoice: cash-outs from Rp %s need proof before approval.", Thousands(p.Threshold)))
}

// ValidateProofPolicy is validateProofPolicy.
func ValidateProofPolicy(threshold float64) error {
	if whole(threshold) && threshold >= 0 {
		return nil
	}
	return errs.Invalid("threshold", "Enter a whole rupiah amount, or 0 to switch the rule off.")
}

// Thousands writes n with dots between thousands, as toLocaleString('id-ID') does.
func Thousands(n int64) string {
	neg := n < 0
	if neg {
		n = -n
	}
	s := strconv.FormatInt(n, 10)
	var b strings.Builder
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte('.')
		}
		b.WriteRune(c)
	}
	if neg {
		return "-" + b.String()
	}
	return b.String()
}

// Money is lib/format money: "Rp 1.500.000" with a no-break space.
func Money(n int64) string {
	if n < 0 {
		return "-Rp " + Thousands(-n)
	}
	return "Rp " + Thousands(n)
}

// ApprovalGrant is one signature on the chain.
type ApprovalGrant struct {
	Level int    `json:"level"`
	Role  string `json:"role"`
	By    string `json:"by"`
	On    string `json:"on"`
	Note  string `json:"note"`
}

// TransactionEvent is one line of the approval history.
type TransactionEvent struct {
	Kind string `json:"kind"`
	By   string `json:"by"`
	Role string `json:"role"`
	On   string `json:"on"`
	Note string `json:"note"`
}

// Transaction is one cash entry. ShiftID keeps the three states the console writes: absent, null
// (kept off every shift) or a shift id.
type Transaction struct {
	ID              string             `json:"id"`
	Number          string             `json:"number"`
	AccountID       string             `json:"accountId"`
	Kind            string             `json:"kind"`
	CategoryID      string             `json:"categoryId"`
	Amount          int64              `json:"amount"`
	Date            string             `json:"date"`
	LocationID      string             `json:"locationId"`
	VillaID         *string            `json:"villaId"`
	UnitID          *string            `json:"unitId"`
	BookingID       *string            `json:"bookingId"`
	Description     string             `json:"description"`
	Reference       string             `json:"reference"`
	Attachments     []Attachment       `json:"attachments"`
	Origin          string             `json:"origin"`
	Status          string             `json:"status"`
	Approvals       []ApprovalGrant    `json:"approvals"`
	History         []TransactionEvent `json:"history"`
	RejectionReason *string            `json:"rejectionReason"`
	TransferID      *string            `json:"transferId"`
	ReversalOf      *string            `json:"reversalOf"`
	ReversedBy      *string            `json:"reversedBy"`
	ShiftID         json.RawMessage    `json:"shiftId,omitempty"`
	CreatedBy       string             `json:"createdBy"`
	CreatedByID     string             `json:"createdById"`
	CreatedOn       string             `json:"createdOn"`
	Version         int64              `json:"-"`
}

// Shift is the shift the entry carries, or "".
func (t Transaction) Shift() string {
	var s *string
	_ = json.Unmarshal(t.ShiftID, &s)
	return deref(s)
}

// SetShift stamps a shift id; "" with keepOff writes null.
func (t *Transaction) SetShift(id string) {
	if id == "" {
		t.ShiftID = json.RawMessage("null")
		return
	}
	t.ShiftID, _ = json.Marshal(id)
}

// Villa is the villa id, or "".
func (t Transaction) Villa() string { return deref(t.VillaID) }

// Booking is the booking id, or "".
func (t Transaction) Booking() string { return deref(t.BookingID) }

var transitions = map[string][]string{
	Draft: {Submitted}, Submitted: {Approved, Rejected}, Rejected: {Submitted}, Approved: {Posted}, Posted: {}, Reversed: {},
}

// CanTransition is canTransitionTransaction.
func CanTransition(status, to string) bool { return slices.Contains(transitions[status], to) }

// Counts is counts: only posted money moves a balance.
func Counts(status string) bool { return status == Posted || status == Reversed }

// AwaitsApproval is awaitsApproval.
func AwaitsApproval(status string) bool { return status == Submitted || status == Approved }

// Signed is the amount with its sign.
func Signed(t Transaction) int64 {
	if t.Kind == CashIn {
		return t.Amount
	}
	return -t.Amount
}

// Balance is balance(): the opening plus posted money up to and including upTo ("" for all).
func Balance(a CashAccount, txs []Transaction, upTo string) int64 {
	b := a.OpeningBalance
	for _, t := range txs {
		if t.AccountID == a.ID && Counts(t.Status) && (upTo == "" || t.Date <= upTo) {
			b += Signed(t)
		}
	}
	return b
}

// TransactionInput is the cash entry form.
type TransactionInput struct {
	AccountID   string       `json:"accountId"`
	Kind        string       `json:"kind"`
	CategoryID  string       `json:"categoryId"`
	Amount      float64      `json:"amount"`
	Date        string       `json:"date"`
	LocationID  string       `json:"locationId"`
	VillaID     *string      `json:"villaId"`
	UnitID      *string      `json:"unitId"`
	BookingID   *string      `json:"bookingId"`
	Description string       `json:"description"`
	Reference   string       `json:"reference"`
	Attachments []Attachment `json:"attachments"`
}

// ValidateTransaction is validateTransaction.
func ValidateTransaction(in TransactionInput, categories []Category) error {
	var f errs.Fields
	if in.AccountID == "" {
		f.Add("accountId", "Pick the account the money moves through.")
	}
	i := slices.IndexFunc(categories, func(c Category) bool { return c.ID == in.CategoryID })
	switch {
	case i < 0:
		f.Add("categoryId", "Pick a category.")
	case categories[i].Kind != in.Kind:
		f.Add("categoryId", fmt.Sprintf("%s is a %s category.", categories[i].Name, strings.ToLower(KindLabel[categories[i].Kind])))
	case !categories[i].Active:
		f.Add("categoryId", categories[i].Name+" is archived.")
	case len(categories[i].VillaIDs) > 0 && deref(in.VillaID) != "" && !slices.Contains(categories[i].VillaIDs, *in.VillaID):
		f.Add("categoryId", categories[i].Name+" is not enabled for this villa.")
	}
	if !whole(in.Amount) || in.Amount <= 0 {
		f.Add("amount", "Enter a whole rupiah amount above zero.")
	}
	if !IsDate(in.Date) {
		f.Add("date", "Pick the date.")
	}
	if in.LocationID == "" {
		f.Add("locationId", "Map the money to a location.")
	}
	if runes(strings.TrimSpace(in.Description)) < 3 {
		f.Add("description", "Say what the money was for.")
	}
	if runes(in.Reference) > 40 {
		f.Add("reference", "A reference is at most 40 characters.")
	}
	return f.Err()
}

// TransferInput is CashTransferInput.
type TransferInput struct {
	FromAccountID string  `json:"fromAccountId"`
	ToAccountID   string  `json:"toAccountId"`
	Amount        float64 `json:"amount"`
	Date          string  `json:"date"`
	Description   string  `json:"description"`
	Reference     string  `json:"reference"`
}

func hasAccount(accounts []CashAccount, id string) bool {
	return slices.ContainsFunc(accounts, func(a CashAccount) bool { return a.ID == id })
}

// ValidateTransfer is validateTransfer.
func ValidateTransfer(in TransferInput, accounts []CashAccount) error {
	var f errs.Fields
	if !hasAccount(accounts, in.FromAccountID) {
		f.Add("fromAccountId", "Pick the account the money leaves.")
	}
	if !hasAccount(accounts, in.ToAccountID) {
		f.Add("toAccountId", "Pick the account the money reaches.")
	} else if in.ToAccountID == in.FromAccountID {
		f.Add("toAccountId", "Pick two different accounts.")
	}
	if !whole(in.Amount) || in.Amount <= 0 {
		f.Add("amount", "Enter a whole rupiah amount above zero.")
	}
	if !IsDate(in.Date) {
		f.Add("date", "Pick the date.")
	}
	if runes(strings.TrimSpace(in.Description)) < 3 {
		f.Add("description", "Say why the money moves.")
	}
	return f.Err()
}

// AdjustmentInput is a correction to one balance.
type AdjustmentInput struct {
	AccountID string  `json:"accountId"`
	Direction string  `json:"direction"`
	Amount    float64 `json:"amount"`
	Date      string  `json:"date"`
	Reason    string  `json:"reason"`
}

// ValidateAdjustment is validateAdjustment.
func ValidateAdjustment(in AdjustmentInput, accounts []CashAccount) error {
	var f errs.Fields
	if !hasAccount(accounts, in.AccountID) {
		f.Add("accountId", "Pick the account.")
	}
	if !whole(in.Amount) || in.Amount <= 0 {
		f.Add("amount", "Enter a whole rupiah amount above zero.")
	}
	if !IsDate(in.Date) {
		f.Add("date", "Pick the date.")
	}
	if runes(strings.TrimSpace(in.Reason)) < 5 {
		f.Add("reason", "Give the reason for the correction.")
	}
	return f.Err()
}

// Reconciliation is a cash count against the book balance.
type Reconciliation struct {
	ID           string  `json:"id"`
	AccountID    string  `json:"accountId"`
	Date         string  `json:"date"`
	Expected     int64   `json:"expected"`
	Counted      int64   `json:"counted"`
	Difference   int64   `json:"difference"`
	Note         string  `json:"note"`
	By           string  `json:"by"`
	AdjustmentID *string `json:"adjustmentId"`
	ShiftID      *string `json:"shiftId,omitempty"`
}

// ReconciliationInput is the count form.
type ReconciliationInput struct {
	AccountID string  `json:"accountId"`
	Date      string  `json:"date"`
	Counted   float64 `json:"counted"`
	Note      string  `json:"note"`
	Adjust    bool    `json:"adjust"`
}

// ValidateReconciliation is validateReconciliation.
func ValidateReconciliation(in ReconciliationInput, accounts []CashAccount) error {
	var f errs.Fields
	if !hasAccount(accounts, in.AccountID) {
		f.Add("accountId", "Pick the account.")
	}
	if !whole(in.Counted) || in.Counted < 0 {
		f.Add("counted", "Enter the counted cash in whole rupiah.")
	}
	if !IsDate(in.Date) {
		f.Add("date", "Pick the count date.")
	}
	return f.Err()
}
