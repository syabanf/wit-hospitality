package domain

import (
	"sort"
	"strings"
)

// StayFolio is one stay of a group with its whole folio.
type StayFolio struct {
	Booking Booking
	Folio   GuestFolio
}

// MasterLine is a master folio line with the stays it belongs to.
type MasterLine struct {
	FolioLine
	Stays []string `json:"stays"`
}

// MasterFolio is MasterFolio.
type MasterFolio struct {
	Lines    []MasterLine `json:"lines"`
	Debits   int64        `json:"debits"`
	Credits  int64        `json:"credits"`
	Balance  int64        `json:"balance"`
	Forecast int64        `json:"forecast"`
	Due      int64        `json:"due"`
}

// Master is masterFolio: the room lines of every stay; the shares of one group payment show as one payment.
func Master(stays []StayFolio, payments []Payment) MasterFolio {
	batchOf := map[string]string{}
	for _, p := range payments {
		if p.Batch != "" {
			batchOf[p.ID] = p.Batch
		}
	}
	var keys []string
	merged := map[string]*MasterLine{}
	for _, s := range stays {
		for _, line := range s.Folio.Lines {
			if !OnMaster(line) {
				continue
			}
			batch := ""
			if line.Ref.Type == "payment" {
				batch = batchOf[line.Ref.ID]
			}
			key := s.Booking.Code + "|" + line.ID
			if batch != "" {
				key = batch + "|" + line.Kind
			}
			known := merged[key]
			var codes []string
			if known != nil {
				codes = append(codes, known.Stays...)
			}
			codes = append(codes, s.Booking.Code)
			description := s.Booking.Code + " · " + line.Description
			if batch != "" {
				description = "Group payment " + batch + " over " + strings.Join(codes, ", ")
			}
			if known != nil {
				known.Debit += line.Debit
				known.Credit += line.Credit
				known.Stays, known.Description = codes, description
				continue
			}
			l := line
			l.ID, l.Description = key, description
			if batch != "" {
				l.Ref.Label = batch
			}
			merged[key] = &MasterLine{FolioLine: l, Stays: codes}
			keys = append(keys, key)
		}
	}
	plain := make([]FolioLine, len(keys))
	staysOf := map[string][]string{}
	for i, k := range keys {
		plain[i] = merged[k].FolioLine
		staysOf[k] = merged[k].Stays
	}
	sort.SliceStable(plain, func(i, j int) bool { return byPosting(plain[i], plain[j]) })
	lines, debitSum, creditSum, forecast := RunningBalance(plain)
	out := MasterFolio{Lines: make([]MasterLine, len(lines)), Debits: debitSum, Credits: creditSum, Balance: debitSum - creditSum, Forecast: forecast,
		Due: max(0, debitSum-creditSum+forecast)}
	for i, l := range lines {
		out.Lines[i] = MasterLine{FolioLine: l, Stays: staysOf[l.ID]}
	}
	return out
}
