package domain

import (
	"encoding/json"
	"os"
	"testing"
)

// From accounting.test.ts "rebuilds the seeded journal from the cash ledger": the Go posting rules
// write the same lines for every posted cash entry the TypeScript buildJournals wrote.
func TestJournalForRebuildsTheSeededCashEntries(t *testing.T) {
	raw, err := os.ReadFile("../../../seed/finance.json")
	if err != nil {
		t.Fatal(err)
	}
	var s struct {
		Categories       []Category        `json:"categories"`
		Transactions     []Transaction     `json:"transactions"`
		Journals         []JournalEntry    `json:"journals"`
		CategoryAccounts map[string]string `json:"categoryAccounts"`
		TransactionCodes []TransactionCode `json:"transactionCodes"`
		Stays            []Stay            `json:"stays"`
		Links            []EntryLink       `json:"links"`
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	stays := map[string]Stay{}
	for _, x := range s.Stays {
		stays[x.ID] = x
	}
	links := map[string]*EntryLink{}
	for i := range s.Links {
		links[s.Links[i].TransactionID] = &s.Links[i]
	}
	checked := 0
	for _, tx := range s.Transactions {
		// Salary payments need the payroll's lines, which payroll keeps.
		if !Counts(tx.Status) || tx.Origin == "payroll" && tx.CategoryID == "cat-payroll" {
			continue
		}
		b := Books{Map: s.CategoryAccounts, Categories: s.Categories, Codes: s.TransactionCodes, Stays: stays, Self: links[tx.ID]}
		if tx.ReversalOf != nil {
			b.Origin = links[*tx.ReversalOf]
		}
		for _, o := range s.Transactions {
			if tx.TransferID != nil && o.TransferID != nil && *o.TransferID == *tx.TransferID && o.ID != tx.ID && Counts(o.Status) {
				b.Twin = &o
			}
		}
		draft, err := JournalFor(tx, b)
		if err != nil {
			t.Fatalf("%s: %v", tx.Number, err)
		}
		var want *JournalEntry
		for i := range s.Journals {
			if s.Journals[i].Source == draft.Source && s.Journals[i].SourceID == draft.SourceID {
				want = &s.Journals[i]
			}
		}
		if want == nil {
			t.Errorf("%s: no seeded %s entry", tx.Number, draft.Source)
			continue
		}
		got, _ := json.Marshal(draft.Lines)
		exp, _ := json.Marshal(want.Lines)
		if string(got) != string(exp) {
			t.Errorf("%s %s:\n got %s\nwant %s", tx.Number, tx.Description, got, exp)
		}
		checked++
	}
	if checked < 150 {
		t.Fatalf("checked %d entries", checked)
	}
}
