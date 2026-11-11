// Package guest is the published language of the guest context: the events it publishes and the
// client other contexts use to ask it questions (client.go). Other contexts may import this
// package and nothing below it.
package guest

// Event types; the suffix is the payload version. The guest aggregate shares the context's name,
// so its events read guest.<verb>.v1.
const (
	EventGuestCreated     = "guest.created.v1"
	EventGuestUpdated     = "guest.updated.v1"
	EventGuestMerged      = "guest.merged.v1"
	EventCompanionAdded   = "guest.companion.added.v1"
	EventCompanionUpdated = "guest.companion.updated.v1"
	EventCompanionRemoved = "guest.companion.removed.v1"
	EventGuestsReported   = "guest.foreign_report.recorded.v1"
	EventLostItemLogged   = "guest.lost_item.logged.v1"
	EventLostItemUpdated  = "guest.lost_item.updated.v1"
	EventLostItemMoved    = "guest.lost_item.moved.v1"
	EventSettingsSaved    = "guest.lost_found_settings.saved.v1"
)

// Blacklist is a refused guest's entry.
type Blacklist struct {
	Reason string `json:"reason"`
	SetBy  string `json:"setBy"`
	SetOn  string `json:"setOn"`
}

// Guest is the part of a profile other contexts use: names on stays, folios and messages, the
// alerts the desk sees, the blacklist.
type Guest struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Email       string     `json:"email"`
	Phone       string     `json:"phone"`
	Nationality string     `json:"nationality"`
	VipLevel    int        `json:"vipLevel"`
	VipReason   string     `json:"vipReason"`
	Allergies   string     `json:"allergies"`
	Blacklist   *Blacklist `json:"blacklist"`
}

// GuestEvent is the payload of guest.created and guest.updated (a blacklist change is an update).
type GuestEvent struct {
	Guest Guest `json:"guest"`
}

// GuestMerged is the payload of guest.merged. The dropped profile no longer exists: every
// reference to DropID now points at KeepID. Consumers move what they own: reservation moves
// bookings (guestId) and booking groups (leadGuestId); billing, messaging and services re-point
// any guest id they keep. Guest has already moved its own lost items and Immigration reports.
type GuestMerged struct {
	KeepID          string   `json:"keepId"`
	DropID          string   `json:"dropId"`
	Guest           Guest    `json:"guest"`
	MovedLostItems  []string `json:"movedLostItems"`
	MovedReportsFor []string `json:"movedReportsFor"`
}

// CompanionEvent is the payload of companion.added and companion.updated.
type CompanionEvent struct {
	ID        string `json:"id"`
	BookingID string `json:"bookingId"`
	Name      string `json:"name"`
	Adult     bool   `json:"adult"`
	VillaID   string `json:"villaId"`
}

// CompanionRemoved is the payload of companion.removed.
type CompanionRemoved struct {
	ID        string `json:"id"`
	BookingID string `json:"bookingId"`
}

// GuestsReported is the payload of foreign_report.recorded: who on a stay went to Immigration.
type GuestsReported struct {
	BookingID  string   `json:"bookingId"`
	PersonIDs  []string `json:"personIds"`
	ReportIDs  []string `json:"reportIds"`
	Reference  string   `json:"reference"`
	ReportedAt string   `json:"reportedAt"`
	VillaID    string   `json:"villaId"`
}

// LostItemEvent is the payload of lost_item.logged, lost_item.updated and lost_item.moved.
type LostItemEvent struct {
	ID          string  `json:"id"`
	Number      string  `json:"number"`
	VillaID     string  `json:"villaId"`
	UnitID      *string `json:"unitId"`
	GuestID     *string `json:"guestId"`
	BookingID   *string `json:"bookingId"`
	Description string  `json:"description"`
	Status      string  `json:"status"`
}

// SettingsSaved is the payload of lost_found_settings.saved.
type SettingsSaved struct {
	HoldDays int `json:"holdDays"`
}
