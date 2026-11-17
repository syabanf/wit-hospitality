package domain

import "testing"

func TestStayLinkState(t *testing.T) {
	for _, c := range []struct {
		status, today, want string
	}{
		{CheckedIn, "2026-11-11", StayLinkOpen},
		{CheckedIn, "2026-11-15", StayLinkOpen},
		{CheckedOut, "2026-11-15", StayLinkReadOnly},
		{CheckedOut, "2026-11-16", StayLinkExpired},
		{Cancelled, "2026-11-11", StayLinkExpired},
	} {
		if got := StayLinkState(Booking{Status: c.status, CheckOut: "2026-11-14"}, c.today); got != c.want {
			t.Errorf("%s on %s: %s, want %s", c.status, c.today, got, c.want)
		}
	}
}

func TestStayTokenAndGuestRules(t *testing.T) {
	var random [16]byte
	random[0] = 0xab
	token := StayToken(random)
	if !IsStayToken(token) || IsStayToken("st12") || IsStayToken("ci"+token[2:]) {
		t.Fatalf("token %s", token)
	}
	if ValidateGuestWindow(KindVilla, ServiceWindow{Mode: WindowScheduled}) == nil || ValidateGuestWindow(KindRoom, ServiceWindow{Mode: WindowWindow, From: "10:00", To: "12:00"}) == nil {
		t.Fatal("a villa takes a window or DND, a room the schedule or DND")
	}
	if ValidateGuestWindow(KindRoom, ServiceWindow{Mode: WindowDND}) != nil {
		t.Fatal("a room may ask not to be disturbed")
	}
	if ValidateGuestRequest(GuestRequestInput{Kind: "other", Note: "x"}) == nil || ValidateGuestRequest(GuestRequestInput{Kind: "towels"}) != nil {
		t.Fatal("guest request rules")
	}
	var b Booking
	for range GuestActionsKept + 3 {
		b.AddGuestAction(GuestAction{Kind: GuestOrder, At: "2026-11-11T10:00:00"})
	}
	b.AddGuestAction(GuestAction{Kind: GuestClean, At: "2026-11-11T14:02:00"})
	if len(b.GuestActions) != GuestActionsKept || b.CleanAskedAt("2026-11-11") != "2026-11-11T14:02:00" || b.CleanAskedAt("2026-11-12") != "" {
		t.Fatalf("guest actions %d", len(b.GuestActions))
	}
}
