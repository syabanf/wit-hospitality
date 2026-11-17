package domain

import (
	"slices"
	"testing"
)

// The cases follow src/domain/villaOps.test.ts.

func TestReadingBillMatchesTheConsole(t *testing.T) {
	m := Meter{ID: "mtr-1", Payer: "guest", Tariff: 1_700, Kind: "electricity", Unit: "kWh", Number: "PLN-1"}
	stay := "b-1"
	checkIn := MeterReading{ID: "mrd-1", Purpose: "check_in", BookingID: &stay}
	monthly := MeterReading{ID: "mrd-2", Purpose: "monthly", Consumption: 30}
	bill := ReadingBill(m, MeterReading{Purpose: "check_out", BookingID: &stay, Consumption: 20.5}, []MeterReading{checkIn, monthly})
	if bill == nil || bill.Usage != 50.5 || bill.Amount != 85_850 || bill.Payer != "guest" {
		t.Fatalf("guest bill %+v", bill)
	}
	if ReadingBill(m, MeterReading{Purpose: "monthly", Consumption: 20}, nil) != nil {
		t.Fatal("a guest-paid monthly reading billed")
	}
	m.Payer = "owner"
	if b := ReadingBill(m, MeterReading{Purpose: "monthly", Consumption: 20}, nil); b == nil || b.Amount != 34_000 {
		t.Fatalf("owner bill %+v", b)
	}
	if got := UtilityDescription(m, 20); got != "Electricity 20 kWh at 1700 per kWh, meter PLN-1" {
		t.Fatalf("description %q", got)
	}
}

func TestUpkeepTaskKeepsClearOfTheGuest(t *testing.T) {
	fog := TemplatePlans(ApplyTemplateInput{VillaID: "v-1", Template: "fogging", StartOn: "2026-11-11"})[0]
	if u, _ := UpkeepTask(fog, &UpkeepStay{BookingID: "b-1", BookingCode: "BK-1", Window: ServiceWindow{Mode: "dnd"}}, "Villa Karang", "2026-11-11"); u != nil {
		t.Fatal("a do-not-disturb stay got a task")
	}
	u, note := UpkeepTask(fog, &UpkeepStay{BookingID: "b-1", BookingCode: "BK-1", Window: ServiceWindow{Mode: "window", From: "10:00", To: "12:00"}}, "Villa Karang", "2026-11-11")
	if u == nil || note != "Outside the guest's service window 10:00 to 12:00." || u.Notice == nil ||
		u.Notice.Text != "Mosquito fogging at Villa Karang on 2026-11-11, outside your service window (10:00 to 12:00). Please keep doors and windows closed for 30 minutes afterwards." {
		t.Fatalf("fogging %+v %q", u, note)
	}
	if !slices.Equal(PoolFlags(8, 0.8), []string{"pH high", "Chlorine low"}) || len(PoolFlags(7.4, 2)) != 0 {
		t.Fatal("pool flags")
	}
}
