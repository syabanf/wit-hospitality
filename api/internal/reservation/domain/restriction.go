package domain

import (
	"fmt"
	"slices"
	"sort"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// RestrictionRules is RESTRICTION_RULES, in the order a stay is checked and violations listed.
var RestrictionRules = []string{"stop_sell", "closed_to_arrival", "closed_to_departure", "min_stay", "min_stay_through", "max_stay"}

// RestrictionRuleLabel is RESTRICTION_RULE_LABEL.
var RestrictionRuleLabel = map[string]string{
	"stop_sell": "Stop sell", "closed_to_arrival": "Closed to arrival", "closed_to_departure": "Closed to departure",
	"min_stay": "Minimum stay", "min_stay_through": "Minimum stay through", "max_stay": "Maximum stay",
}

// WithNights is withNights: the rules that carry a number of nights.
func WithNights(rule string) bool {
	return rule == "min_stay" || rule == "min_stay_through" || rule == "max_stay"
}

// MaxRuleNights is MAX_RULE_NIGHTS.
const MaxRuleNights = 90

var weekdayLabel = []string{"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}

// RestrictionInput is the restriction form. Nights and weekdays arrive as JSON numbers.
type RestrictionInput struct {
	GroupID  string    `json:"groupId"`
	UnitID   *string   `json:"unitId"`
	Rule     string    `json:"rule"`
	Nights   *float64  `json:"nights"`
	Yearly   bool      `json:"yearly"`
	From     string    `json:"from"`
	To       string    `json:"to"`
	Weekdays []float64 `json:"weekdays"`
	Note     string    `json:"note"`
}

// BulkRestrictionInput is one rule for several room types.
type BulkRestrictionInput struct {
	RestrictionInput
	GroupIDs []string `json:"groupIds"`
}

// Restriction is a saved restriction.
type Restriction struct {
	ID        string  `json:"id"`
	GroupID   string  `json:"groupId"`
	UnitID    *string `json:"unitId"`
	Rule      string  `json:"rule"`
	Nights    *int    `json:"nights"`
	Yearly    bool    `json:"yearly"`
	From      string  `json:"from"`
	To        string  `json:"to"`
	Weekdays  []int   `json:"weekdays"`
	Note      string  `json:"note"`
	CreatedBy string  `json:"createdBy"`
	CreatedOn string  `json:"createdOn"`
	Version   int64   `json:"-"`
}

// Unit returns the restriction's unit id, or "".
func (r Restriction) Unit() string {
	if r.UnitID == nil {
		return ""
	}
	return *r.UnitID
}

func validMonthDay(md string) bool {
	if len(md) != 5 || md[2] != '-' {
		return false
	}
	var month, day int
	if _, err := fmt.Sscanf(md, "%02d-%02d", &month, &day); err != nil {
		return false
	}
	days := []int{31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}
	return month >= 1 && month <= 12 && day >= 1 && day <= days[month-1]
}

// RestrictionFields is validateRestriction without the room type and unit.
func RestrictionFields(in RestrictionInput) errs.Fields {
	var f errs.Fields
	if !slices.Contains(RestrictionRules, in.Rule) {
		f.Add("rule", "Pick a rule.")
	}
	if WithNights(in.Rule) && (in.Nights == nil || !whole(*in.Nights) || *in.Nights < 1 || *in.Nights > MaxRuleNights) {
		f.Add("nights", fmt.Sprintf("Enter whole nights from 1 to %d.", MaxRuleNights))
	}
	if in.Yearly {
		if !validMonthDay(in.From) {
			f.Add("from", "Pick the first day as MM-DD.")
		}
		if !validMonthDay(in.To) {
			f.Add("to", "Pick the last day as MM-DD.")
		}
	} else {
		if !isoDate.MatchString(in.From) {
			f.Add("from", "Pick the first day.")
		}
		if !isoDate.MatchString(in.To) {
			f.Add("to", "Pick the last day.")
		} else if isoDate.MatchString(in.From) && in.To < in.From {
			f.Add("to", "The last day comes on or after the first.")
		}
	}
	seen := map[float64]bool{}
	for _, d := range in.Weekdays {
		if !whole(d) || d < 0 || d > 6 || seen[d] {
			f.Add("weekdays", "Pick each day of the week once.")
			break
		}
		seen[d] = true
	}
	return f
}

// NewRestriction builds a restriction from a valid form, as the mock's restrictionOf does.
func NewRestriction(id string, in RestrictionInput, by, today string) Restriction {
	r := Restriction{ID: id, GroupID: in.GroupID, Rule: in.Rule, Yearly: in.Yearly, From: in.From, To: in.To, Note: Trim(in.Note), CreatedBy: by, CreatedOn: today, Weekdays: []int{}}
	if in.UnitID != nil && *in.UnitID != "" {
		u := *in.UnitID
		r.UnitID = &u
	}
	if WithNights(in.Rule) && in.Nights != nil {
		n := int(*in.Nights)
		r.Nights = &n
	}
	for _, d := range in.Weekdays {
		r.Weekdays = append(r.Weekdays, int(d))
	}
	sort.Ints(r.Weekdays)
	return r
}

// On is restrictionOn: inside the range and on one of its days of the week.
func (r Restriction) On(date string) bool {
	in := date >= r.From && date <= r.To
	if r.Yearly {
		in = InYearlyRange(r.From, r.To, date)
	}
	return in && (len(r.Weekdays) == 0 || slices.Contains(r.Weekdays, WeekdayIndex(date)))
}

// StayShape is the stay a rule is checked against; UnitID is "" for a stay booked by type.
type StayShape struct {
	GroupID  string
	UnitID   string
	CheckIn  string
	CheckOut string
}

// Violation is one broken rule.
type Violation struct {
	Rule    string
	Dates   []string
	Nights  *int
	Message string
}

func forStay(list []Restriction, groupID, unitID string) []Restriction {
	var out []Restriction
	for _, r := range list {
		if groupID != "" && r.GroupID == groupID && (r.UnitID == nil || *r.UnitID == unitID) {
			out = append(out, r)
		}
	}
	return out
}

// EvaluateStay is evaluateStay: one violation per rule, in RestrictionRules order; where two
// rules of a kind apply, the strictest speaks.
func EvaluateStay(list []Restriction, stay StayShape) []Violation {
	mine := forStay(list, stay.GroupID, stay.UnitID)
	if len(mine) == 0 {
		return nil
	}
	nights := max(0, DaysBetween(stay.CheckIn, stay.CheckOut))
	stayNights := EachDay(stay.CheckIn, stay.CheckOut)
	on := func(rule, date string) []Restriction {
		var out []Restriction
		for _, r := range mine {
			if r.Rule == rule && r.On(date) {
				out = append(out, r)
			}
		}
		return out
	}
	need := func(rs []Restriction) int {
		n := 0
		for _, r := range rs {
			if r.Nights != nil {
				n = max(n, *r.Nights)
			}
		}
		return n
	}
	var out []Violation
	for _, rule := range RestrictionRules {
		switch rule {
		case "stop_sell":
			var closed []string
			for _, d := range stayNights {
				if len(on(rule, d)) > 0 {
					closed = append(closed, d)
				}
			}
			if len(closed) > 0 {
				out = append(out, Violation{Rule: rule, Dates: closed, Message: fmt.Sprintf("Closed for sale on %s.", shortDays(closed))})
			}
		case "closed_to_arrival":
			if len(on(rule, stay.CheckIn)) > 0 {
				out = append(out, Violation{Rule: rule, Dates: []string{stay.CheckIn}, Message: fmt.Sprintf("No arrivals on %s.", ShortDay(stay.CheckIn))})
			}
		case "closed_to_departure":
			if len(on(rule, stay.CheckOut)) > 0 {
				out = append(out, Violation{Rule: rule, Dates: []string{stay.CheckOut}, Message: fmt.Sprintf("No departures on %s.", ShortDay(stay.CheckOut))})
			}
		case "min_stay":
			if n := need(on(rule, stay.CheckIn)); nights < n {
				out = append(out, Violation{Rule: rule, Dates: []string{stay.CheckIn}, Nights: &n, Message: fmt.Sprintf("Arrivals on %s stay at least %d nights; this stay has %d.", ShortDay(stay.CheckIn), n, nights)})
			}
		case "min_stay_through":
			var hits []string
			most := 0
			for _, d := range stayNights {
				if n := need(on(rule, d)); nights < n {
					hits = append(hits, d)
					most = max(most, n)
				}
			}
			if len(hits) > 0 {
				out = append(out, Violation{Rule: rule, Dates: hits, Nights: &most, Message: fmt.Sprintf("Stays over %s last at least %d nights; this stay has %d.", shortDays(hits), most, nights)})
			}
		case "max_stay":
			caps := on(rule, stay.CheckIn)
			if len(caps) == 0 {
				continue
			}
			limit := MaxRuleNights
			for i, r := range caps {
				n := MaxRuleNights
				if r.Nights != nil {
					n = *r.Nights
				}
				if i == 0 || n < limit {
					limit = n
				}
			}
			if nights > limit {
				out = append(out, Violation{Rule: rule, Dates: []string{stay.CheckIn}, Nights: &limit, Message: fmt.Sprintf("Arrivals on %s stay at most %d nights; this stay has %d.", ShortDay(stay.CheckIn), limit, nights)})
			}
		}
	}
	return out
}

// ViolationSummary is violationSummary.
func ViolationSummary(vs []Violation) string {
	msgs := make([]string, len(vs))
	for i, v := range vs {
		msgs[i] = v.Message
	}
	return strings.Join(msgs, " ")
}

// MayOverrideRestrictions is mayOverrideRestrictions: a manager, or whoever may approve bookings.
func MayOverrideRestrictions(p rbac.Permissions, role rbac.Role) bool {
	return role == "manager" || rbac.Can(p, role, "booking", "approve")
}

// UnitRestrictions is unitRestrictions: the rules set on one unit alone.
func UnitRestrictions(list []Restriction, unitID string) []Restriction {
	var out []Restriction
	for _, r := range list {
		if r.Unit() == unitID {
			out = append(out, r)
		}
	}
	return out
}

// RestrictionNote is the rules a manager sold past, or a channel stay came in against.
type RestrictionNote struct {
	Kind     string   `json:"kind"`
	Rules    []string `json:"rules"`
	Messages []string `json:"messages"`
	Reason   string   `json:"reason"`
	By       string   `json:"by"`
	On       string   `json:"on"`
}

// MergeNotes is mergeNotes: a second note adds its rules and messages and joins the reasons.
func MergeNotes(before *RestrictionNote, next RestrictionNote) RestrictionNote {
	if before == nil {
		return next
	}
	out := next
	if before.Kind == "override" || next.Kind == "override" {
		out.Kind = "override"
	} else {
		out.Kind = "channel"
	}
	out.Rules = slices.Clone(before.Rules)
	for _, r := range next.Rules {
		if !slices.Contains(out.Rules, r) {
			out.Rules = append(out.Rules, r)
		}
	}
	out.Messages = append(slices.Clone(before.Messages), next.Messages...)
	var reasons []string
	for _, r := range []string{before.Reason, next.Reason} {
		if r != "" {
			reasons = append(reasons, r)
		}
	}
	out.Reason = strings.Join(reasons, "; ")
	return out
}

// Override is RestrictionOverrideInput.
type Override struct {
	Reason string `json:"reason"`
}

// StayCheck carries what checkStay needs about the person selling.
type StayCheck struct {
	By          string
	Today       string
	MayOverride bool
	RoleLabel   string
}

// CheckStay is the mock's checkStay: no note when nothing breaks; a channel stay keeps a warning;
// a direct stay is refused unless a manager overrides with a reason. label names the stay in the
// refusal, for example "KR-01, 2026-12-21 to 2026-12-23,".
func CheckStay(list []Restriction, stay StayShape, source string, override *Override, label string, c StayCheck) (*RestrictionNote, error) {
	vs := EvaluateStay(list, stay)
	if len(vs) == 0 {
		return nil, nil
	}
	note := RestrictionNote{By: c.By, On: c.Today, Rules: []string{}, Messages: []string{}}
	for _, v := range vs {
		note.Rules = append(note.Rules, v.Rule)
		note.Messages = append(note.Messages, v.Message)
	}
	if source != Direct {
		note.Kind = "channel"
		return &note, nil
	}
	if override == nil {
		return nil, errs.Newf("RESTRICTION_VIOLATED", "%s breaks the stay restrictions: %s A villa manager can sell past them with a reason.", label, ViolationSummary(vs))
	}
	if !c.MayOverride {
		return nil, errs.Newf("RESTRICTION_OVERRIDE_FORBIDDEN", "%s cannot sell past stay restrictions. Ask a villa manager.", c.RoleLabel)
	}
	if len([]rune(Trim(override.Reason))) < 3 {
		return nil, errs.New(errs.CodeValidation, "Say why the stay sells past the restrictions.")
	}
	note.Kind, note.Reason = "override", Trim(override.Reason)
	return &note, nil
}

// RestrictionLabel is restrictionLabel.
func RestrictionLabel(rule string, nights *int) string {
	if WithNights(rule) && nights != nil {
		return fmt.Sprintf("%s %d nights", RestrictionRuleLabel[rule], *nights)
	}
	return RestrictionRuleLabel[rule]
}

// RestrictionWhen is restrictionWhen: "07-01 to 08-31 every year, Sat".
func RestrictionWhen(yearly bool, from, to string, weekdays []int) string {
	rng := fmt.Sprintf("%s to %s", from, to)
	switch {
	case yearly:
		rng += " every year"
	case from == to:
		rng = from
	}
	if len(weekdays) == 0 {
		return rng
	}
	days := slices.Clone(weekdays)
	sort.Ints(days)
	names := make([]string, len(days))
	for i, d := range days {
		names[i] = weekdayLabel[d]
	}
	return rng + ", " + strings.Join(names, " ")
}
