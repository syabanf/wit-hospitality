package bootstrap

import (
	"fmt"
	"os"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/adapters/clients"
	housekeepingpg "github.com/syabanf/wit-hospitality/api/internal/housekeeping/adapters/postgres"
	housekeepingcommand "github.com/syabanf/wit-hospitality/api/internal/housekeeping/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance"
	"github.com/syabanf/wit-hospitality/api/internal/messaging/adapters/provider"
	messagingcommand "github.com/syabanf/wit-hospitality/api/internal/messaging/app/command"
	"github.com/syabanf/wit-hospitality/api/seed"
)

// housekeepingClients picks housekeeping's answers. The roster comes from housekeeping's copy of
// people's events; the stock items come from the demo seed (clients.SeedStock), since inventory
// serves no item lookup to other contexts; work orders go to maintenance and lost and found to
// guest, in process or over HTTP.
func housekeepingClients(lostFound guest.LostFound, workOrders func() maintenance.WorkOrders) (housekeepingcommand.Clients, error) {
	raw, err := seed.FS.ReadFile("housekeeping.json")
	if err != nil {
		return housekeepingcommand.Clients{}, err
	}
	data, err := housekeepingpg.ParseSeed(raw)
	if err != nil {
		return housekeepingcommand.Clients{}, fmt.Errorf("housekeeping.json: %w", err)
	}
	return housekeepingcommand.Clients{
		Stock: clients.SeedStock(data.Items), WorkOrders: clients.WorkOrders{Client: workOrders},
		LostFound: clients.LostFound{Client: func() guest.LostFound { return lostFound }},
	}, nil
}

// messagingProvider is the simulated provider unless MESSAGING_PROVIDER=live, which sends WhatsApp
// through Fonnte (FONNTE_TOKEN) and email over SMTP (SMTP_HOST, SMTP_PORT, SMTP_USER,
// SMTP_PASSWORD, SMTP_FROM). A channel without its settings fails its messages with a reason.
func messagingProvider() messagingcommand.Provider {
	if os.Getenv("MESSAGING_PROVIDER") != "live" {
		return provider.Simulated{}
	}
	var live provider.Live
	if token := os.Getenv("FONNTE_TOKEN"); token != "" {
		live.WhatsApp = provider.Fonnte{Token: token}
	}
	if host := os.Getenv("SMTP_HOST"); host != "" {
		port := os.Getenv("SMTP_PORT")
		if port == "" {
			port = "587"
		}
		live.Email = provider.SMTP{Host: host, Port: port, User: os.Getenv("SMTP_USER"), Password: os.Getenv("SMTP_PASSWORD"), From: os.Getenv("SMTP_FROM")}
	}
	return live
}
