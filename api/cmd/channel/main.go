// Command channel serves the channel context alone (split mode, BUS=nats): Airbnb accounts and
// listings, the public site and web enquiries. It renews sessions and reads the permission matrix
// through the identity service (IDENTITY_URL, INTERNAL_TOKEN), reads bookings, held nights and
// stay restrictions from the reservation service (RESERVATION_URL, /internal/v1/site), and reads
// the site's room service menu from the services service (SERVICES_URL).
package main

import "github.com/syabanf/wit-hospitality/api/internal/bootstrap"

func main() { bootstrap.Serve("channel", []string{bootstrap.Channel}) }
