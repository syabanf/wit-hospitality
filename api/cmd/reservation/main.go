// Command reservation serves the reservation context alone (split mode, BUS=nats). It renews
// sessions and reads the permission matrix through the identity service (IDENTITY_URL,
// INTERNAL_TOKEN), and answers property's stays questions on /internal/v1/stays.
package main

import "github.com/syabanf/wit-hospitality/api/internal/bootstrap"

func main() { bootstrap.Serve("reservation", []string{bootstrap.Reservation}) }
