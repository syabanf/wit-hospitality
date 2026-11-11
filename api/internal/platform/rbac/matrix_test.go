package rbac

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// The snapshot comes from scripts/export-permissions.mjs, which reads DEFAULT_PERMISSIONS out of
// src/domain/access.ts. Regenerate it after changing the TypeScript matrix, then port the change.
type snapshot struct {
	Roles        []Role            `json:"roles"`
	Modules      []Module          `json:"modules"`
	Actions      []Action          `json:"actions"`
	RoleLabels   map[Role]string   `json:"roleLabels"`
	ModuleLabels map[Module]string `json:"moduleLabels"`
	Permissions  Permissions       `json:"permissions"`
}

func loadSnapshot(t *testing.T) snapshot {
	t.Helper()
	raw, err := os.ReadFile("testdata/default_permissions.json")
	if err != nil {
		t.Fatalf("read snapshot: %v (run node api/scripts/export-permissions.mjs)", err)
	}
	var s snapshot
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestMatrixMatchesTypeScriptSnapshot(t *testing.T) {
	s := loadSnapshot(t)
	if !reflect.DeepEqual(s.Roles, Roles) || !reflect.DeepEqual(s.Modules, Modules) || !reflect.DeepEqual(s.Actions, Actions) {
		t.Fatalf("role, module or action lists differ from access.ts")
	}
	if !reflect.DeepEqual(s.RoleLabels, RoleLabel) || !reflect.DeepEqual(s.ModuleLabels, ModuleLabel) {
		t.Fatalf("labels differ from access.ts")
	}
	got := DefaultPermissions()
	for _, r := range Roles {
		for _, m := range Modules {
			want := s.Permissions[r][m]
			if want == nil {
				want = []Action{}
			}
			if !reflect.DeepEqual(got[r][m], want) {
				t.Errorf("%s/%s: Go %v, TypeScript %v", r, m, got[r][m], want)
			}
		}
	}
}

func TestVillaOwnerSeesThePortalOnly(t *testing.T) {
	p := DefaultPermissions()
	if !reflect.DeepEqual(p["investor"]["portal"], []Action{"view", "create"}) {
		t.Fatalf("investor portal = %v", p["investor"]["portal"])
	}
	if !PortalOnly(p, "investor") || PortalOnly(p, "owner") {
		t.Fatal("PortalOnly is wrong")
	}
	cases := []struct {
		role   Role
		module Module
		action Action
		want   bool
	}{
		{"investor", "finance", "view", false},
		{"finance", "finance", "post", true},
		{"owner", "finance", "approve", true},
		{"manager", "finance", "post", false},
		{"manager", "master", "create", false},
		{"admin", "master", "create", true},
		{"manager", "property", "edit", true},
		{"staff", "property", "edit", false},
		{"manager", "services", "comp", true},
		{"manager", "booking", "comp", false},
	}
	for _, c := range cases {
		if got := Can(p, c.role, c.module, c.action); got != c.want {
			t.Errorf("Can(%s, %s, %s) = %v", c.role, c.module, c.action, got)
		}
	}
}

func TestScope(t *testing.T) {
	hendra := Scope{VillaIDs: []string{"vil-karang", "vil-pandawa"}}
	if !hendra.AllowedVilla("vil-karang", "loc-uluwatu") || hendra.AllowedVilla("vil-saka", "loc-canggu") {
		t.Fatal("villa scope is wrong")
	}
	putu := Scope{LocationIDs: []string{"loc-ubud"}}
	if !putu.AllowedVilla("vil-tirta", "loc-ubud") || putu.AllowedVilla("vil-saka", "loc-canggu") {
		t.Fatal("location scope is wrong")
	}
	if !(Scope{}).AllowedVilla("any", "any") || (Scope{}).Restricted() {
		t.Fatal("empty scope must allow everything")
	}
}
