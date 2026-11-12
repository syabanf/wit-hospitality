// Command owners serves the owners context alone (split mode, BUS=nats). It renews sessions and
// reads the permission matrix through the identity service (IDENTITY_URL, INTERNAL_TOKEN) and
// keeps its copies of villas, units, blocks and stays from the other contexts' events. On start
// it fills an empty copy of the booking group sources from the reservation service
// (RESERVATION_URL, /internal/v1/booking-groups/sources).
package main

import "github.com/syabanf/wit-hospitality/api/internal/bootstrap"

func main() { bootstrap.Serve("owners", []string{bootstrap.Owners}) }
