// Package seed embeds the demo fixtures that scripts/export-seed.mjs writes from the front end's
// mock seed builders, so cmd/seed loads the same data as src/infrastructure/mock/data.
package seed

import "embed"

// FS holds identity.json, property.json, people.json and payroll.json.
//
//go:embed *.json
var FS embed.FS
