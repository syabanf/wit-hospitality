package domain

import "github.com/syabanf/wit-hospitality/api/internal/property"

// VillaState is the villa as its events carry it.
func VillaState(v Villa) property.Villa {
	p := v.VillaProfile
	return property.Villa{
		ID: v.ID, LocationID: v.LocationID, Code: v.Code, Name: v.Name, Description: v.Description, Facilities: list(v.Facilities),
		Address: p.Address, Lat: p.Lat, Lng: p.Lng, Phone: p.Phone, Email: p.Email, CheckInTime: p.CheckInTime, CheckOutTime: p.CheckOutTime,
		LicenseNo: p.LicenseNo, BankName: p.BankName, BankAccountNo: p.BankAccountNo, BankAccountName: p.BankAccountName,
		HouseRules: p.HouseRules, CancellationPolicy: p.CancellationPolicy, DepositKind: p.DepositKind, DepositValue: v.DepositValue,
		Photos: photoStates(v.Photos), Operation: v.Operation, StayoverEvery: v.StayoverEvery, WholeRental: v.WholeRental,
		WholeNightlyRate: v.WholeNightlyRate, DepositOnCheckIn: v.DepositOnCheckIn, LateCheckoutFee: &v.LateCheckoutFee,
	}
}

// VillaOf is the villa an event carries; an event from before villas had an operation reads as a
// villa that asks a deposit at check-in.
func VillaOf(s property.Villa) Villa {
	v := Villa{
		ID: s.ID, LocationID: s.LocationID, Code: s.Code, Name: s.Name, Description: s.Description, Facilities: list(s.Facilities),
		VillaProfile: VillaProfile{
			Address: s.Address, Lat: s.Lat, Lng: s.Lng, Phone: s.Phone, Email: s.Email, CheckInTime: s.CheckInTime, CheckOutTime: s.CheckOutTime,
			LicenseNo: s.LicenseNo, BankName: s.BankName, BankAccountNo: s.BankAccountNo, BankAccountName: s.BankAccountName,
			HouseRules: s.HouseRules, CancellationPolicy: s.CancellationPolicy, DepositKind: s.DepositKind,
		},
		DepositValue: s.DepositValue, Photos: photosOf(s.Photos),
		Operating: Operating{Operation: s.Operation, StayoverEvery: s.StayoverEvery, WholeRental: s.WholeRental, WholeNightlyRate: s.WholeNightlyRate,
			DepositOnCheckIn: s.DepositOnCheckIn},
	}
	if v.Operation == "" {
		v.Operation, v.DepositOnCheckIn = OperationVilla, true
	}
	v.LateCheckoutFee = property.DefaultLateCheckoutFee(v.Operation)
	if s.LateCheckoutFee != nil {
		v.LateCheckoutFee = *s.LateCheckoutFee
	}
	return v
}

// GroupState is the room type as its events carry it.
func GroupState(g UnitGroup) property.Group {
	return property.Group{ID: g.ID, VillaID: g.VillaID, Name: g.Name, Interchangeable: g.Interchangeable, OperatorAssigns: g.OperatorAssigns, Kind: g.Kind}
}

// UnitState is the unit as its events carry it.
func UnitState(u Unit) property.Unit {
	beds := make([]property.Bed, 0, len(u.Beds))
	for _, b := range u.Beds {
		beds = append(beds, property.Bed(b))
	}
	return property.Unit{
		ID: u.ID, VillaID: u.VillaID, GroupID: u.GroupID, Code: u.Code, Name: u.Name, Bedrooms: u.Bedrooms, NightlyRate: u.NightlyRate,
		Status: u.Status, Amenities: list(u.Amenities), MaxAdults: u.MaxAdults, MaxChildren: u.MaxChildren, Beds: beds, SizeSqm: u.SizeSqm,
		View: u.View, ExtraBeds: u.ExtraBeds, ExtraBedRate: u.ExtraBedRate, Photos: photoStates(u.Photos), StatusReason: u.StatusReason,
		StatusUntil: u.StatusUntil, Floor: u.Floor, HostID: u.HostID,
	}
}

// UnitOf is the unit an event carries.
func UnitOf(s property.Unit) Unit {
	beds := make([]Bed, 0, len(s.Beds))
	for _, b := range s.Beds {
		beds = append(beds, Bed(b))
	}
	return Unit{
		ID: s.ID, VillaID: s.VillaID, GroupID: s.GroupID, Code: s.Code, Name: s.Name, Bedrooms: s.Bedrooms, NightlyRate: s.NightlyRate,
		Status: s.Status, Amenities: list(s.Amenities), MaxAdults: s.MaxAdults, MaxChildren: s.MaxChildren, Beds: beds, SizeSqm: s.SizeSqm,
		View: s.View, ExtraBeds: s.ExtraBeds, ExtraBedRate: s.ExtraBedRate, Photos: photosOf(s.Photos), StatusReason: s.StatusReason,
		StatusUntil: s.StatusUntil, Floor: s.Floor, HostID: s.HostID,
	}
}

func photoStates(p []Photo) []property.Photo {
	out := make([]property.Photo, 0, len(p))
	for _, x := range p {
		out = append(out, property.Photo(x))
	}
	return out
}

func photosOf(p []property.Photo) []Photo {
	out := make([]Photo, 0, len(p))
	for _, x := range p {
		out = append(out, Photo(x))
	}
	return out
}
