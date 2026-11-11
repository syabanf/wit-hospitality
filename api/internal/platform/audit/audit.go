// Package audit appends audit trail lines in the writing transaction: who did what to which
// record, with values before and after, in the AuditEntry shape the front end reads. Each line is
// also an event (platform.audit.recorded.v1); identity projects those into the trail that
// GET /audit serves, so a context on its own database still feeds one trail.
package audit

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/ids"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
)

// EventRecorded carries one Entry.
const EventRecorded = "platform.audit.recorded.v1"

// Actions the front end knows (AuditAction).
const (
	Create  = "create"
	Update  = "update"
	Delete  = "delete"
	Status  = "status"
	Approve = "approve"
	Reject  = "reject"
	Login   = "login"
	Logout  = "logout"
	Denied  = "denied"
)

// Entry is AuditEntry.
type Entry struct {
	ID       string         `json:"id"`
	At       string         `json:"at"`
	UserID   string         `json:"userId"`
	UserName string         `json:"userName"`
	Role     string         `json:"role"`
	Action   string         `json:"action"`
	Entity   string         `json:"entity"`
	EntityID string         `json:"entityId"`
	Summary  string         `json:"summary"`
	Before   map[string]any `json:"before"`
	After    map[string]any `json:"after"`
}

// Actor is who acted.
type Actor struct {
	ID   string
	Name string
	Role string
}

// Recorder writes audit lines.
type Recorder struct {
	DB    *db.DB
	Clock clock.Clock
}

// Line describes one mutation.
type Line struct {
	Action   string
	Entity   string
	EntityID string
	Summary  string
	Before   any
	After    any
}

// Record appends the line through the transaction on ctx.
func (r Recorder) Record(ctx context.Context, actor Actor, l Line) error {
	e := Entry{
		ID: ids.Sortable("aud"), At: clock.Stamp(r.Clock), UserID: actor.ID, UserName: actor.Name, Role: actor.Role,
		Action: l.Action, Entity: l.Entity, EntityID: l.EntityID, Summary: l.Summary,
		Before: toMap(l.Before), After: toMap(l.After),
	}
	before, _ := json.Marshal(e.Before)
	after, _ := json.Marshal(e.After)
	q := r.DB.Q(ctx)
	if _, err := q.Exec(ctx, `
		INSERT INTO platform.audit_log (id, at, user_id, user_name, role, action, entity, entity_id, summary, before, after)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		e.ID, e.At, e.UserID, e.UserName, e.Role, e.Action, e.Entity, e.EntityID, e.Summary, before, after); err != nil {
		return fmt.Errorf("audit: %w", err)
	}
	return outbox.Append(ctx, q, r.Clock.Now(), outbox.Event{Type: EventRecorded, AggregateType: "audit", AggregateID: e.ID, Payload: e})
}

// toMap turns a struct or map into the JSON object the trail stores; nil stays nil.
func toMap(v any) map[string]any {
	if v == nil {
		return nil
	}
	if m, ok := v.(map[string]any); ok {
		return m
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	return m
}
