package domain

import (
	"fmt"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// ServiceKinds is SERVICE_KINDS.
var ServiceKinds = []string{"cleaning", "towels", "maintenance", "minibar", "laundry", "transfer", "other"}

// ServiceKindLabel is SERVICE_KIND_LABEL.
var ServiceKindLabel = map[string]string{
	"cleaning": "Room cleaning", "towels": "Towels and amenities", "maintenance": "Maintenance", "minibar": "Minibar refill",
	"laundry": "Laundry", "transfer": "Airport transfer", "other": "Other",
}

// Request statuses.
const (
	RequestOpen       = "open"
	RequestInProgress = "in_progress"
	RequestDone       = "done"
	RequestCancelled  = "cancelled"
)

// ServiceTransitions is SERVICE_TRANSITIONS.
var ServiceTransitions = map[string][]string{
	RequestOpen:       {RequestInProgress, RequestDone, RequestCancelled},
	RequestInProgress: {RequestDone, RequestCancelled},
	RequestDone:       {},
	RequestCancelled:  {},
}

// CodeRequestState refuses a change the request's state does not allow.
const CodeRequestState = "REQUEST_INVALID_STATE"

// ServiceRequest is a guest or housekeeping request against one unit, optionally tied to a stay.
type ServiceRequest struct {
	ID        string  `json:"id"`
	Number    string  `json:"number"`
	UnitID    string  `json:"unitId"`
	BookingID *string `json:"bookingId"`
	Kind      string  `json:"kind"`
	Priority  string  `json:"priority"`
	Note      string  `json:"note"`
	// Charge is what the guest pays for it, zero when included in the stay.
	Charge      int64   `json:"charge"`
	Status      string  `json:"status"`
	Assignee    string  `json:"assignee"`
	RequestedOn string  `json:"requestedOn"`
	RequestedAt int     `json:"requestedAt"`
	DoneOn      *string `json:"doneOn"`
	// TransactionID is set when the charge was recorded in the cashbox.
	TransactionID *string `json:"transactionId"`
	Version       int64   `json:"-"`
}

// ServiceRequestInput is ServiceRequestInput.
type ServiceRequestInput struct {
	UnitID    string  `json:"unitId"`
	BookingID *string `json:"bookingId"`
	Kind      string  `json:"kind"`
	Priority  string  `json:"priority"`
	Note      string  `json:"note"`
	Charge    float64 `json:"charge"`
}

// ValidateServiceRequest is validateServiceRequest.
func ValidateServiceRequest(in ServiceRequestInput) error {
	var f errs.Fields
	if in.UnitID == "" {
		f.Add("unitId", "Pick the unit.")
	}
	if !slices.Contains(ServiceKinds, in.Kind) {
		f.Add("kind", "Pick what the guest needs.")
	}
	if !isInt(in.Charge) || in.Charge < 0 {
		f.Add("charge", "Enter the charge in whole rupiah, or zero.")
	}
	if in.Kind == "other" && len([]rune(strings.TrimSpace(in.Note))) < 3 {
		f.Add("note", "Say what is needed.")
	}
	return f.Err()
}

// Apply copies a validated input onto the request.
func (r *ServiceRequest) Apply(in ServiceRequestInput) {
	r.UnitID, r.Kind, r.Priority, r.Note, r.Charge = in.UnitID, in.Kind, in.Priority, strings.TrimSpace(in.Note), int64(in.Charge)
	r.BookingID = in.BookingID
	if r.BookingID != nil && *r.BookingID == "" {
		r.BookingID = nil
	}
}

// CanEdit is canEditRequest: open and in-progress requests still change.
func (r ServiceRequest) CanEdit() error {
	if r.Status == RequestOpen || r.Status == RequestInProgress {
		return nil
	}
	return errs.New(CodeRequestState, fmt.Sprintf("%s is %s; it can no longer change.", r.Number, r.Status))
}

// NextServiceStep is nextServiceStep: the one forward step a card offers, "" at the end.
func NextServiceStep(status string) string {
	switch status {
	case RequestOpen:
		return RequestInProgress
	case RequestInProgress:
		return RequestDone
	}
	return ""
}

// SortRequests is sortRequests: live work first, urgent before normal, then the oldest request;
// finished ones newest first.
func SortRequests(list []ServiceRequest) []ServiceRequest {
	rank := map[string]int{RequestInProgress: 0, RequestOpen: 1, RequestDone: 2, RequestCancelled: 3}
	urgent := func(r ServiceRequest) int {
		if r.Priority == "urgent" {
			return 0
		}
		return 1
	}
	out := slices.Clone(list)
	slices.SortStableFunc(out, func(a, b ServiceRequest) int {
		if d := rank[a.Status] - rank[b.Status]; d != 0 {
			return d
		}
		if d := urgent(a) - urgent(b); d != 0 {
			return d
		}
		if a.Status == RequestDone || a.Status == RequestCancelled {
			if c := strings.Compare(b.RequestedOn, a.RequestedOn); c != 0 {
				return c
			}
			return b.RequestedAt - a.RequestedAt
		}
		if c := strings.Compare(a.RequestedOn, b.RequestedOn); c != 0 {
			return c
		}
		return a.RequestedAt - b.RequestedAt
	})
	return out
}

// Transition is the request's lifecycle step; done stamps the day.
func (r *ServiceRequest) Transition(to, today string) error {
	if !slices.Contains(ServiceTransitions[r.Status], to) {
		return errs.New(CodeRequestState, fmt.Sprintf("A %s request cannot become %s.", strings.Replace(r.Status, "_", " ", 1), strings.Replace(to, "_", " ", 1)))
	}
	r.Status = to
	if to == RequestDone {
		r.DoneOn = &today
	}
	return nil
}
