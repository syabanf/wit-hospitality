// Command maintenance serves the maintenance context alone (split mode, BUS=nats). It renews
// sessions and reads the permission matrix through identity (IDENTITY_URL, INTERNAL_TOKEN) and
// holds units through property's internal routes (PROPERTY_URL).
package main

import "github.com/syabanf/wit-hospitality/api/internal/bootstrap"

func main() { bootstrap.Serve("maintenance", []string{bootstrap.Maintenance}) }
