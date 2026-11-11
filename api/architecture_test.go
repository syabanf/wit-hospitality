package api

import (
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

const module = "github.com/syabanf/wit-hospitality/api/internal/"

// contexts are the bounded contexts under internal/; platform and bootstrap are not contexts.
func contexts(t *testing.T) map[string]bool {
	entries, err := os.ReadDir("internal")
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for _, e := range entries {
		if e.IsDir() && e.Name() != "platform" && e.Name() != "bootstrap" {
			out[e.Name()] = true
		}
	}
	return out
}

var sqlTable = regexp.MustCompile(`(?i)\b(?:FROM|JOIN|INTO|UPDATE|TRUNCATE)\s+([a-z_]+)\.[a-z_]+`)

// TestContextBoundaries enforces the rules in docs/ARCHITECTURE.md: a context imports another
// context's root package (its events) at most, never its subpackages; platform imports no
// context; domain packages import no adapters, ports or app code; SQL touches only the
// context's own schema and the shared platform schema.
func TestContextBoundaries(t *testing.T) {
	ctxs := contexts(t)
	err := filepath.WalkDir("internal", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return err
		}
		parts := strings.Split(filepath.ToSlash(path), "/")
		owner := parts[1]
		f, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		for _, imp := range f.Imports {
			p, _ := strconv.Unquote(imp.Path.Value)
			if !strings.HasPrefix(p, module) {
				continue
			}
			rest := strings.Split(strings.TrimPrefix(p, module), "/")
			target := rest[0]
			switch {
			case owner == "platform" && ctxs[target]:
				t.Errorf("%s: platform imports context %s", path, p)
			case ctxs[owner] && ctxs[target] && target != owner && len(rest) > 1:
				t.Errorf("%s: imports %s; another context is reachable only through its root package", path, p)
			case ctxs[owner] && len(parts) > 2 && parts[2] == "domain" && target == owner && len(rest) > 1 && rest[1] != "domain":
				t.Errorf("%s: domain imports %s", path, p)
			}
		}
		if ctxs[owner] {
			src, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			for _, m := range sqlTable.FindAllStringSubmatch(string(src), -1) {
				schema := strings.ToLower(m[1])
				if schema != owner && schema != "platform" {
					t.Errorf("%s: SQL touches schema %s: %q", path, schema, m[0])
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
