// Command identity serves the identity and access context alone (split mode, BUS=nats).
package main

import "github.com/syabanf/wit-hospitality/api/internal/bootstrap"

func main() { bootstrap.Serve("identity", []string{bootstrap.Identity}) }
