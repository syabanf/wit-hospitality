package bootstrap

import (
	"os"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/adapters/clients"
	housekeepingcommand "github.com/syabanf/wit-hospitality/api/internal/housekeeping/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/inventory"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance"
	"github.com/syabanf/wit-hospitality/api/internal/messaging/adapters/provider"
	messagingcommand "github.com/syabanf/wit-hospitality/api/internal/messaging/app/command"
)

// housekeepingClients picks housekeeping's answers. The roster comes from housekeeping's copy of
// people's events; stock items come from inventory, work orders go to maintenance and lost and
// found to guest, in process or over HTTP. Inventory and maintenance are built after
// housekeeping, so both are read at call time.
func housekeepingClients(lostFound guest.LostFound, stock func() inventory.Items, workOrders func() maintenance.WorkOrders) housekeepingcommand.Clients {
	return housekeepingcommand.Clients{
		Stock: clients.Stock{Client: stock}, WorkOrders: clients.WorkOrders{Client: workOrders},
		LostFound: clients.LostFound{Client: func() guest.LostFound { return lostFound }},
	}
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
