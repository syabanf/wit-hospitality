package domain

// Ledger accounts the close entry uses (GL in src/domain/journal.ts).
const (
	GLOwnerShare      = "gl-5900"
	GLManagementFee   = "gl-4800"
	GLOtherIncome     = "gl-4900"
	GLOwnerReserve    = "gl-2510"
	GLOwnerPayable    = "gl-2500"
	GLOwnerReceivable = "gl-1220"
)

// JournalLine is one debit or credit.
type JournalLine struct {
	AccountID string `json:"accountId"`
	Debit     int64  `json:"debit"`
	Credit    int64  `json:"credit"`
}

// Journal is the JournalDraft finance writes for a statement.
type Journal struct {
	Date         string        `json:"date"`
	VillaID      string        `json:"villaId"`
	Memo         string        `json:"memo"`
	Source       string        `json:"source"`
	SourceID     string        `json:"sourceId"`
	SourceNumber string        `json:"sourceNumber"`
	Origin       *string       `json:"origin"`
	Lines        []JournalLine `json:"lines"`
}

func signedCredit(account string, amount int64) JournalLine {
	if amount >= 0 {
		return JournalLine{AccountID: account, Credit: amount}
	}
	return JournalLine{AccountID: account, Debit: -amount}
}

// CloseJournal is ownerCloseJournal: the villa result leaves the operator's profit on Owner share,
// the fee comes back as income, owner stay charges as other income, the reserve is held and the
// rest is owed to the owner. A shortfall the owner tops up moves to the receivable.
func CloseJournal(st Statement) Journal {
	f := st.Figures
	var topUp int64
	if st.TopsUp() {
		topUp = -st.Payable
	}
	share := JournalLine{AccountID: GLOwnerShare, Debit: f.GOP}
	if f.GOP < 0 {
		share = JournalLine{AccountID: GLOwnerShare, Credit: -f.GOP}
	}
	all := []JournalLine{
		share,
		signedCredit(GLManagementFee, f.ManagementFee),
		signedCredit(GLOtherIncome, f.OwnerStayCharge),
		signedCredit(GLOwnerReserve, f.Reserve),
		signedCredit(GLOwnerPayable, f.NetPayable),
		{AccountID: GLOwnerReceivable, Debit: topUp},
		{AccountID: GLOwnerPayable, Credit: topUp},
	}
	lines := []JournalLine{}
	for _, l := range all {
		if l.Debit > 0 || l.Credit > 0 {
			lines = append(lines, l)
		}
	}
	return Journal{
		Date: MonthEnd(st.Month), VillaID: st.VillaID, Memo: st.Number + " closed: owner share of " + PeriodLabel(st.Month),
		Source: "owner", SourceID: st.ID, SourceNumber: st.Number, Lines: lines,
	}
}

// ReopenJournal is ownerReopenJournal: the close entry with every side swapped.
func ReopenJournal(st Statement, reason string) Journal {
	j := CloseJournal(st)
	j.Memo = st.Number + " reopened: " + reason
	for i, l := range j.Lines {
		j.Lines[i] = JournalLine{AccountID: l.AccountID, Debit: l.Credit, Credit: l.Debit}
	}
	return j
}
