// Command finance serves the finance context alone (split mode, BUS=nats). It renews sessions and
// reads the permission matrix through the identity service (IDENTITY_URL, INTERNAL_TOKEN),
// resolves receipts by id through the files service (FILES_URL), and answers the finance client
// on /internal/v1/finance.
package main

import "github.com/syabanf/wit-hospitality/api/internal/bootstrap"

func main() { bootstrap.Serve("finance", []string{bootstrap.Finance}) }
