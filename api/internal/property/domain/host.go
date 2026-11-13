package domain

import (
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// CodeHostNotAllocated refuses a villa host who is not an active employee allocated to the villa.
const CodeHostNotAllocated = "HOST_NOT_ALLOCATED"

// HostInput is the unit form's hostId: Set tells a sent value, null included, from one left out,
// which keeps the unit's host. An empty ID clears it.
type HostInput struct {
	Set bool
	ID  string
}

// UnmarshalJSON reads a string or null.
func (h *HostInput) UnmarshalJSON(raw []byte) error {
	h.Set, h.ID = true, ""
	if string(raw) == "null" {
		return nil
	}
	return json.Unmarshal(raw, &h.ID)
}

// UnitKind is a unit's kind: its room type's, or without one the property's default.
func UnitKind(group *UnitGroup, operation string) string {
	if group != nil && group.Kind != "" {
		return group.Kind
	}
	return DefaultKind(operation)
}

// CheckHostKind refuses a host on a room: hosts look after villa-kind units.
func CheckHostKind(hostID *string, kind string) error {
	if hostID != nil && kind == KindRoom {
		return errs.Invalid("hostId", "A room has no host; hosts look after villas.")
	}
	return nil
}

// ErrHostNotAllocated is HOST_NOT_ALLOCATED; name is the employee's, or their id when unknown.
func ErrHostNotAllocated(name, villa string) error {
	return errs.Newf(CodeHostNotAllocated, "%s is not allocated to %s.", name, villa)
}
