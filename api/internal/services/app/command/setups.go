package command

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/services/domain"
)

// StaySetups is what services reads off reservation's booking.saved: the stay, its host and the
// setups the guest asked for before arrival.
type StaySetups struct {
	ID          string  `json:"id"`
	UnitID      string  `json:"unitId"`
	Status      string  `json:"status"`
	CheckIn     string  `json:"checkIn"`
	HostID      *string `json:"hostId"`
	Preferences struct {
		Setups []string `json:"setups"`
	} `json:"preferences"`
}

// setupActor names the reaction on the audit trail: the guest's preferences asked for the setup.
var setupActor = auth.Principal{UserID: "usr-guest", Name: "Guest preferences", Role: "staff"}

// RequestSetups turns each setup a confirmed or in-house stay asks for into one service request to
// its host, the first time the stay names it. A setup taken off later keeps its request for the
// host to cancel. A unit services has not seen yet is skipped.
type RequestSetups struct{ Deps }

// Handle logs the requests.
func (h RequestSetups) Handle(ctx context.Context, s StaySetups) error {
	if len(s.Preferences.Setups) == 0 || (s.Status != "confirmed" && s.Status != "checked_in") {
		return nil
	}
	pl, err := h.place(ctx, s.UnitID)
	if errs.HasCode(err, errs.CodeNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	host, err := h.hostName(ctx, s.HostID)
	if err != nil {
		return err
	}
	for _, setup := range s.Preferences.Setups {
		claimed, err := h.Repo.ClaimSetup(ctx, s.ID, setup)
		if err != nil {
			return err
		}
		if !claimed {
			continue
		}
		n, err := h.Repo.Next(ctx, "request")
		if err != nil {
			return err
		}
		r := domain.ServiceRequest{ID: "rq-" + strconv.FormatInt(n, 10), Number: "RQ-" + strconv.FormatInt(100+n, 10), Status: domain.RequestOpen,
			RequestedOn: h.today(), RequestedAt: h.minute(), Assignee: host}
		r.Apply(domain.SetupRequest(setup, s.UnitID, s.ID, s.CheckIn))
		if err := h.Repo.InsertRequest(ctx, &r, pl.Villa.ID); err != nil {
			return err
		}
		if err := h.record(ctx, setupActor, audit.Line{Action: audit.Create, Entity: "service-request", EntityID: r.Number,
			Summary: fmt.Sprintf("Logged %s %s for %s", r.Number, strings.ToLower(domain.SetupLabel[setup]), pl.Unit.Code)}); err != nil {
			return err
		}
		if err := h.requestEvent(ctx, r, pl.Villa); err != nil {
			return err
		}
	}
	return nil
}

// CleanRequested logs a guest's clean request, which housekeeping met with a stayover task, as an
// open cleaning service request on the stay, once per task.
type CleanRequested struct{ Deps }

// Handle logs the request.
func (h CleanRequested) Handle(ctx context.Context, e housekeeping.CleanRequested) error {
	claimed, err := h.Repo.ClaimSetup(ctx, e.BookingID, "clean:"+e.TaskID)
	if err != nil || !claimed {
		return err
	}
	n, err := h.Repo.Next(ctx, "request")
	if err != nil {
		return err
	}
	booking := e.BookingID
	r := domain.ServiceRequest{ID: "rq-" + strconv.FormatInt(n, 10), Number: "RQ-" + strconv.FormatInt(100+n, 10), Status: domain.RequestOpen,
		RequestedOn: h.today(), RequestedAt: h.minute()}
	r.Apply(domain.ServiceRequestInput{UnitID: e.UnitID, BookingID: &booking, Kind: "cleaning", Priority: "normal", Note: e.Note + " (" + e.TaskNumber + ")"})
	if err := h.Repo.InsertRequest(ctx, &r, e.VillaID); err != nil {
		return err
	}
	if err := h.record(ctx, guestActor, audit.Line{Action: audit.Create, Entity: "service-request", EntityID: r.Number,
		Summary: fmt.Sprintf("Logged %s room cleaning, housekeeping task %s", r.Number, e.TaskNumber)}); err != nil {
		return err
	}
	return h.requestEvent(ctx, r, domain.Villa{ID: e.VillaID, LocationID: e.LocationID})
}

// hostName is the host's name from people, "" without a host or a people client.
func (d Deps) hostName(ctx context.Context, hostID *string) (string, error) {
	if hostID == nil || d.Staff == nil {
		return "", nil
	}
	m, found, err := d.Staff.StaffMember(ctx, *hostID)
	if errs.HasCode(err, CodeNotAvailable) {
		return "", nil
	}
	if err != nil || !found {
		return "", err
	}
	return m.Name, nil
}
