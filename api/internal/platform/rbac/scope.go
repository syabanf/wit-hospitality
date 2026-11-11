package rbac

import "slices"

// Scope is the villas and locations a user may see. Empty lists mean no restriction.
type Scope struct {
	LocationIDs []string
	VillaIDs    []string
}

// Restricted reports whether the scope narrows anything.
func (s Scope) Restricted() bool { return len(s.LocationIDs) > 0 || len(s.VillaIDs) > 0 }

// AllowedVilla is allowedVilla: a villa list wins over a location list; empty lists allow all.
func (s Scope) AllowedVilla(villaID, locationID string) bool {
	if len(s.VillaIDs) > 0 {
		return slices.Contains(s.VillaIDs, villaID)
	}
	if len(s.LocationIDs) > 0 {
		return slices.Contains(s.LocationIDs, locationID)
	}
	return true
}
