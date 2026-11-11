// Command messaging serves the messaging context alone (split mode, BUS=nats). It renews sessions
// and reads the permission matrix through the identity service (IDENTITY_URL, INTERNAL_TOKEN).
package main

import "github.com/syabanf/wit-hospitality/api/internal/bootstrap"

func main() { bootstrap.Serve("messaging", []string{bootstrap.Messaging}) }
