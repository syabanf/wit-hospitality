// Command billing serves the billing context alone (split mode, BUS=nats). It renews sessions and
// reads the permission matrix through identity (IDENTITY_URL, INTERNAL_TOKEN), names guests through
// GUEST_URL, closes paid check-outs through RESERVATION_URL, and answers reservation on
// /internal/v1/billing.
package main

import "github.com/syabanf/wit-hospitality/api/internal/bootstrap"

func main() { bootstrap.Serve("billing", []string{bootstrap.Billing}) }
