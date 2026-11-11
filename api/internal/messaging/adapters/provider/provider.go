// Package provider holds messaging's gateways: the simulated provider the demo runs on, which
// takes a message from queued to sent after a second and to delivered after five as the mock does,
// and the live one, which sends WhatsApp through Fonnte and email over SMTP.
package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/smtp"
	"net/url"
	"strings"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/messaging/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/messaging/domain"
)

// Simulated queues every message with an address and lets time move it on.
type Simulated struct{}

// Send accepts the message as queued.
func (Simulated) Send(context.Context, domain.Message) (command.Receipt, error) {
	return command.Receipt{Status: domain.Queued}, nil
}

// Track is providerStatus.
func (Simulated) Track(m domain.Message, now string) string {
	return domain.ProviderStatus(m.Status, m.QueuedAt, now)
}

// Fonnte sends WhatsApp messages through api.fonnte.com with the device token.
type Fonnte struct {
	Token  string
	URL    string
	Client *http.Client
}

// Send posts the message; a refusal from the gateway fails it with the gateway's reason.
func (f Fonnte) Send(ctx context.Context, m domain.Message) (command.Receipt, error) {
	endpoint := f.URL
	if endpoint == "" {
		endpoint = "https://api.fonnte.com/send"
	}
	form := url.Values{"target": {m.To}, "message": {m.Body}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return command.Receipt{}, err
	}
	req.Header.Set("Authorization", f.Token)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := f.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return command.Receipt{Status: domain.Failed, Error: "WhatsApp gateway unreachable"}, nil
	}
	defer res.Body.Close()
	var out struct {
		Status bool   `json:"status"`
		Reason string `json:"reason"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil || res.StatusCode >= 300 || !out.Status {
		reason := out.Reason
		if reason == "" {
			reason = fmt.Sprintf("WhatsApp gateway answered %s", res.Status)
		}
		return command.Receipt{Status: domain.Failed, Error: reason}, nil
	}
	return command.Receipt{Status: domain.Sent}, nil
}

// SMTP sends email through a mail server with plain auth.
type SMTP struct {
	Host     string
	Port     string
	User     string
	Password string
	From     string
}

// Send mails the message; a server refusal fails it with the server's answer.
func (s SMTP) Send(_ context.Context, m domain.Message) (command.Receipt, error) {
	msg := "From: " + s.From + "\r\nTo: " + m.To + "\r\nSubject: " + m.Subject + "\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n" + m.Body + "\r\n"
	var auth smtp.Auth
	if s.User != "" {
		auth = smtp.PlainAuth("", s.User, s.Password, s.Host)
	}
	if err := smtp.SendMail(s.Host+":"+s.Port, auth, s.From, []string{m.To}, []byte(msg)); err != nil {
		return command.Receipt{Status: domain.Failed, Error: err.Error()}, nil
	}
	return command.Receipt{Status: domain.Sent}, nil
}

// Sender is one channel's gateway.
type Sender interface {
	Send(ctx context.Context, m domain.Message) (command.Receipt, error)
}

// Live routes WhatsApp and email to their gateways. A live gateway reports delivery by webhook,
// which is not built yet, so Track keeps the status the send left.
type Live struct {
	WhatsApp Sender
	Email    Sender
}

// Send hands the message to its channel's gateway.
func (l Live) Send(ctx context.Context, m domain.Message) (command.Receipt, error) {
	gw := l.Email
	if m.Channel == domain.WhatsApp {
		gw = l.WhatsApp
	}
	if gw == nil {
		return command.Receipt{Status: domain.Failed, Error: "No " + domain.ChannelLabel[m.Channel] + " gateway is set up"}, nil
	}
	return gw.Send(ctx, m)
}

// Track keeps the status.
func (Live) Track(m domain.Message, _ string) string { return m.Status }
