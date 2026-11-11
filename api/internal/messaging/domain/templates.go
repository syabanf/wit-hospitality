package domain

func template(key, name, channel string, subject [2]string, en, id string) Template {
	return Template{Key: key, Name: name, Channel: channel, Enabled: true,
		Subject: map[string]string{"en": subject[0], "id": subject[1]}, Body: map[string]string{"en": en, "id": id}}
}

// DefaultTemplates is DEFAULT_TEMPLATES: the starting templates in English and Bahasa Indonesia.
func DefaultTemplates() []Template {
	return []Template{
		template("booking_confirmed", "Booking confirmation", Email,
			[2]string{"Your stay at {villa} is confirmed", "Pemesanan Anda di {villa} terkonfirmasi"},
			"Hi {guest}, your stay at {villa} from {checkIn} to {checkOut} is confirmed. Booking {code}. We look forward to welcoming you.",
			"Halo {guest}, menginap Anda di {villa} dari {checkIn} sampai {checkOut} sudah terkonfirmasi. Kode pemesanan {code}. Kami menantikan kedatangan Anda."),
		template("payment_link", "Payment link", WhatsApp,
			[2]string{"Payment for {code}", "Pembayaran untuk {code}"},
			"Hi {guest}, here is the payment link for {amount} on booking {code}: {link}",
			"Halo {guest}, berikut tautan pembayaran sebesar {amount} untuk pemesanan {code}: {link}"),
		template("payment_received", "Payment receipt", WhatsApp,
			[2]string{"We received your payment", "Pembayaran Anda sudah kami terima"},
			"Thank you {guest}, we received {amount} for booking {code}.",
			"Terima kasih {guest}, kami sudah menerima {amount} untuk pemesanan {code}."),
		template("pre_arrival", "Pre-arrival and online check-in", WhatsApp,
			[2]string{"Check in online before you arrive", "Check-in online sebelum tiba"},
			"Hi {guest}, we are getting {villa} ready for {checkIn}. Save time at arrival: confirm your details, upload your ID and sign the house rules here: {link}",
			"Halo {guest}, kami sedang menyiapkan {villa} untuk {checkIn}. Hemat waktu saat tiba: isi data, unggah identitas dan setujui aturan rumah di sini: {link}"),
		template("welcome", "Check-in welcome", WhatsApp,
			[2]string{"Welcome to {villa}", "Selamat datang di {villa}"},
			"Welcome to {villa}, {guest}! You are in {unit}. WiFi: {wifi}. House rules: quiet hours from 22:00, no smoking indoors, no glass by the pool. Message us here any time.",
			"Selamat datang di {villa}, {guest}! Anda menempati {unit}. WiFi: {wifi}. Aturan rumah: jam tenang mulai 22.00, dilarang merokok di dalam, tidak ada gelas kaca di kolam. Hubungi kami di sini kapan saja."),
		template("checkout_reminder", "Checkout reminder", WhatsApp,
			[2]string{"Check-out tomorrow", "Check-out besok"},
			"Hi {guest}, a reminder that check-out from {unit} is tomorrow, {checkOut}, by 12:00. Tell us if you need a late check-out or an airport transfer.",
			"Halo {guest}, pengingat bahwa check-out dari {unit} besok, {checkOut}, paling lambat pukul 12.00. Kabari kami bila perlu late check-out atau antar ke bandara."),
		template("post_stay", "Thank you and e-invoice", Email,
			[2]string{"Thank you for staying at {villa}", "Terima kasih telah menginap di {villa}"},
			"Thank you for staying with us, {guest}. Your invoice for {code} is here: {link}. We would love a review: "+ReviewLink,
			"Terima kasih telah menginap bersama kami, {guest}. Invoice untuk {code} ada di sini: {link}. Kami senang sekali bila Anda memberi ulasan: "+ReviewLink),
		template("city_ledger_invoice", "City ledger invoice", Email,
			[2]string{"Invoice {code} from Bali Villas", "Invoice {code} dari Bali Villas"},
			"Dear {guest}, please find invoice {code} for the stays billed to your account: {amount}, due on {due}. Pay by bank transfer to BCA 123 456 7890, Bali Villas, quoting {code}. Thank you.",
			"Yth. {guest}, terlampir invoice {code} untuk menginap yang ditagihkan ke akun Anda: {amount}, jatuh tempo {due}. Mohon transfer ke BCA 123 456 7890 a.n. Bali Villas dengan berita {code}. Terima kasih."),
	}
}

// DefaultSettings is DEFAULT_MESSAGING_SETTINGS.
func DefaultSettings() Settings {
	return Settings{PreArrivalDays: 3, Wifi: map[string]string{}, Templates: DefaultTemplates()}
}
