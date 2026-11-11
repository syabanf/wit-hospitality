// Command monolith serves every bounded context in one process on the in-process bus.
package main

import "github.com/syabanf/wit-hospitality/api/internal/bootstrap"

func main() { bootstrap.Serve("monolith", bootstrap.All) }
