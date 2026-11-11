// Command files serves the files context alone (split mode): uploads to the storage FILES_STORAGE
// names. It renews sessions through the identity service (IDENTITY_URL, INTERNAL_TOKEN).
package main

import "github.com/syabanf/wit-hospitality/api/internal/bootstrap"

func main() { bootstrap.Serve("files", []string{bootstrap.Files}) }
