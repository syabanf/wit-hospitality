// Command guest serves the guest context alone (split mode, BUS=nats). It renews sessions and
// reads the permission matrix through the identity service (IDENTITY_URL, INTERNAL_TOKEN), and
// serves the guest client's /internal/v1 routes to the other services.
package main

import "github.com/syabanf/wit-hospitality/api/internal/bootstrap"

func main() { bootstrap.Serve("guest", []string{bootstrap.Guest}) }
