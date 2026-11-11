package domain

import (
	"regexp"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Asset statuses (ASSET_STATUSES).
const (
	InService   = "in_service"
	UnderRepair = "under_repair"
	Retired     = "retired"
)

// Asset is equipment in a unit, or shared by a villa when UnitID is nil.
type Asset struct {
	ID            string  `json:"id"`
	Code          string  `json:"code"`
	Name          string  `json:"name"`
	Category      string  `json:"category"`
	VillaID       string  `json:"villaId"`
	UnitID        *string `json:"unitId"`
	Brand         string  `json:"brand"`
	Model         string  `json:"model"`
	Serial        string  `json:"serial"`
	PurchasedOn   *string `json:"purchasedOn"`
	PurchaseCost  int64   `json:"purchaseCost"`
	WarrantyUntil *string `json:"warrantyUntil"`
	Status        string  `json:"status"`
	Notes         string  `json:"notes"`
	Version       int64   `json:"-"`
}

// AssetInput is AssetInput.
type AssetInput struct {
	Code          string  `json:"code"`
	Name          string  `json:"name"`
	Category      string  `json:"category"`
	VillaID       string  `json:"villaId"`
	UnitID        *string `json:"unitId"`
	Brand         string  `json:"brand"`
	Model         string  `json:"model"`
	Serial        string  `json:"serial"`
	PurchasedOn   *string `json:"purchasedOn"`
	PurchaseCost  float64 `json:"purchaseCost"`
	WarrantyUntil *string `json:"warrantyUntil"`
	Status        string  `json:"status"`
	Notes         string  `json:"notes"`
}

var assetCode = regexp.MustCompile(`^[A-Z0-9-]{3,24}$`)

// ValidateAsset is validateAsset; codeTaken says another asset already uses the code.
func ValidateAsset(in AssetInput, codeTaken bool) error {
	var f errs.Fields
	if !assetCode.MatchString(in.Code) {
		f.Add("code", "Capital letters, digits and dashes, 3 to 24 long.")
	} else if codeTaken {
		f.Add("code", in.Code+" is already used.")
	}
	if len([]rune(strings.TrimSpace(in.Name))) < 2 {
		f.Add("name", "Name the asset.")
	}
	if in.VillaID == "" {
		f.Add("villaId", "Pick the villa.")
	}
	if !slices.Contains(Categories, in.Category) {
		f.Add("category", "Pick the category.")
	}
	purchased, warranty := emptyToNil(in.PurchasedOn), emptyToNil(in.WarrantyUntil)
	if purchased != nil && !ValidDate(*purchased) {
		f.Add("purchasedOn", "Pick the date.")
	}
	if warranty != nil && !ValidDate(*warranty) {
		f.Add("warrantyUntil", "Pick the date.")
	}
	if purchased != nil && warranty != nil && *warranty < *purchased {
		if f.Has("warrantyUntil") {
			f = replace(f, "warrantyUntil", "The warranty ends before the purchase.")
		} else {
			f.Add("warrantyUntil", "The warranty ends before the purchase.")
		}
	}
	if !whole(in.PurchaseCost) || in.PurchaseCost < 0 {
		f.Add("purchaseCost", "Whole rupiah, zero or more.")
	}
	return f.Err()
}

// replace overwrites a field's message in place, as a second assignment to errors[field] does in TS.
func replace(f errs.Fields, field, message string) errs.Fields {
	for i := range f {
		if f[i].Field == field {
			f[i].Message = message
		}
	}
	return f
}

// NewAsset builds an asset from a valid form.
func NewAsset(id string, in AssetInput) Asset {
	a := Asset{ID: id}
	a.Apply(in)
	return a
}

// Apply copies the form onto the asset.
func (a *Asset) Apply(in AssetInput) {
	a.Code, a.Name, a.Category, a.VillaID, a.UnitID = in.Code, strings.TrimSpace(in.Name), in.Category, in.VillaID, emptyToNil(in.UnitID)
	a.Brand, a.Model, a.Serial, a.PurchasedOn = in.Brand, in.Model, in.Serial, emptyToNil(in.PurchasedOn)
	a.PurchaseCost, a.WarrantyUntil, a.Status, a.Notes = int64(in.PurchaseCost), emptyToNil(in.WarrantyUntil), in.Status, in.Notes
}

// Vendor is an outside contractor.
type Vendor struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Trade    string `json:"trade"`
	Contact  string `json:"contact"`
	Phone    string `json:"phone"`
	Email    string `json:"email"`
	RateNote string `json:"rateNote"`
	Active   bool   `json:"active"`
	Version  int64  `json:"-"`
}

// VendorInput is VendorInput.
type VendorInput struct {
	Name     string `json:"name"`
	Trade    string `json:"trade"`
	Contact  string `json:"contact"`
	Phone    string `json:"phone"`
	Email    string `json:"email"`
	RateNote string `json:"rateNote"`
	Active   bool   `json:"active"`
}

var (
	phone = regexp.MustCompile(`^\+?[\d\s-]{7,}$`)
	email = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)
)

// ValidateVendor is validateVendor; nameTaken says another vendor has the name, ignoring case.
func ValidateVendor(in VendorInput, nameTaken bool) error {
	var f errs.Fields
	name := strings.TrimSpace(in.Name)
	if len([]rune(name)) < 2 {
		f.Add("name", "Enter the vendor name.")
	} else if nameTaken {
		f.Add("name", name+" already exists.")
	}
	if !slices.Contains(Categories, in.Trade) {
		f.Add("trade", "Pick the trade.")
	}
	if in.Phone != "" && !phone.MatchString(in.Phone) {
		f.Add("phone", "Enter a phone number with the country code.")
	}
	if in.Email != "" && !email.MatchString(in.Email) {
		f.Add("email", "Enter a valid email address.")
	}
	return f.Err()
}

// NewVendor builds a vendor from a valid form.
func NewVendor(id string, in VendorInput) Vendor {
	v := Vendor{ID: id}
	v.Apply(in)
	return v
}

// Apply copies the form onto the vendor.
func (v *Vendor) Apply(in VendorInput) {
	v.Name, v.Trade, v.Contact, v.Phone, v.Email, v.RateNote, v.Active = strings.TrimSpace(in.Name), in.Trade, in.Contact, in.Phone, in.Email, in.RateNote, in.Active
}

// Plan is PreventivePlan: a recurring job the console opens a work order for when it falls due.
type Plan struct {
	ID            string   `json:"id"`
	Title         string   `json:"title"`
	Category      string   `json:"category"`
	VillaID       string   `json:"villaId"`
	UnitID        *string  `json:"unitId"`
	AssetID       *string  `json:"assetId"`
	Every         int      `json:"every"`
	Unit          string   `json:"unit"`
	NextDue       string   `json:"nextDue"`
	LastDoneOn    *string  `json:"lastDoneOn"`
	Checklist     []string `json:"checklist"`
	AssigneeID    *string  `json:"assigneeId"`
	VendorID      *string  `json:"vendorId"`
	EstimatedCost int64    `json:"estimatedCost"`
	Active        bool     `json:"active"`
	Version       int64    `json:"-"`
}

// PlanInput is PlanInput.
type PlanInput struct {
	Title         string   `json:"title"`
	Category      string   `json:"category"`
	VillaID       string   `json:"villaId"`
	UnitID        *string  `json:"unitId"`
	AssetID       *string  `json:"assetId"`
	Every         float64  `json:"every"`
	Unit          string   `json:"unit"`
	NextDue       string   `json:"nextDue"`
	Checklist     []string `json:"checklist"`
	AssigneeID    *string  `json:"assigneeId"`
	VendorID      *string  `json:"vendorId"`
	EstimatedCost float64  `json:"estimatedCost"`
	Active        bool     `json:"active"`
}

// ValidatePlan is validatePlan.
func ValidatePlan(in PlanInput) error {
	var f errs.Fields
	if len([]rune(strings.TrimSpace(in.Title))) < 4 {
		f.Add("title", "Name the job.")
	}
	if in.VillaID == "" {
		f.Add("villaId", "Pick the villa.")
	}
	if !slices.Contains(Categories, in.Category) {
		f.Add("category", "Pick the category.")
	}
	switch {
	case !whole(in.Every) || in.Every < 1:
		f.Add("every", "At least 1.")
	case in.Unit == "days" && in.Every > 365:
		f.Add("every", "At most 365 days; use months.")
	case in.Unit == "months" && in.Every > 24:
		f.Add("every", "At most 24 months.")
	}
	if !ValidDate(in.NextDue) {
		f.Add("nextDue", "Pick the next due date.")
	}
	if !whole(in.EstimatedCost) || in.EstimatedCost < 0 {
		f.Add("estimatedCost", "Whole rupiah, zero or more.")
	}
	for _, c := range in.Checklist {
		if len([]rune(strings.TrimSpace(c))) < 2 {
			f.Add("checklist", "Each checklist line needs text.")
			break
		}
	}
	return f.Err()
}

// NewPlan builds a plan from a valid form.
func NewPlan(id string, in PlanInput) Plan {
	p := Plan{ID: id}
	p.Apply(in)
	return p
}

// Apply copies the form onto the plan; the last done date stays.
func (p *Plan) Apply(in PlanInput) {
	checklist := make([]string, 0, len(in.Checklist))
	for _, c := range in.Checklist {
		checklist = append(checklist, strings.TrimSpace(c))
	}
	p.Title, p.Category, p.VillaID, p.UnitID, p.AssetID = strings.TrimSpace(in.Title), in.Category, in.VillaID, emptyToNil(in.UnitID), emptyToNil(in.AssetID)
	p.Every, p.Unit, p.NextDue, p.Checklist = int(in.Every), in.Unit, in.NextDue, checklist
	p.AssigneeID, p.VendorID, p.EstimatedCost, p.Active = emptyToNil(in.AssigneeID), emptyToNil(in.VendorID), int64(in.EstimatedCost), in.Active
}

// AdvanceDue is advanceDue: the next due date after a job finished on from.
func (p Plan) AdvanceDue(from string) string {
	if p.Unit == "days" {
		return AddDays(from, p.Every)
	}
	return AddMonths(from, p.Every)
}

// Finish moves the plan on after its job is done.
func (p *Plan) Finish(today string) {
	day := today
	p.LastDoneOn = &day
	p.NextDue = p.AdvanceDue(today)
}

// JobFor is the work order generateDue opens for a due plan.
func (p Plan) JobFor(today string) NewInput {
	priority := "normal"
	if p.NextDue < today {
		priority = "high"
	}
	var vendorCost float64
	if p.VendorID != nil {
		vendorCost = float64(p.EstimatedCost)
	}
	due, id := p.NextDue, p.ID
	return NewInput{
		Input: Input{
			VillaID: p.VillaID, UnitID: p.UnitID, AssetID: p.AssetID, Category: p.Category, Priority: priority, Title: p.Title,
			Description: strings.Join(p.Checklist, " · "), AssigneeID: p.AssigneeID, VendorID: p.VendorID, ScheduledOn: &due,
			Parts: []Part{}, VendorCost: vendorCost, Before: []string{}, After: []string{},
		},
		Source: "preventive", PlanID: &id,
	}
}
