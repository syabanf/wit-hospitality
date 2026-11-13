package domain

import (
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// ServiceWindow is when a stay lets housekeeping in, from reservation: the schedule, a window
// (From and To are HH:MM), or do not disturb.
type ServiceWindow struct {
	Mode string `json:"mode"`
	From string `json:"from"`
	To   string `json:"to"`
}

// WindowDND is the do-not-disturb mode.
const WindowDND = "dnd"

// CodeTaskDND refuses starting a task for a stay that asked not to be disturbed.
const CodeTaskDND = "TASK_DND"

// CarriesWindow reports whether a task of the type serves a guest in house and so carries the
// stay's window: every task but the departure clean, which follows the guest's leaving.
func CarriesWindow(taskType string) bool { return taskType != Departure }

// CheckDND refuses starting a task while the stay's window is do not disturb, unless a supervisor
// overrides with a reason; it returns the reason when one was given.
func CheckDND(w *ServiceWindow, supervisor bool, override string) (string, error) {
	if w == nil || w.Mode != WindowDND {
		return "", nil
	}
	reason := strings.TrimSpace(override)
	if reason == "" {
		return "", errs.New(CodeTaskDND, "The guest asked not to be disturbed.")
	}
	if !supervisor {
		return "", errs.Forbidden("Only a housekeeping supervisor can go in on a do not disturb stay.")
	}
	return reason, nil
}

// ExtraClean is the guest's own ask for a clean of their stay: the kind POST
// /bookings/{id}/service-requests takes.
const ExtraClean = "clean"
