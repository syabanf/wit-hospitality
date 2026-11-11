package domain

import (
	"fmt"
	"time"
)

// BooksProblems checks the double-entry invariants accounting.test.ts holds the books to: every
// entry balances, the trial balance nets to zero and the balance sheet balances at every month
// end up to today, and every cash GL account equals its cash ledger balance. It lists what fails.
func BooksProblems(chart []GlAccount, accounts []CashAccount, txs []Transaction, entries []JournalEntry, today string) []string {
	var out []string
	first := today
	for _, e := range entries {
		if err := AssertBalanced(e.Lines); err != nil {
			out = append(out, fmt.Sprintf("%s %s: %v", e.Number, e.Memo, err))
		}
		if e.Date < first {
			first = e.Date
		}
	}
	start, _ := time.Parse("2006-01", MonthOf(first))
	end, _ := time.Parse("2006-01", MonthOf(today))
	for m := start; !m.After(end); m = m.AddDate(0, 1, 0) {
		last := m.AddDate(0, 1, -1).Format("2006-01-02")
		if _, d, c := TrialBalance(chart, entries, last); d != c {
			out = append(out, fmt.Sprintf("trial balance on %s: debits %d, credits %d", last, d, c))
		}
		if bs := BalanceSheet(chart, entries, last); !bs.Balanced() {
			out = append(out, fmt.Sprintf("balance sheet on %s: assets %d, liabilities %d, equity %d", last, bs.Assets, bs.Liabilities, bs.Equity))
		}
	}
	rows, _, _ := TrialBalance(chart, entries, "")
	for _, a := range accounts {
		var gl int64
		for _, r := range rows {
			if r.Account.ID == CashGlID(a.ID) {
				gl = r.Debit - r.Credit
			}
		}
		if cash := Balance(a, txs, ""); gl != cash {
			out = append(out, fmt.Sprintf("%s: GL %d, cash ledger %d", a.Name, gl, cash))
		}
	}
	return out
}
