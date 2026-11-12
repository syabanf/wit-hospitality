// Command billing serves the billing context alone (split mode, BUS=nats). It renews sessions and
// reads the permission matrix through identity (IDENTITY_URL, INTERNAL_TOKEN), names guests through
// GUEST_URL, closes paid check-outs through RESERVATION_URL, asks finance about approvals, cash
// accounts, closed months and shift cash through FINANCE_URL, checks a cashier's roster through
// PEOPLE_URL (/internal/v1/people/rostered), and answers reservation on
// /internal/v1/billing. On start it catches up its copies of room types, units, Airbnb accounts and
// service requests from PROPERTY_URL, CHANNEL_URL and SERVICES_URL
// (/internal/v1/snapshots/{eventType}).
package main

import "github.com/syabanf/wit-hospitality/api/internal/bootstrap"

func main() { bootstrap.Serve("billing", []string{bootstrap.Billing}) }
