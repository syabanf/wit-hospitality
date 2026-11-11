package domain

import (
	"regexp"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Code kinds and departments, as transactionCode.ts lists them.
var (
	CodeKinds   = []string{"charge", "payment", "rebate"}
	Departments = []string{"room", "fnb", "minibar", "laundry", "transport", "spa", "tours", "extras", "other", "taxes", "payment"}
)

// TransactionCode is TransactionCode.
type TransactionCode struct {
	ID         string  `json:"id"`
	Code       string  `json:"code"`
	Name       string  `json:"name"`
	Kind       string  `json:"kind"`
	Department string  `json:"department"`
	AccountID  *string `json:"accountId"`
	Active     bool    `json:"active"`
}

// TransactionCodeInput is TransactionCodeInput.
type TransactionCodeInput struct {
	Code       string  `json:"code"`
	Name       string  `json:"name"`
	Kind       string  `json:"kind"`
	Department string  `json:"department"`
	AccountID  *string `json:"accountId"`
	Active     bool    `json:"active"`
}

// Codes the folio relies on.
const (
	RoomCode       = "ROOM"
	CityLedgerCode = "CL"
	OtherCode      = "DMG"
)

// Revenue accounts of BASE_CHART and the tax and ledger accounts the events name.
const (
	AccountOtherIncome     = "gl-4900"
	AccountServicePayable  = "gl-2400"
	AccountPB1Payable      = "gl-2330"
	AccountCityLedger      = "gl-1210"
	AccountAgentCommission = "gl-6750"
	AccountBadDebt         = "gl-6950"
)

// RevenueAccounts are the revenue accounts of BASE_CHART a charge or rebate code may book to.
var RevenueAccounts = []string{"gl-4100", "gl-4210", "gl-4220", "gl-4230", "gl-4240", "gl-4250", "gl-4260", "gl-4270", "gl-4800", "gl-4900"}

var revenue = map[string]string{"room": "gl-4100", "fnb": "gl-4210", "minibar": "gl-4220", "laundry": "gl-4230", "transport": "gl-4240",
	"spa": "gl-4250", "tours": "gl-4260", "extras": "gl-4270", "other": "gl-4900"}

// DefaultTransactionCodes is DEFAULT_TRANSACTION_CODES.
func DefaultTransactionCodes() []TransactionCode {
	charge := func(code, name, dept string) TransactionCode {
		acc := revenue[dept]
		return TransactionCode{ID: "tc-" + strings.ToLower(code), Code: code, Name: name, Kind: "charge", Department: dept, AccountID: &acc, Active: true}
	}
	payment := func(code, name string) TransactionCode {
		return TransactionCode{ID: "tc-" + strings.ToLower(code), Code: code, Name: name, Kind: "payment", Department: "payment", Active: true}
	}
	return []TransactionCode{
		charge("ROOM", "Room night", "room"), charge("LATE", "Late check-out", "room"), charge("FNB", "Food and drinks", "fnb"),
		charge("MINI", "Minibar", "minibar"), charge("LDRY", "Laundry", "laundry"), charge("TRNS", "Transfers and transport", "transport"),
		charge("SPA", "Spa and massage", "spa"), charge("TOUR", "Tours and activities", "tours"),
		charge("XTRA", "Extra bed, decoration and amenities", "extras"), charge("DMG", "Damage and other charges", "other"),
		payment("CASH", "Cash"), payment("BANK", "Bank transfer"), payment("QRIS", "QRIS"), payment("VA", "Virtual account"),
		payment("CARD", "Card"), payment("AIRBNB", "Airbnb"), payment("CL", "City ledger transfer"),
	}
}

// PaymentMethodCode is PAYMENT_METHOD_CODE.
var PaymentMethodCode = map[string]string{"cash": "CASH", "bank_transfer": "BANK", "qris": "QRIS", "virtual_account": "VA", "card": "CARD", "airbnb_payout": "AIRBNB"}

// MethodCode is the code a payment by `method` shows under; cash when unset.
func MethodCode(method string) string {
	if c, ok := PaymentMethodCode[method]; ok {
		return c
	}
	return "CASH"
}

// CodeAccount is codeAccount: the revenue account of a code; unknown or unmapped, other income.
// Service and PB1 book to their payables.
func CodeAccount(codes []TransactionCode, code string) string {
	switch code {
	case ServiceCode:
		return AccountServicePayable
	case PB1Code:
		return AccountPB1Payable
	}
	for _, c := range codes {
		if c.Code == code && c.AccountID != nil {
			return *c.AccountID
		}
	}
	return AccountOtherIncome
}

// ChargeCodes is chargeCodes: active charge codes other than the room night.
func ChargeCodes(codes []TransactionCode) []TransactionCode {
	var out []TransactionCode
	for _, c := range codes {
		if c.Kind == "charge" && c.Active && c.Code != RoomCode {
			out = append(out, c)
		}
	}
	return out
}

var codePattern = regexp.MustCompile(`^[A-Z][A-Z0-9]{1,7}$`)

// ValidateTransactionCode is validateTransactionCode; accounts are the revenue accounts.
func ValidateTransactionCode(in TransactionCodeInput, codes []TransactionCode, accounts []string, id string) error {
	var f errs.Fields
	code := strings.ToUpper(strings.TrimSpace(in.Code))
	if !codePattern.MatchString(code) {
		f.Add("code", "Two to eight letters or digits, starting with a letter.")
	} else {
		for _, c := range codes {
			if c.Code == code && c.ID != id {
				f.Add("code", code+" is taken.")
				break
			}
		}
	}
	if len(strings.TrimSpace(in.Name)) < 3 {
		f.Add("name", "Name the code.")
	}
	if !slices.Contains(CodeKinds, in.Kind) {
		f.Add("kind", "Pick the kind.")
	}
	if !slices.Contains(Departments, in.Department) {
		f.Add("department", "Pick the department.")
	}
	hasAccount := in.AccountID != nil && *in.AccountID != ""
	if in.Kind == "payment" && hasAccount {
		f.Add("accountId", "A payment code books by its cash entry; leave the account empty.")
	}
	if in.Kind != "payment" && (!hasAccount || !slices.Contains(accounts, *in.AccountID)) {
		f.Add("accountId", "Pick the revenue account it books to.")
	}
	return f.Err()
}

// CleanCode is saveCode's normalisation: upper-case code, trimmed name, no account on a payment code.
func CleanCode(in TransactionCodeInput) TransactionCodeInput {
	in.Code = strings.ToUpper(strings.TrimSpace(in.Code))
	in.Name = strings.TrimSpace(in.Name)
	if in.Kind == "payment" {
		in.AccountID = nil
	}
	return in
}

// AssertCanDeactivate is assertCanDeactivate: ROOM and the payment codes stay active.
func AssertCanDeactivate(c TransactionCode) error {
	if c.Code == RoomCode || c.Kind == "payment" {
		what := "room night"
		if c.Kind == "payment" {
			what = "payment by that method"
		}
		return errs.Newf("CODE_IN_USE", "%s is used by every %s; it stays active.", c.Code, what)
	}
	return nil
}
