// Command services serves the services context alone (split mode, BUS=nats). It renews sessions
// and reads the permission matrix through the identity service (IDENTITY_URL, INTERNAL_TOKEN),
// reads stays from the reservation service (RESERVATION_URL) and guest names from the guest
// service (GUEST_URL), and serves the site menu to channel on /internal/v1/site-menu.
package main

import "github.com/syabanf/wit-hospitality/api/internal/bootstrap"

func main() { bootstrap.Serve("services", []string{bootstrap.Services}) }
