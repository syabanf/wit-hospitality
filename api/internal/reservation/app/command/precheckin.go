package command

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

// guestActor is how the audit trail names a guest acting through a public link.
var guestActor = auth.Principal{UserID: "usr-guest", Name: "Guest", Role: "staff"}

func (d Deps) savePreCheckIn(ctx context.Context, pre *domain.PreCheckIn, b domain.Booking, c domain.Catalog) error {
	if err := d.Repo.SavePreCheckIn(ctx, pre); err != nil {
		return err
	}
	pl, _ := placeOf(c, b.UnitID)
	return d.emit(ctx, reservation.EventPreCheckInSaved, "pre_checkin", pre.BookingID, pre.Version, recordOf(pre.BookingID, []domain.Villa{pl.villa}, pre))
}

// VerifyPreCheckIn records who checked the online check-in against the ID and sets the party on
// the stay. Copying the documents onto the guest profile and the companions is guest's part.
type VerifyPreCheckIn struct{ Deps }

// Handle verifies the pre-check-in.
func (h VerifyPreCheckIn) Handle(ctx context.Context, p auth.Principal, bookingID string) (domain.PreCheckIn, error) {
	if err := h.Authz.Require(ctx, p.Role, bookingEdit...); err != nil {
		return domain.PreCheckIn{}, err
	}
	var out domain.PreCheckIn
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		cat, err := h.Catalog.Catalog(ctx)
		if err != nil {
			return err
		}
		b, _, err := h.booking(ctx, p, cat, bookingID)
		if err != nil {
			return err
		}
		pre, err := h.Repo.PreCheckIn(ctx, b.ID)
		if err != nil {
			return err
		}
		if pre == nil {
			return errs.Newf("PRECHECKIN_NOT_SUBMITTED", "%s has no online check-in to verify yet.", b.Code)
		}
		if pre.Status == "verified" {
			return errs.Newf("PRECHECKIN_VERIFIED", "%s was verified by %s.", b.Code, str(pre.VerifiedBy))
		}
		if b.Status != domain.Confirmed {
			return domain.ErrInvalidState(fmt.Sprintf("%s is %s; verify before check-in.", b.Code, strings.Replace(b.Status, "_", " ", 1)))
		}
		if err := optional(h.Clients.Guests.ApplyPreCheckIn(ctx, p, b, *pre)); err != nil {
			return err
		}
		b.PartySize = &domain.PartySize{Adults: pre.Adults, Children: pre.Children}
		if err := h.saveBooking(ctx, &b, cat); err != nil {
			return err
		}
		at := h.stamp()
		pre.Status, pre.VerifiedBy, pre.VerifiedByID, pre.VerifiedAt = "verified", &p.Name, &p.UserID, &at
		if err := h.savePreCheckIn(ctx, pre, b, cat); err != nil {
			return err
		}
		out = *pre
		return h.record(ctx, p, audit.Line{Action: audit.Status, Entity: "precheckin", EntityID: b.Code, Summary: fmt.Sprintf("Verified the online check-in of %s against the ID", b.Code),
			After: map[string]any{"party": pre.Adults + pre.Children}})
	})
	return out, err
}

// PublicPreCheckIn is what the public page shows, read without a session.
type PublicPreCheckIn struct {
	Token        string          `json:"token"`
	BookingCode  string          `json:"bookingCode"`
	GuestName    string          `json:"guestName"`
	VillaName    string          `json:"villaName"`
	LocationName string          `json:"locationName"`
	UnitName     string          `json:"unitName"`
	CheckIn      string          `json:"checkIn"`
	CheckOut     string          `json:"checkOut"`
	Nights       int             `json:"nights"`
	Status       string          `json:"status"`
	Editable     bool            `json:"editable"`
	Form         json.RawMessage `json:"form"`
	Balance      int64           `json:"balance"`
	PayToken     *string         `json:"payToken"`
	HouseRules   []string        `json:"houseRules"`
	Today        string          `json:"today"`
}

// CheckinLink serves /checkin/{token}: the guest's online check-in, no session needed.
type CheckinLink struct{ Deps }

// stay is the mock's checkinStay: the booking behind the token, while its link is open.
func (h CheckinLink) stay(ctx context.Context, token string) (domain.Booking, error) {
	b, err := h.Repo.BookingByToken(ctx, token)
	if errs.HasCode(err, errs.CodeNotFound) || (err == nil && b.Status == domain.Draft) {
		return b, errs.NotFound("online check-in", token)
	}
	if err != nil {
		return b, err
	}
	if domain.LinkExpired(b, h.today()) {
		return b, errs.Newf("PRECHECKIN_LINK_EXPIRED", "This check-in link closed when %s ended.", b.Code)
	}
	return b, nil
}

// view is the mock's publicView. Guest details come from the guest context and the balance from
// billing; without them the form starts blank and the balance reads zero.
func (h CheckinLink) view(ctx context.Context, token string, b domain.Booking, pre *domain.PreCheckIn) (PublicPreCheckIn, error) {
	cat, err := h.Catalog.Catalog(ctx)
	if err != nil {
		return PublicPreCheckIn{}, err
	}
	pl, _ := placeOf(cat, b.UnitID)
	loc, _ := cat.Location(pl.villa.LocationID)
	guest, err := h.Clients.Guests.Profile(ctx, b.GuestID)
	if err = optional(err); err != nil {
		return PublicPreCheckIn{}, err
	}
	out := PublicPreCheckIn{Token: token, BookingCode: b.Code, GuestName: guest.Name, VillaName: pl.villa.Name, LocationName: loc.Name,
		CheckIn: b.CheckIn, CheckOut: b.CheckOut, Nights: domain.DaysBetween(b.CheckIn, b.CheckOut), Status: "not_started",
		Editable: domain.GuestCanEdit(b, pre), HouseRules: domain.HouseRules, Today: h.today()}
	switch {
	case b.UnitAssigned:
		out.UnitName = pl.unit.Code + " " + pl.unit.Name
	case pl.hasGroup:
		out.UnitName = pl.group.Name
	default:
		out.UnitName = pl.unit.Name
	}
	if b.Source == domain.Direct {
		owed, err := h.Clients.Billing.Owed(ctx, b.ID)
		if err = optional(err); err != nil {
			return PublicPreCheckIn{}, err
		}
		out.Balance = max(0, owed)
	}
	if pre != nil {
		out.Status = pre.Status
		out.Form = mustJSON(map[string]any{"email": pre.Email, "phone": pre.Phone, "arrivalTime": pre.ArrivalTime, "flight": pre.Flight, "adults": pre.Adults,
			"children": pre.Children, "travellers": pre.Travellers, "idPhotos": pre.IDPhotos, "rulesName": pre.RulesName, "rulesAccepted": pre.RulesAccepted})
		return out, nil
	}
	adults, children := 2, 0
	if b.PartySize != nil {
		adults, children = b.PartySize.Adults, b.PartySize.Children
	}
	lead := domain.TravellerDocument{Name: guest.Name, Nationality: guest.Nationality, DocumentType: guest.IDType, DocumentNumber: guest.IDNumber, VisaType: "voa", Sex: "female"}
	if domain.IsIndonesian(guest.Nationality) {
		lead.VisaType = "none"
	}
	out.Form = mustJSON(map[string]any{"email": guest.Email, "phone": guest.Phone, "arrivalTime": "14:00", "flight": "", "adults": adults, "children": children,
		"travellers": []domain.TravellerDocument{lead}, "idPhotos": []any{}, "rulesName": "", "rulesAccepted": false})
	return out, nil
}

// View is GET /checkin/{token}.
func (h CheckinLink) View(ctx context.Context, token string) (PublicPreCheckIn, error) {
	b, err := h.stay(ctx, token)
	if err != nil {
		return PublicPreCheckIn{}, err
	}
	pre, err := h.Repo.PreCheckIn(ctx, b.ID)
	if err != nil {
		return PublicPreCheckIn{}, err
	}
	return h.view(ctx, token, b, pre)
}

// Submit is PUT /checkin/{token}: the guest sends or updates the form until the desk verifies it.
func (h CheckinLink) Submit(ctx context.Context, token string, in domain.PreCheckInInput) (PublicPreCheckIn, error) {
	var out PublicPreCheckIn
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		b, err := h.stay(ctx, token)
		if err != nil {
			return err
		}
		pre, err := h.Repo.PreCheckIn(ctx, b.ID)
		if err != nil {
			return err
		}
		if !domain.GuestCanEdit(b, pre) {
			msg := "You are checked in already."
			if pre != nil && pre.Status == "verified" {
				msg = "The front desk already verified your details. Ask them to change anything."
			}
			return errs.New("PRECHECKIN_LOCKED", msg)
		}
		if err := domain.ValidatePreCheckIn(in, b.CheckIn, b.CheckOut); err != nil {
			return err
		}
		record := domain.PreCheckIn{BookingID: b.ID, Email: strings.TrimSpace(in.Email), Phone: strings.TrimSpace(in.Phone), ArrivalTime: in.ArrivalTime,
			Flight: strings.ToUpper(strings.TrimSpace(in.Flight)), Adults: int(in.Adults), Children: int(in.Children), Travellers: in.Travellers,
			RulesName: strings.TrimSpace(in.RulesName), RulesAccepted: in.RulesAccepted, Status: "submitted", SubmittedAt: h.stamp(), IDPhotos: []json.RawMessage{}}
		for _, photo := range in.IDPhotos {
			copied := map[string]any{}
			for k, v := range photo {
				copied[k] = v
			}
			copied["uploadedBy"] = guestActor.Name
			record.IDPhotos = append(record.IDPhotos, mustJSON(copied))
		}
		action, verb := audit.Create, "sent"
		if pre != nil {
			record.Version, action, verb = pre.Version, audit.Update, "updated"
		}
		cat, err := h.Catalog.Catalog(ctx)
		if err != nil {
			return err
		}
		if err := h.savePreCheckIn(ctx, &record, b, cat); err != nil {
			return err
		}
		if err := h.record(ctx, guestActor, audit.Line{Action: action, Entity: "precheckin", EntityID: b.Code, Summary: fmt.Sprintf("Guest %s the online check-in for %s", verb, b.Code),
			After: map[string]any{"adults": record.Adults, "arrivalTime": record.ArrivalTime}}); err != nil {
			return err
		}
		out, err = h.view(ctx, token, b, &record)
		return err
	})
	return out, err
}

// gatewayMethods is GATEWAY_METHODS.
var gatewayMethods = []string{"qris", "virtual_account", "card"}

// PayBalance is POST /checkin/{token}/pay: billing opens a gateway link for the room balance.
func (h CheckinLink) PayBalance(ctx context.Context, token, method string) (json.RawMessage, error) {
	b, err := h.stay(ctx, token)
	if err != nil {
		return nil, err
	}
	if !slices.Contains(gatewayMethods, method) {
		return nil, errs.New(errs.CodeValidation, "Pay by QRIS, virtual account or card.")
	}
	return h.Clients.Billing.PayBalance(ctx, b, method)
}
