// Command payroll serves the payroll context alone (split mode, BUS=nats). It renews sessions and
// reads the permission matrix through the identity service (IDENTITY_URL, INTERNAL_TOKEN).
package main

import "github.com/syabanf/wit-hospitality/api/internal/bootstrap"

func main() { bootstrap.Serve("payroll", []string{bootstrap.Payroll}) }
