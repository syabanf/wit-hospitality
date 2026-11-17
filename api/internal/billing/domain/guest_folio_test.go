package domain

import "testing"

func TestGuestFolioOf(t *testing.T) {
	v := GuestFolioOf(GuestFolio{Lines: []FolioLine{
		{Date: "2026-11-10", Kind: KindRoom, Description: "Night of 10 Nov, rate 1.500.000 (direct)", Debit: 1_500_000, Code: "ROOM"},
		{Date: "2026-11-10", Kind: KindTax, Code: ServiceCode, Debit: 150_000},
		{Date: "2026-11-10", Kind: KindTax, Code: PB1Code, Debit: 165_000},
		{Date: "2026-11-10", Kind: KindRoomService, Description: "SO-701: 2 × Nasi goreng", Debit: 90_000, Code: "FNB"},
		{Date: "2026-11-10", Kind: KindPayment, Description: "Payment PAY-1 ref 99812", Credit: 1_000_000, Code: "PAY"},
		{Date: "2026-11-12", Kind: KindRoom, Description: "Night of 12 Nov", Debit: 1_500_000, Forecast: true},
		{Date: "2026-11-10", Kind: KindDeposit, Memo: 500_000},
	}, Balance: 905_000, Forecast: 1_500_000, DepositHeld: 500_000})
	labels := []string{}
	for _, l := range v.Lines {
		labels = append(labels, l.Label)
	}
	want := []string{"Night of 10 Nov", "Service charge", "PB1, regional hotel tax", "2 × Nasi goreng", "Payment"}
	if len(labels) != len(want) {
		t.Fatalf("labels %v", labels)
	}
	for i := range want {
		if labels[i] != want[i] {
			t.Fatalf("labels %v", labels)
		}
	}
	if v.Subtotal != 1_590_000 || v.Service != 150_000 || v.PB1 != 165_000 || v.Balance != 905_000 || v.ToCome != 1_500_000 || v.DepositHeld != 500_000 {
		t.Fatalf("totals %+v", v)
	}
}
