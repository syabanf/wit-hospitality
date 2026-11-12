// Command inventory serves the inventory context alone (split mode, BUS=nats). It renews sessions
// and reads the permission matrix through identity (IDENTITY_URL, INTERNAL_TOKEN), and serves its
// stock item list to housekeeping on /internal/v1/stock/items.
package main

import "github.com/syabanf/wit-hospitality/api/internal/bootstrap"

func main() { bootstrap.Serve("inventory", []string{bootstrap.Inventory}) }
