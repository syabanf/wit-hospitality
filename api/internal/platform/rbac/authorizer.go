package rbac

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Source returns the current matrix. Identity owns it; other contexts read it through a Source:
// in process in the monolith, over HTTP with a short cache in split mode.
type Source interface {
	Permissions(ctx context.Context) (Permissions, error)
}

// Static serves a fixed matrix; tests use it.
type Static Permissions

// Permissions returns the matrix.
func (s Static) Permissions(context.Context) (Permissions, error) { return Permissions(s), nil }

// Need is one module and action.
type Need struct {
	Module Module
	Action Action
}

// Authorizer refuses with FORBIDDEN and the front end's wording.
type Authorizer struct{ Source Source }

// Require passes when role holds at least one of needs; the refusal names the first one.
func (a Authorizer) Require(ctx context.Context, role Role, needs ...Need) error {
	p, err := a.Source.Permissions(ctx)
	if err != nil {
		return fmt.Errorf("load permissions: %w", err)
	}
	for _, n := range needs {
		if Can(p, role, n.Module, n.Action) {
			return nil
		}
	}
	first := needs[0]
	return errs.Forbidden(fmt.Sprintf("%s cannot %s in %s.", RoleLabel[role], first.Action, ModuleLabel[first.Module]))
}

// Cached keeps a Source's answer for TTL. Split services wrap the HTTP source with it.
type Cached struct {
	Src Source
	TTL time.Duration
	mu  sync.Mutex
	at  time.Time
	val Permissions
}

// Permissions returns the cached matrix, refreshing it after TTL.
func (c *Cached) Permissions(ctx context.Context) (Permissions, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.val != nil && time.Since(c.at) < c.TTL {
		return c.val, nil
	}
	p, err := c.Src.Permissions(ctx)
	if err != nil {
		if c.val != nil {
			return c.val, nil
		}
		return nil, err
	}
	c.val, c.at = p, time.Now()
	return p, nil
}

// HTTPSource reads the matrix from the identity service's internal endpoint.
type HTTPSource struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

// Permissions calls GET {BaseURL}/internal/v1/permissions.
func (h HTTPSource) Permissions(ctx context.Context) (Permissions, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.BaseURL+"/internal/v1/permissions", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Internal-Token", h.Token)
	client := h.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("identity permissions: %s", res.Status)
	}
	var body struct {
		Data Permissions `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return nil, err
	}
	return body.Data, nil
}
