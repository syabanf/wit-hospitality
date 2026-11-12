// Command owners serves the owners context alone (split mode, BUS=nats). It renews sessions and
// reads the permission matrix through the identity service (IDENTITY_URL, INTERNAL_TOKEN) and
// keeps its copies of villas, units, blocks and stays from the other contexts' events. It reads a
// villa's entries, payroll and pending count for statements from the finance service
// (FINANCE_URL, /internal/v1/finance/villa-books). On start
// it catches up its copy of the booking group sources from the reservation service
// (RESERVATION_URL, /internal/v1/snapshots/{eventType}).
package main

import "github.com/syabanf/wit-hospitality/api/internal/bootstrap"

func main() { bootstrap.Serve("owners", []string{bootstrap.Owners}) }
