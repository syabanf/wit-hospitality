// Command housekeeping serves the housekeeping context alone (split mode, BUS=nats). It renews
// sessions and reads the permission matrix through the identity service (IDENTITY_URL,
// INTERNAL_TOKEN), logs lost and found finds through the guest service (GUEST_URL) and opens work
// orders through the maintenance service (MAINTENANCE_URL).
package main

import "github.com/syabanf/wit-hospitality/api/internal/bootstrap"

func main() { bootstrap.Serve("housekeeping", []string{bootstrap.Housekeeping}) }
