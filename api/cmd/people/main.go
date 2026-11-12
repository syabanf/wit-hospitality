// Command people serves the people context alone (split mode, BUS=nats). It renews sessions and
// reads the permission matrix through the identity service (IDENTITY_URL, INTERNAL_TOKEN), and
// answers billing's roster check on /internal/v1/people/rostered.
package main

import "github.com/syabanf/wit-hospitality/api/internal/bootstrap"

func main() { bootstrap.Serve("people", []string{bootstrap.People}) }
