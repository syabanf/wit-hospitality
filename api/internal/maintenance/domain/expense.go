package domain

import (
	"fmt"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// ExpenseKinds is EXPENSE_KINDS.
var ExpenseKinds = []string{"parts", "vendor", "labour"}

// ExpenseKindLabel is EXPENSE_KIND_LABEL.
var ExpenseKindLabel = map[string]string{"parts": "Parts purchase", "vendor": "Vendor invoice", "labour": "Labour paid outside payroll"}

// Expense is WorkOrderExpense: money paid out for a job, each line its own cash-out entry.
type Expense struct {
	ID            string       `json:"id"`
	Line          int          `json:"line"`
	Kind          string       `json:"kind"`
	Description   string       `json:"description"`
	Payee         string       `json:"payee"`
	VendorID      *string      `json:"vendorId"`
	Amount        int64        `json:"amount"`
	Method        string       `json:"method"`
	Reference     string       `json:"reference"`
	Receipts      []Attachment `json:"receipts"`
	PaidOn        string       `json:"paidOn"`
	TransactionID string       `json:"transactionId"`
	CreatedBy     string       `json:"createdBy"`
	CreatedOn     string       `json:"createdOn"`
}

// ExpenseInput is ExpenseInput.
type ExpenseInput struct {
	Kind        string       `json:"kind"`
	Description string       `json:"description"`
	Payee       string       `json:"payee"`
	VendorID    *string      `json:"vendorId"`
	Amount      float64      `json:"amount"`
	Method      string       `json:"method"`
	Reference   string       `json:"reference"`
	Receipts    []Attachment `json:"receipts"`
	PaidOn      string       `json:"paidOn"`
}

// ValidateExpense is validateExpense.
func ValidateExpense(in ExpenseInput) error {
	var f errs.Fields
	if !slices.Contains(ExpenseKinds, in.Kind) {
		f.Add("kind", "Pick what was paid for.")
	}
	if len([]rune(strings.TrimSpace(in.Description))) < 3 {
		f.Add("description", "Say what was bought or billed.")
	}
	if len([]rune(strings.TrimSpace(in.Payee))) < 2 {
		f.Add("payee", "Name the shop, vendor or person paid.")
	}
	if !whole(in.Amount) || in.Amount <= 0 {
		f.Add("amount", "Enter a whole rupiah amount above zero.")
	}
	if in.Method != "cash" && in.Method != "bank_transfer" {
		f.Add("method", "Pick how it was paid.")
	}
	if in.Kind == "vendor" && len([]rune(strings.TrimSpace(in.Reference))) < 3 {
		f.Add("reference", "Enter the vendor invoice number.")
	}
	if !ValidDate(in.PaidOn) {
		f.Add("paidOn", "Pick the date it was paid.")
	}
	return f.Err()
}

// ExpenseReference is expenseReference: the ledger reference of a line.
func ExpenseReference(number string, line int) string { return fmt.Sprintf("%s / %d", number, line) }

// ExpenseDescription is the cash-out description expenseFields builds.
func ExpenseDescription(number string, in ExpenseInput) string {
	return fmt.Sprintf("%s %s: %s, %s", number, strings.ToLower(ExpenseKindLabel[in.Kind]), strings.TrimSpace(in.Description), strings.TrimSpace(in.Payee))
}

// NextLine is the next expense line number on the job.
func (w WorkOrder) NextLine() int {
	n := 0
	for _, e := range w.Expenses {
		n = max(n, e.Line)
	}
	return n + 1
}

// CheckCanAddExpense refuses an expense before the work starts.
func (w WorkOrder) CheckCanAddExpense() error {
	if !CanAddExpense(w.Status) {
		return errs.Newf("WORK_ORDER_INVALID_STATE", "%s is %s; expenses start once the work starts.", w.Number, strings.ToLower(StatusLabel[w.Status]))
	}
	return nil
}

// Expense finds a line by id.
func (w WorkOrder) Expense(id string) (Expense, error) {
	for _, e := range w.Expenses {
		if e.ID == id {
			return e, nil
		}
	}
	return Expense{}, errs.NotFound("expense", id)
}

func receipts(r []Attachment) []Attachment {
	if r == nil {
		return []Attachment{}
	}
	return r
}

// NewExpense builds the expense line a submitted cash-out pays.
func NewExpense(w WorkOrder, line int, in ExpenseInput, transactionID, by, today string) Expense {
	return Expense{
		ID: fmt.Sprintf("exp-%s-%d", w.ID, line), Line: line, Kind: in.Kind, Description: strings.TrimSpace(in.Description),
		Payee: strings.TrimSpace(in.Payee), VendorID: emptyToNil(in.VendorID), Amount: int64(in.Amount), Method: in.Method,
		Reference: strings.TrimSpace(in.Reference), Receipts: receipts(in.Receipts), PaidOn: in.PaidOn,
		TransactionID: transactionID, CreatedBy: by, CreatedOn: today,
	}
}

// CorrectExpense replaces a line's fields after its cash-out was rejected.
func (w *WorkOrder) CorrectExpense(id string, in ExpenseInput) {
	for i, e := range w.Expenses {
		if e.ID == id {
			e.Kind, e.Description, e.Payee, e.VendorID = in.Kind, strings.TrimSpace(in.Description), strings.TrimSpace(in.Payee), emptyToNil(in.VendorID)
			e.Amount, e.Method, e.Reference, e.Receipts, e.PaidOn = int64(in.Amount), in.Method, strings.TrimSpace(in.Reference), receipts(in.Receipts), in.PaidOn
			w.Expenses[i] = e
		}
	}
}
