package domain

import (
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/property"
)

// MaxSectionName is the longest section name.
const MaxSectionName = 40

// CodeSectionHotelOnly refuses a section in a property that operates as a villa.
const CodeSectionHotelOnly = "SECTION_HOTEL_ONLY"

// Section is a named set of rooms of one hotel or mixed property.
type Section struct {
	ID      string   `json:"id"`
	VillaID string   `json:"villaId"`
	Name    string   `json:"name"`
	UnitIDs []string `json:"unitIds"`
	Version int64    `json:"-"`
}

// SectionInput is the section form.
type SectionInput struct {
	VillaID string   `json:"villaId"`
	Name    string   `json:"name"`
	UnitIDs []string `json:"unitIds"`
}

// SectionRoom is a unit as the section rules read it: where it sits and its kind.
type SectionRoom struct {
	ID      string
	Code    string
	VillaID string
	Kind    string
}

// ValidateSection is validateSection. rooms holds the property's units by id, others its other
// sections; current is the section being edited, nil for a new one.
func ValidateSection(in SectionInput, villa Villa, rooms map[string]SectionRoom, others []Section, current *Section) error {
	if villa.Operation != OperationHotel && villa.Operation != OperationMixed {
		return errs.Newf(CodeSectionHotelOnly, "Sections group hotel rooms; %s has none.", villa.Name)
	}
	var f errs.Fields
	if current != nil && in.VillaID != current.VillaID {
		f.Add("villaId", "A section stays with its property.")
	}
	name := strings.TrimSpace(in.Name)
	switch n := utf8.RuneCountInString(name); {
	case n < 2:
		f.Add("name", "Name the section.")
	case n > MaxSectionName:
		f.Add("name", fmt.Sprintf("A section name is at most %d characters.", MaxSectionName))
	default:
		for _, o := range others {
			if strings.EqualFold(o.Name, name) {
				f.Add("name", fmt.Sprintf("%s is already a section of %s.", name, villa.Name))
				break
			}
		}
	}
	if len(in.UnitIDs) == 0 {
		f.Add("unitIds", "Pick at least one room.")
	}
	for _, id := range in.UnitIDs {
		if f.Has("unitIds") {
			break
		}
		room, ok := rooms[id]
		if !ok || room.VillaID != villa.ID || room.Kind != KindRoom {
			f.Add("unitIds", "Pick rooms of this property.")
			break
		}
		for _, o := range others {
			if slices.Contains(o.UnitIDs, id) {
				f.Add("unitIds", fmt.Sprintf("%s is already in %s.", room.Code, o.Name))
				break
			}
		}
	}
	return f.Err()
}

// Apply puts a valid form on the section: the name trimmed, each room once.
func (s *Section) Apply(in SectionInput) {
	s.VillaID, s.Name, s.UnitIDs = in.VillaID, strings.TrimSpace(in.Name), []string{}
	for _, id := range in.UnitIDs {
		if !slices.Contains(s.UnitIDs, id) {
			s.UnitIDs = append(s.UnitIDs, id)
		}
	}
}

// SectionState is the section as its events carry it.
func SectionState(s Section) property.Section {
	return property.Section{ID: s.ID, VillaID: s.VillaID, Name: s.Name, UnitIDs: list(s.UnitIDs)}
}
