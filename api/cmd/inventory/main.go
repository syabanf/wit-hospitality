// Command inventory serves the inventory context alone (split mode, BUS=nats). It renews sessions
// and reads the permission matrix through identity (IDENTITY_URL, INTERNAL_TOKEN).
package main

import "github.com/syabanf/wit-hospitality/api/internal/bootstrap"

func main() { bootstrap.Serve("inventory", []string{bootstrap.Inventory}) }
