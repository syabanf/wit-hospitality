package domain

import (
	"cmp"
	"fmt"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// ApprovalRule says who signs a cash entry before it posts.
type ApprovalRule struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Kind      string   `json:"kind"`
	VillaID   *string  `json:"villaId"`
	MinAmount int64    `json:"minAmount"`
	Levels    []string `json:"levels"`
	Active    bool     `json:"active"`
}

// ApprovalRuleInput is the rule form.
type ApprovalRuleInput struct {
	Name      string   `json:"name"`
	Kind      string   `json:"kind"`
	VillaID   *string  `json:"villaId"`
	MinAmount float64  `json:"minAmount"`
	Levels    []string `json:"levels"`
	Active    bool     `json:"active"`
}

// DefaultLevels is DEFAULT_LEVELS: without a rule one manager signs.
var DefaultLevels = []string{"manager"}

// ValidateApprovalRule is validateApprovalRule.
func ValidateApprovalRule(in ApprovalRuleInput) error {
	var f errs.Fields
	if runes(strings.TrimSpace(in.Name)) < 3 {
		f.Add("name", `Name the rule, for example "Large expenses".`)
	}
	if !whole(in.MinAmount) || in.MinAmount < 0 {
		f.Add("minAmount", "Enter the threshold in whole rupiah, zero or more.")
	}
	seen := map[string]bool{}
	dup := false
	for _, r := range in.Levels {
		dup = dup || seen[r]
		seen[r] = true
	}
	switch {
	case len(in.Levels) == 0:
		f.Add("levels", "Pick at least one approver role.")
	case slices.ContainsFunc(in.Levels, func(r string) bool { return !rbac.ValidRole(rbac.Role(r)) }):
		f.Add("levels", "Pick roles from the list.")
	case dup:
		f.Add("levels", "Each role signs once.")
	}
	return f.Err()
}

// Rule turns a checked input into the stored rule.
func (in ApprovalRuleInput) Rule(id string) ApprovalRule {
	return ApprovalRule{ID: id, Name: strings.TrimSpace(in.Name), Kind: in.Kind, VillaID: in.VillaID, MinAmount: int64(in.MinAmount), Levels: slices.Clone(in.Levels), Active: in.Active}
}

// MatchRule is matchRule: the villa rule over a portfolio rule, then the highest threshold
// reached, then a kind rule over an "all" rule.
func MatchRule(rules []ApprovalRule, kind, villaID string, amount int64) *ApprovalRule {
	var fits []ApprovalRule
	for _, r := range rules {
		if r.Active && (r.Kind == "all" || r.Kind == kind) && (r.VillaID == nil || *r.VillaID == villaID) && amount >= r.MinAmount {
			fits = append(fits, r)
		}
	}
	b2i := func(b bool) int {
		if b {
			return 1
		}
		return 0
	}
	slices.SortStableFunc(fits, func(a, b ApprovalRule) int {
		return cmp.Or(b2i(b.VillaID != nil)-b2i(a.VillaID != nil), cmp.Compare(b.MinAmount, a.MinAmount), b2i(b.Kind != "all")-b2i(a.Kind != "all"))
	})
	if len(fits) == 0 {
		return nil
	}
	return &fits[0]
}

// RequiredLevels is requiredLevels.
func RequiredLevels(rules []ApprovalRule, kind, villaID string, amount int64) []string {
	if r := MatchRule(rules, kind, villaID, amount); r != nil {
		return r.Levels
	}
	return DefaultLevels
}

// Progress is ApprovalProgress.
type Progress struct {
	Levels   []string
	Done     int
	Next     string
	Complete bool
}

// ApprovalProgress is approvalProgress.
func ApprovalProgress(levels []string, approvals []ApprovalGrant) Progress {
	done := min(len(levels), len(approvals))
	p := Progress{Levels: levels, Done: done, Complete: done >= len(levels)}
	if done < len(levels) {
		p.Next = levels[done]
	}
	return p
}

// CanSignLevel is canSignLevel: owner and administrator sign any level.
func CanSignLevel(role, level string) bool {
	return role == level || role == "owner" || role == "admin"
}

// Signer is who acts on an entry.
type Signer struct {
	ID   string
	Name string
	Role string
}

// Approvable is what the chain moves: a cash entry or a manual journal.
type Approvable struct {
	Number          string
	Status          *string
	Approvals       *[]ApprovalGrant
	History         *[]TransactionEvent
	RejectionReason **string
	CreatedByID     string
	// Noun names the record in refusals: "entry" or "journal".
	Noun string
}

// Event is a history line by the signer.
func Event(kind string, by Signer, on, note string) TransactionEvent {
	return TransactionEvent{Kind: kind, By: by.Name, Role: by.Role, On: on, Note: note}
}

// Submit sends the record to the first level; a rejected one is resubmitted.
func (a Approvable) Submit(by Signer, on, note string) {
	kind := "submitted"
	if *a.Status == Rejected {
		kind = "resubmitted"
	}
	*a.History = append(*a.History, Event(kind, by, on, note))
	*a.Approvals = []ApprovalGrant{}
	*a.RejectionReason = nil
	*a.Status = Submitted
}

// Approve signs the next level: APPROVAL_SELF for the author or a second signature, APPROVAL_ROLE
// for the wrong role.
func (a Approvable) Approve(levels []string, by Signer, on, note string) error {
	p := ApprovalProgress(levels, *a.Approvals)
	if p.Next == "" {
		return errs.Newf("TRANSACTION_INVALID_STATE", "%s already has every signature.", a.Number)
	}
	writer := "recorded an entry"
	if a.Noun == "journal" {
		writer = "wrote a journal"
	}
	if a.CreatedByID == by.ID {
		return errs.Newf("APPROVAL_SELF", "The person who %s cannot approve it.", writer)
	}
	if !CanSignLevel(by.Role, p.Next) {
		return errs.Newf("APPROVAL_ROLE", "Level %d of %d needs %s; you are %s.", p.Done+1, len(p.Levels), rbac.RoleLabel[rbac.Role(p.Next)], rbac.RoleLabel[rbac.Role(by.Role)])
	}
	if slices.ContainsFunc(*a.Approvals, func(g ApprovalGrant) bool { return g.By == by.Name }) {
		return errs.Newf("APPROVAL_SELF", "You have already signed this %s.", a.Noun)
	}
	*a.Approvals = append(*a.Approvals, ApprovalGrant{Level: p.Done + 1, Role: p.Next, By: by.Name, On: on, Note: strings.TrimSpace(note)})
	after := ApprovalProgress(p.Levels, *a.Approvals)
	signed := fmt.Sprintf("Level %d of %d", after.Done, len(after.Levels))
	if after.Complete {
		signed = "All levels signed"
		*a.Status = Approved
	}
	*a.History = append(*a.History, Event("approved", by, on, signed))
	return nil
}

// Reject sends the record back with a reason; the author withdraws instead.
func (a Approvable) Reject(by Signer, on, note string) error {
	note = strings.TrimSpace(note)
	if runes(note) < 3 {
		return errs.Newf(errs.CodeValidation, "Say why the %s is rejected.", a.Noun)
	}
	if a.CreatedByID == by.ID {
		if a.Noun == "journal" {
			return errs.New("APPROVAL_SELF", "The person who wrote a journal cannot reject it.")
		}
		return errs.New("APPROVAL_SELF", "The person who recorded an entry cannot reject it; withdraw it instead.")
	}
	*a.Status = Rejected
	*a.RejectionReason = &note
	*a.History = append(*a.History, Event("rejected", by, on, note))
	return nil
}
