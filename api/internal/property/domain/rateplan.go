package domain

import (
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Season kinds.
const (
	SeasonFixed     = "fixed"
	SeasonSurcharge = "surcharge"
)

// Season comes back every year. From and To are MM-DD, both included; a season may run over the
// new year (12-20 to 01-05). Value is rupiah a night (fixed) or percent over the base (surcharge).
type Season struct {
	Name  string `json:"name"`
	From  string `json:"from"`
	To    string `json:"to"`
	Kind  string `json:"kind"`
	Value int64  `json:"value"`
}

// RatePlan prices a room type's nights when a unit has no live Airbnb listing.
type RatePlan struct {
	GroupID     string   `json:"groupId"`
	WeekdayRate int64    `json:"weekdayRate"`
	WeekendRate int64    `json:"weekendRate"`
	Seasons     []Season `json:"seasons"`
	Version     int64    `json:"-"`
}

// SeasonInput is a season from the form, numbers unchecked.
type SeasonInput struct {
	Name  string  `json:"name"`
	From  string  `json:"from"`
	To    string  `json:"to"`
	Kind  string  `json:"kind"`
	Value float64 `json:"value"`
}

// RatePlanInput is RatePlanInput.
type RatePlanInput struct {
	WeekdayRate float64       `json:"weekdayRate"`
	WeekendRate float64       `json:"weekendRate"`
	Seasons     []SeasonInput `json:"seasons"`
}

var monthDayPattern = regexp.MustCompile(`^\d{2}-\d{2}$`)
var monthDays = []int{31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}

// ValidMonthDay is validMonthDay: an MM-DD that exists in a leap year.
func ValidMonthDay(md string) bool {
	if !monthDayPattern.MatchString(md) {
		return false
	}
	var month, day int
	_, _ = fmt.Sscanf(md, "%d-%d", &month, &day)
	return month >= 1 && month <= 12 && day >= 1 && day <= monthDays[month-1]
}

// rateFields is validateRatePlan; prefix is "" or "plans.g0." for the wizard.
func rateFields(in RatePlanInput, prefix string, f *errs.Fields) {
	if !whole(in.WeekdayRate) || in.WeekdayRate <= 0 {
		f.Add(prefix+"weekdayRate", "Enter the weekday rate in whole rupiah.")
	}
	if !whole(in.WeekendRate) || in.WeekendRate <= 0 {
		f.Add(prefix+"weekendRate", "Enter the weekend rate in whole rupiah.")
	}
	for i, s := range in.Seasons {
		key := fmt.Sprintf("%sseasons.%d.", prefix, i)
		if utf8.RuneCountInString(strings.TrimSpace(s.Name)) < 2 {
			f.Add(key+"name", "Name the season.")
		}
		if !ValidMonthDay(s.From) {
			f.Add(key+"from", "Pick the first night.")
		}
		if !ValidMonthDay(s.To) {
			f.Add(key+"to", "Pick the last night.")
		}
		if s.Kind == SeasonFixed && (!whole(s.Value) || s.Value <= 0) {
			f.Add(key+"value", "Enter the nightly price in whole rupiah.")
		}
		if s.Kind == SeasonSurcharge && (!whole(s.Value) || s.Value <= 0 || s.Value > 300) {
			f.Add(key+"value", "A whole percentage above 0, up to 300.")
		}
		if s.Kind != SeasonFixed && s.Kind != SeasonSurcharge {
			f.Add(key+"kind", "Pick fixed price or surcharge.")
		}
	}
}

// RatePlanErrors returns validateRatePlan's field map, for tests that compare with TypeScript.
func RatePlanErrors(in RatePlanInput) map[string]string {
	var f errs.Fields
	rateFields(in, "", &f)
	return f.Map()
}

// ValidateRatePlan is validateRatePlan.
func ValidateRatePlan(in RatePlanInput) error {
	var f errs.Fields
	rateFields(in, "", &f)
	return f.Err()
}

// Plan turns a valid form into the room type's plan, trimming season names.
func (in RatePlanInput) Plan(groupID string) RatePlan {
	p := RatePlan{GroupID: groupID, WeekdayRate: int64(in.WeekdayRate), WeekendRate: int64(in.WeekendRate), Seasons: []Season{}}
	for _, s := range in.Seasons {
		p.Seasons = append(p.Seasons, Season{Name: strings.TrimSpace(s.Name), From: s.From, To: s.To, Kind: s.Kind, Value: int64(s.Value)})
	}
	return p
}

// DefaultRatePlan is defaultRatePlan: the base price on weekdays, about 20% more on weekends
// rounded to Rp 10,000, never below the base.
func DefaultRatePlan(base float64) RatePlanInput {
	weekend := math.Max(base, math.Round(base*1.2/10_000)*10_000)
	return RatePlanInput{WeekdayRate: base, WeekendRate: weekend, Seasons: []SeasonInput{}}
}

// seasonLength counts the nights a season covers, on a leap year so 02-29 fits.
func seasonLength(s Season) int {
	from, _ := time.Parse("2006-01-02", "2024-"+s.From)
	to, _ := time.Parse("2006-01-02", "2024-"+s.To)
	span := int(to.Sub(from).Hours() / 24)
	if span < 0 {
		span += 366
	}
	return span + 1
}

// InYearlyRange is inYearlyRange: MM-DD bounds, both included, possibly over the new year.
func InYearlyRange(from, to, date string) bool {
	md := date[5:]
	if from <= to {
		return md >= from && md <= to
	}
	return md >= from || md <= to
}

// SeasonOn is seasonOn: the narrower season wins, and on equal length the one listed last.
func SeasonOn(seasons []Season, date string) *Season {
	var found *Season
	for i := range seasons {
		s := &seasons[i]
		if InYearlyRange(s.From, s.To, date) && (found == nil || seasonLength(*s) <= seasonLength(*found)) {
			found = s
		}
	}
	return found
}

// IsWeekendNight is true on Friday and Saturday nights.
func IsWeekendNight(date string) bool {
	t, err := time.Parse("2006-01-02", date)
	if err != nil {
		return false
	}
	return t.Weekday() == time.Friday || t.Weekday() == time.Saturday
}

// NightPrice is what the plan charges for one night and the name of the rate that set it.
type NightPrice struct {
	Rate int64  `json:"rate"`
	Name string `json:"name"`
}

// PlanNight is planNight.
func PlanNight(p RatePlan, date string) NightPrice {
	weekend := IsWeekendNight(date)
	base := p.WeekdayRate
	name := "Weekday"
	if weekend {
		base, name = p.WeekendRate, "Weekend"
	}
	s := SeasonOn(p.Seasons, date)
	if s == nil {
		return NightPrice{Rate: base, Name: name}
	}
	if s.Kind == SeasonFixed {
		return NightPrice{Rate: s.Value, Name: s.Name}
	}
	return NightPrice{Rate: int64(math.Round(float64(base) * float64(100+s.Value) / 100)), Name: s.Name}
}
