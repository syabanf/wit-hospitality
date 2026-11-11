// Package domain holds the services context's rules, ported from src/domain/serviceOrder.ts and
// roomService.ts with the same codes and wording: the menu and its partners, orders and their
// money, the QR card token, and service requests. It is pure.
package domain

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// MenuCategories is MENU_CATEGORIES.
var MenuCategories = []string{"breakfast", "food", "minibar", "laundry", "transport", "spa", "tours", "extras", "housekeeping"}

// RevenueCategory is REVENUE_CATEGORY: the income category each kind of service posts to.
var RevenueCategory = map[string]string{
	"breakfast": "cat-svc-fnb", "food": "cat-svc-fnb", "minibar": "cat-svc-fnb", "laundry": "cat-svc-laundry",
	"transport": "cat-svc-transport", "spa": "cat-svc-spa", "tours": "cat-svc-tours", "extras": "cat-svc-other", "housekeeping": "cat-svc-other",
}

// CategoryCode is MENU_CATEGORY_CODE: the folio transaction code of each kind of service.
var CategoryCode = map[string]string{
	"breakfast": "FNB", "food": "FNB", "minibar": "MINI", "laundry": "LDRY", "transport": "TRNS",
	"spa": "SPA", "tours": "TOUR", "extras": "XTRA", "housekeeping": "XTRA",
}

// PriceUnits is PRICE_UNITS.
var PriceUnits = []string{"item", "kg", "trip", "person", "hour"}

// PartnerKinds is PARTNER_KINDS.
var PartnerKinds = []string{"spa", "tours", "transport", "laundry", "food"}

// ServicePartner is an outside business that delivers part of the menu and bills the villa.
type ServicePartner struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Contact string `json:"contact"`
	Phone   string `json:"phone"`
	Active  bool   `json:"active"`
	Version int64  `json:"-"`
}

// PartnerInput is PartnerInput.
type PartnerInput struct {
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Contact string `json:"contact"`
	Phone   string `json:"phone"`
	Active  bool   `json:"active"`
}

var phonePattern = regexp.MustCompile(`^\+?[\d\s-]{7,}$`)

// ValidatePartner is validatePartner.
func ValidatePartner(in PartnerInput) error {
	var f errs.Fields
	if len([]rune(strings.TrimSpace(in.Name))) < 2 {
		f.Add("name", "Enter the partner’s name.")
	}
	if !slices.Contains(PartnerKinds, in.Kind) {
		f.Add("kind", "Pick what they provide.")
	}
	if in.Phone != "" && !phonePattern.MatchString(in.Phone) {
		f.Add("phone", "Enter a phone number with the country code.")
	}
	return f.Err()
}

// MenuItem is one thing the villa sells to a staying guest.
type MenuItem struct {
	ID          string          `json:"id"`
	VillaID     string          `json:"villaId"`
	Category    string          `json:"category"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Photo       json.RawMessage `json:"photo"`
	Price       int64           `json:"price"`
	Unit        string          `json:"unit"`
	// AvailableFrom and AvailableTo are minutes since midnight; a window that ends before it
	// starts runs past midnight.
	AvailableFrom int     `json:"availableFrom"`
	AvailableTo   int     `json:"availableTo"`
	LeadMinutes   int     `json:"leadMinutes"`
	Active        bool    `json:"active"`
	PartnerID     *string `json:"partnerId"`
	CostPrice     int64   `json:"costPrice"`
	Version       int64   `json:"-"`
}

// MenuItemInput is MenuItemInput. Numbers arrive as JSON numbers, so the validator can refuse a
// fraction the way Number.isInteger does.
type MenuItemInput struct {
	VillaID       string          `json:"villaId"`
	Category      string          `json:"category"`
	Name          string          `json:"name"`
	Description   string          `json:"description"`
	Photo         json.RawMessage `json:"photo"`
	Price         float64         `json:"price"`
	Unit          string          `json:"unit"`
	AvailableFrom float64         `json:"availableFrom"`
	AvailableTo   float64         `json:"availableTo"`
	LeadMinutes   float64         `json:"leadMinutes"`
	Active        bool            `json:"active"`
	PartnerID     *string         `json:"partnerId"`
	CostPrice     float64         `json:"costPrice"`
}

func isInt(v float64) bool { return v == math.Trunc(v) && !math.IsInf(v, 0) }

// ValidateMenuItem is validateMenuItem.
func ValidateMenuItem(in MenuItemInput) error {
	var f errs.Fields
	minutes := func(m float64) bool { return isInt(m) && m >= 0 && m <= 24*60 }
	if in.VillaID == "" {
		f.Add("villaId", "Pick the villa.")
	}
	if !slices.Contains(MenuCategories, in.Category) {
		f.Add("category", "Pick the category.")
	}
	if len([]rune(strings.TrimSpace(in.Name))) < 2 {
		f.Add("name", "Enter the item name.")
	}
	if !isInt(in.Price) || in.Price < 0 {
		f.Add("price", "Enter the price in whole rupiah, or zero.")
	}
	if !slices.Contains(PriceUnits, in.Unit) {
		f.Add("unit", "Pick how it is priced.")
	}
	if !minutes(in.AvailableFrom) {
		f.Add("availableFrom", "A time of day.")
	}
	if !minutes(in.AvailableTo) {
		f.Add("availableTo", "A time of day.")
	}
	if !isInt(in.LeadMinutes) || in.LeadMinutes < 0 || in.LeadMinutes > 7*24*60 {
		f.Add("leadMinutes", "Notice in minutes, up to a week.")
	}
	if !isInt(in.CostPrice) || in.CostPrice < 0 {
		f.Add("costPrice", "Enter the cost in whole rupiah, or zero.")
	} else if in.CostPrice > 0 && (in.PartnerID == nil || *in.PartnerID == "") {
		f.Add("partnerId", "Pick the partner who bills that cost.")
	}
	return f.Err()
}

// Apply copies a validated input onto the item, trimming the texts as the mock does.
func (m *MenuItem) Apply(in MenuItemInput) {
	m.VillaID, m.Category, m.Unit, m.Active = in.VillaID, in.Category, in.Unit, in.Active
	m.Name, m.Description = strings.TrimSpace(in.Name), strings.TrimSpace(in.Description)
	m.Photo = in.Photo
	if len(m.Photo) == 0 {
		m.Photo = json.RawMessage("null")
	}
	m.Price, m.CostPrice = int64(in.Price), int64(in.CostPrice)
	m.AvailableFrom, m.AvailableTo, m.LeadMinutes = int(in.AvailableFrom), int(in.AvailableTo), int(in.LeadMinutes)
	m.PartnerID = in.PartnerID
	if m.PartnerID != nil && *m.PartnerID == "" {
		m.PartnerID = nil
	}
}

// AvailableAt is availableAt: whether the item is served at that minute of the day.
func AvailableAt(from, to, minute int) bool {
	if from <= to {
		return minute >= from && minute <= to
	}
	return minute >= from || minute <= to
}

// ClockLabel is clockLabel: 450 reads 07:30.
func ClockLabel(minutes int) string { return fmt.Sprintf("%02d:%02d", minutes/60, minutes%60) }

// HoursLabel is hoursLabel.
func HoursLabel(from, to int) string {
	if from == 0 && to >= 24*60-1 {
		return "Any time"
	}
	return ClockLabel(from) + " to " + ClockLabel(to%(24*60))
}

// LeadLabel is leadLabel.
func LeadLabel(minutes int) string {
	switch {
	case minutes == 0:
		return "No notice"
	case minutes < 60:
		return fmt.Sprintf("%d min notice", minutes)
	case minutes%60 == 0:
		return fmt.Sprintf("%d h notice", minutes/60)
	default:
		return fmt.Sprintf("%d h %d min notice", minutes/60, minutes%60)
	}
}
