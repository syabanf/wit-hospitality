package domain

import (
	"fmt"
	"math"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/people"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// The employee area's rules ported from src/domain/selfService.ts: the clock, the leave balance
// per kind and shift swaps, with the same codes and messages.

// More published records.
type (
	ClockStamp         = people.ClockStamp
	ShiftSwap          = people.ShiftSwap
	AttendanceSettings = people.AttendanceSettings
)

// DefaultAttendanceSettings is DEFAULT_ATTENDANCE_SETTINGS.
var DefaultAttendanceSettings = AttendanceSettings{RadiusMeters: 200}

// ValidateAttendanceSettings is validateAttendanceSettings.
func ValidateAttendanceSettings(s AttendanceSettings) error {
	if s.RadiusMeters < 20 || s.RadiusMeters > 5000 {
		return errs.Invalid("radiusMeters", "The radius is 20 to 5000 whole metres.")
	}
	return nil
}

// GeoPoint is a browser position.
type GeoPoint struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

func validGeo(g *GeoPoint) bool {
	return g != nil && !math.IsNaN(g.Lat) && !math.IsNaN(g.Lng) && math.Abs(g.Lat) <= 90 && math.Abs(g.Lng) <= 180
}

// DistanceMeters is distanceMeters: metres on the haversine great circle, rounded.
func DistanceMeters(a, b GeoPoint) int {
	rad := func(deg float64) float64 { return deg * math.Pi / 180 }
	h := math.Pow(math.Sin(rad(b.Lat-a.Lat)/2), 2) + math.Cos(rad(a.Lat))*math.Cos(rad(b.Lat))*math.Pow(math.Sin(rad(b.Lng-a.Lng)/2), 2)
	return int(math.Round(2 * 6_371_000 * math.Asin(math.Sqrt(h))))
}

// VillaPoint is a villa's position; nil when property has none.
type VillaPoint struct {
	ID       string
	Lat, Lng *float64
}

// StampGeo is stampGeo: the position against the nearest villa; nil without a valid position.
func StampGeo(point *GeoPoint, villas []VillaPoint, radius int) *ClockStamp {
	if !validGeo(point) {
		return nil
	}
	var nearest *VillaPoint
	best := 0
	for i, v := range villas {
		if v.Lat == nil || v.Lng == nil {
			continue
		}
		d := DistanceMeters(*point, GeoPoint{*v.Lat, *v.Lng})
		if nearest == nil || d < best {
			nearest, best = &villas[i], d
		}
	}
	if nearest == nil {
		return &ClockStamp{Lat: point.Lat, Lng: point.Lng, Place: "unknown"}
	}
	place := "away"
	if best <= radius {
		place = "villa"
	}
	id := nearest.ID
	return &ClockStamp{Lat: point.Lat, Lng: point.Lng, VillaID: &id, DistanceMeters: &best, Place: place}
}

// ClockInput is the body of a clock-in; Reason is needed on a day the roster gives no shift.
type ClockInput struct {
	Reason string    `json:"reason"`
	Geo    *GeoPoint `json:"geo"`
}

func clocked(a *Attendance) bool { return a != nil && a.ClockIn != nil && *a.ClockIn != "" }
func closed(a *Attendance) bool  { return a != nil && a.ClockOut != nil && *a.ClockOut != "" }

func overnight(s *Shift) bool { return s != nil && s.End < s.Start }

// OpenClock is openClock: the row a clock-out closes, today's or last night's overnight shift.
func OpenClock(today, yesterday *Attendance, yesterdayShift *Shift) *Attendance {
	if clocked(today) && !closed(today) {
		return today
	}
	if clocked(yesterday) && !closed(yesterday) && overnight(yesterdayShift) {
		return yesterday
	}
	return nil
}

var statusLabel = map[string]string{"present": "present", "late": "late", "absent": "absent", "leave": "on leave", "off": "day off"}

// CheckClockIn is checkClockIn.
func CheckClockIn(row *Attendance, shift *Shift, onLeave bool, reason string) error {
	if clocked(row) {
		if closed(row) {
			return errs.Newf("CLOCK_ALREADY_OUT", "You already clocked out at %s.", *row.ClockOut)
		}
		return errs.Newf("CLOCK_ALREADY_IN", "You already clocked in at %s.", *row.ClockIn)
	}
	if onLeave || (row != nil && row.Status == "leave") {
		return errs.New("CLOCK_ON_LEAVE", "You are on leave today.")
	}
	if row != nil && row.Status != "off" {
		return errs.Newf("CLOCK_DAY_RECORDED", "HR recorded today as %s. Ask HR to correct it.", statusLabel[row.Status])
	}
	if shift == nil && length(reason) < 3 {
		return errs.New("CLOCK_NOT_ROSTERED", "You are not on the roster today. Say why you are clocking in.")
	}
	return nil
}

// ClockedIn is clockedIn: the row a clock-in writes, late against the shift start.
func ClockedIn(id, employeeID, date, at string, shift *Shift, reason string, geo *ClockStamp) Attendance {
	late := LateMinutes(&at, shift)
	status := "present"
	if late > 0 {
		status = "late"
	}
	return Attendance{ID: id, EmployeeID: employeeID, Date: date, Status: status, ClockIn: &at, LateMinutes: late, Note: strings.TrimSpace(reason), Source: "self", ClockInGeo: geo}
}

// CheckClockOut is checkClockOut.
func CheckClockOut(open, today *Attendance) error {
	if open != nil {
		return nil
	}
	if closed(today) {
		return errs.Newf("CLOCK_ALREADY_OUT", "You already clocked out at %s.", *today.ClockOut)
	}
	return errs.New("CLOCK_NOT_IN", "Clock in first.")
}

// leaveQuota is LEAVE_QUOTA: days a year per kind; -1 has no limit. Annual follows the employee.
var leaveQuota = map[string]int{"sick": 12, "permission": 6, "unpaid": -1}
var leaveNoun = map[string]string{"annual": "annual leave", "sick": "sick leave", "permission": "permission", "unpaid": "unpaid leave"}

// LeaveBalance is one kind's year: Entitlement and Left are nil without a limit.
type LeaveBalance struct {
	Kind        string `json:"kind"`
	Entitlement *int   `json:"entitlement"`
	Used        int    `json:"used"`
	Pending     int    `json:"pending"`
	Left        *int   `json:"left"`
}

// LeaveBalances is leaveBalances: approved days are used, pending days held, both off the
// entitlement; a request counts in the year it starts.
func LeaveBalances(e Employee, leaves []LeaveRequest, year string) []LeaveBalance {
	out := make([]LeaveBalance, 0, len(LeaveKinds))
	for _, kind := range LeaveKinds {
		b := LeaveBalance{Kind: kind}
		for _, l := range leaves {
			if l.EmployeeID != e.ID || l.Kind != kind || !strings.HasPrefix(l.From, year) {
				continue
			}
			switch l.Status {
			case "approved":
				b.Used += l.Days
			case "pending":
				b.Pending += l.Days
			}
		}
		quota := e.AnnualLeaveDays
		if kind != "annual" {
			quota = leaveQuota[kind]
		}
		if quota >= 0 {
			left := max(0, quota-b.Used-b.Pending)
			b.Entitlement, b.Left = &quota, &left
		}
		out = append(out, b)
	}
	return out
}

// AnnualLeaveLeft is annualLeaveLeft.
func AnnualLeaveLeft(e Employee, leaves []LeaveRequest, year string) int {
	if b := LeaveBalances(e, leaves, year); len(b) > 0 && b[0].Left != nil {
		return *b[0].Left
	}
	return 0
}

// CheckLeaveBalance is checkLeaveBalance: a request past what is left of a limited kind.
func CheckLeaveBalance(kind string, days int, balances []LeaveBalance) error {
	for _, b := range balances {
		if b.Kind != kind || b.Left == nil || days <= *b.Left {
			continue
		}
		left := *b.Left
		switch left {
		case 0:
			return errs.Newf("LEAVE_BALANCE_EXCEEDED", "No %s days are left.", leaveNoun[kind])
		case 1:
			return errs.Newf("LEAVE_BALANCE_EXCEEDED", "Only 1 %s day is left.", leaveNoun[kind])
		}
		return errs.Newf("LEAVE_BALANCE_EXCEEDED", "Only %d %s days are left.", left, leaveNoun[kind])
	}
	return nil
}

// Swap actions and where each may start.
var swapMove = map[string]struct {
	from []string
	to   string
}{
	"accept":  {[]string{"offered"}, "accepted"},
	"decline": {[]string{"offered"}, "declined"},
	"cancel":  {[]string{"offered", "accepted"}, "cancelled"},
	"approve": {[]string{"accepted"}, "approved"},
	"reject":  {[]string{"accepted"}, "rejected"},
}

// SwapActions lists the actions in route order.
var SwapActions = []string{"accept", "decline", "cancel", "approve", "reject"}

// SwapOpen is swapOpen.
func SwapOpen(s ShiftSwap) bool { return s.Status == "offered" || s.Status == "accepted" }

// SwapInput offers a swap.
type SwapInput struct {
	Date          string  `json:"date"`
	CounterpartID string  `json:"counterpartId"`
	CounterDate   *string `json:"counterDate"`
	Note          string  `json:"note"`
}

func (in SwapInput) counterDate() string {
	if in.CounterDate == nil {
		return ""
	}
	return *in.CounterDate
}

// ValidateSwap is validateSwap.
func ValidateSwap(in SwapInput, requesterID string) error {
	var f errs.Fields
	if !IsDate(in.Date) {
		set(&f, "date", "Pick the shift to hand over.")
	}
	if in.CounterpartID == "" || in.CounterpartID == requesterID {
		set(&f, "counterpartId", "Pick a coworker.")
	}
	if cd := in.counterDate(); cd != "" && !IsDate(cd) {
		set(&f, "counterDate", "Pick the shift to take in exchange.")
	}
	return f.Err()
}

// SwapWorld is what the swap rules read.
type SwapWorld struct {
	Today                  string
	Requester, Counterpart Employee
	Assignments            []ShiftAssignment
	Leaves                 []LeaveRequest
	Shifts                 []Shift
	Swaps                  []ShiftSwap
	VillaName              func(id string) string
}

func (w SwapWorld) shiftOn(employeeID, date string) *ShiftAssignment {
	for i, a := range w.Assignments {
		if a.EmployeeID == employeeID && a.Date == date && a.ShiftID != nil && *a.ShiftID != "" {
			return &w.Assignments[i]
		}
	}
	return nil
}

func (w SwapWorld) onLeave(employeeID, date string) bool {
	for _, l := range w.Leaves {
		if l.EmployeeID == employeeID && l.Status == "approved" && l.From <= date && date <= l.To {
			return true
		}
	}
	return false
}

func (w SwapWorld) shiftName(a *ShiftAssignment) string {
	for _, s := range w.Shifts {
		if a.ShiftID != nil && s.ID == *a.ShiftID {
			return s.Name
		}
	}
	return "a shift"
}

// CheckSwap is checkSwap: it refuses the swap against the roster as it stands and returns the
// two shifts it moves. ignoreID leaves the swap itself out of the open ones.
func CheckSwap(date string, counterDate *string, w SwapWorld, ignoreID string) (*ShiftAssignment, *ShiftAssignment, error) {
	cd := ""
	if counterDate != nil {
		cd = *counterDate
	}
	req, cp := w.Requester, w.Counterpart
	for _, d := range []string{date, cd} {
		if d != "" && d <= w.Today {
			return nil, nil, errs.Newf("SWAP_PAST_SHIFT", "The shift on %s has started or passed. Swap an upcoming shift.", d)
		}
	}
	mine := w.shiftOn(req.ID, date)
	if mine == nil {
		return nil, nil, errs.Newf("SWAP_NO_SHIFT", "%s has no shift on %s.", req.Name, date)
	}
	if cp.Status == "inactive" || !slices.Contains(cp.VillaIDs(), mine.VillaID) {
		return nil, nil, errs.Newf("SWAP_NOT_COWORKER", "%s does not work at %s.", cp.Name, w.VillaName(mine.VillaID))
	}
	var theirs *ShiftAssignment
	if cd != "" {
		theirs = w.shiftOn(cp.ID, cd)
		if theirs == nil {
			return nil, nil, errs.Newf("SWAP_NO_SHIFT", "%s has no shift on %s.", cp.Name, cd)
		}
		if theirs.VillaID != mine.VillaID {
			return nil, nil, errs.Newf("SWAP_NOT_COWORKER", "%s works at another villa on %s.", cp.Name, cd)
		}
		if w.onLeave(req.ID, cd) {
			return nil, nil, errs.Newf("SWAP_ON_LEAVE", "%s is on leave on %s.", req.Name, cd)
		}
	}
	if w.onLeave(cp.ID, date) {
		return nil, nil, errs.Newf("SWAP_ON_LEAVE", "%s is on leave on %s.", cp.Name, date)
	}
	if cd != date {
		if taken := w.shiftOn(cp.ID, date); taken != nil {
			return nil, nil, errs.Newf("SWAP_DOUBLE_SHIFT", "%s already works %s on %s.", cp.Name, w.shiftName(taken), date)
		}
		if cd != "" {
			if own := w.shiftOn(req.ID, cd); own != nil {
				return nil, nil, errs.Newf("SWAP_DOUBLE_SHIFT", "%s already works %s on %s.", req.Name, w.shiftName(own), cd)
			}
		}
	}
	touches := func(s ShiftSwap, employeeID, d string) bool {
		return d != "" && ((s.RequesterID == employeeID && s.Date == d) || (s.CounterpartID == employeeID && s.CounterDate != nil && *s.CounterDate == d))
	}
	for _, s := range w.Swaps {
		if s.ID != ignoreID && SwapOpen(s) && (touches(s, req.ID, date) || touches(s, cp.ID, cd)) {
			return nil, nil, errs.Newf("SWAP_OPEN_EXISTS", "%s is already open on that shift.", s.Number)
		}
	}
	return mine, theirs, nil
}

// SwapAssignments is swapAssignments: the roster cells an approved swap writes.
func SwapAssignments(s ShiftSwap, mine, theirs *ShiftAssignment) []AssignmentInput {
	cell := func(employeeID, date string, shiftID *string) AssignmentInput {
		return AssignmentInput{EmployeeID: employeeID, Date: date, ShiftID: shiftID, VillaID: mine.VillaID}
	}
	if theirs == nil || s.CounterDate == nil {
		return []AssignmentInput{cell(s.RequesterID, s.Date, nil), cell(s.CounterpartID, s.Date, mine.ShiftID)}
	}
	if *s.CounterDate == s.Date {
		return []AssignmentInput{cell(s.RequesterID, s.Date, theirs.ShiftID), cell(s.CounterpartID, s.Date, mine.ShiftID)}
	}
	return []AssignmentInput{cell(s.RequesterID, s.Date, nil), cell(s.CounterpartID, s.Date, mine.ShiftID), cell(s.CounterpartID, *s.CounterDate, nil), cell(s.RequesterID, *s.CounterDate, theirs.ShiftID)}
}

// MoveSwap is moveSwap without the approve permission check, which the command makes with the
// authorizer: the coworker answers, the requester cancels, an approval needs an accepted swap.
func MoveSwap(s ShiftSwap, action, employeeID, note string) (string, error) {
	move, ok := swapMove[action]
	if !ok {
		return "", errs.Invalid("action", "Pick accept, decline, cancel, approve or reject.")
	}
	switch action {
	case "approve", "reject":
		if s.Status == "offered" {
			return "", errs.Newf("SWAP_NOT_ACCEPTED", "%s waits for %s to accept.", s.Number, s.CounterpartName)
		}
	case "cancel":
		if employeeID != s.RequesterID {
			return "", errs.Forbidden(fmt.Sprintf("Only %s can cancel %s.", s.RequesterName, s.Number))
		}
	default:
		if employeeID != s.CounterpartID {
			return "", errs.Forbidden(fmt.Sprintf("Only %s can answer %s.", s.CounterpartName, s.Number))
		}
	}
	if !slices.Contains(move.from, s.Status) {
		return "", errs.Newf("SWAP_INVALID_STATE", "%s is %s; it can no longer change.", s.Number, s.Status)
	}
	if action == "reject" && length(note) < 3 {
		return "", errs.New(errs.CodeValidation, "Say why.")
	}
	return move.to, nil
}

// TeamDays is TEAM_DAYS: how far ahead the team roster reaches, today included.
const TeamDays = 14

// TeamMember is a coworker as the team page shows them: name, position and the coming roster.
type TeamMember struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Position    string            `json:"position"`
	VillaIDs    []string          `json:"villaIds"`
	Assignments []ShiftAssignment `json:"assignments"`
}
