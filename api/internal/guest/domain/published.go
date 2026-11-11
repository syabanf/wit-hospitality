package domain

import "github.com/syabanf/wit-hospitality/api/internal/guest"

// Summary is the published part of a profile.
func (g Guest) Summary() guest.Guest {
	out := guest.Guest{ID: g.ID, Name: g.Name, Email: g.Email, Phone: g.Phone, Nationality: g.Nationality, VipLevel: g.VipLevel, VipReason: g.VipReason, Allergies: g.Preferences.Allergies}
	if g.Blacklist != nil {
		out.Blacklist = &guest.Blacklist{Reason: g.Blacklist.Reason, SetBy: g.Blacklist.SetBy, SetOn: g.Blacklist.SetOn}
	}
	return out
}

// State is the published part of a lost item.
func (i LostItem) State() guest.LostItemEvent {
	return guest.LostItemEvent{ID: i.ID, Number: i.Number, VillaID: i.VillaID, UnitID: i.UnitID, GuestID: i.GuestID, BookingID: i.BookingID, Description: i.Description, Status: i.Status}
}
