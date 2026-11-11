// Package domain holds the villa store rules ported from src/domain/stock.ts: items, movements,
// on hand, the moving average cost replay, receipts, moves, counts, amenity kits and minibar
// checks. It is pure: no database, no HTTP. Messages and codes match the TypeScript text.
package domain

import (
	"math"
	"regexp"
	"slices"
	"sort"
	"strings"
	"unicode"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Kinds is STOCK_KINDS.
var Kinds = []string{"minibar", "amenity", "linen"}

// Units is STOCK_UNITS.
var Units = []string{"piece", "bottle", "can", "pack", "pair", "set"}

// Movement kinds (MOVEMENT_KINDS).
const (
	Receipt     = "receipt"
	Issue       = "issue"
	MinibarSale = "minibar_sale"
	Adjustment  = "adjustment"
	Transfer    = "transfer"
	WriteOff    = "write_off"
)

var (
	code    = regexp.MustCompile(`^[A-Z0-9-]{2,16}$`)
	isoDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

// Round is JavaScript's Math.round: halves go up.
func Round(x float64) int64 { return int64(math.Floor(x + 0.5)) }

func whole(n float64) bool { return n == math.Trunc(n) && !math.IsInf(n, 0) && !math.IsNaN(n) }

func wholeAtLeast(n float64, low float64) bool { return whole(n) && n >= low }

// Item is StockItem: shared by every villa; each villa store holds its own quantity of it.
type Item struct {
	ID           string `json:"id"`
	Code         string `json:"code"`
	Name         string `json:"name"`
	Kind         string `json:"kind"`
	Unit         string `json:"unit"`
	ReorderLevel int    `json:"reorderLevel"`
	Par          int    `json:"par"`
	AverageCost  int64  `json:"averageCost"`
	Active       bool   `json:"active"`
	Version      int64  `json:"-"`
}

// ItemInput is StockItemInput.
type ItemInput struct {
	Code         string  `json:"code"`
	Name         string  `json:"name"`
	Kind         string  `json:"kind"`
	Unit         string  `json:"unit"`
	ReorderLevel float64 `json:"reorderLevel"`
	Par          float64 `json:"par"`
	Active       bool    `json:"active"`
}

// ValidateItem is validateStockItem; codeTaken says another item uses the code.
func ValidateItem(in ItemInput, codeTaken bool) error {
	var f errs.Fields
	if !code.MatchString(in.Code) {
		f.Add("code", "Capital letters, digits and dashes, 2 to 16 long.")
	} else if codeTaken {
		f.Add("code", in.Code+" is already used.")
	}
	if len([]rune(strings.TrimSpace(in.Name))) < 2 {
		f.Add("name", "Name the item.")
	}
	if !slices.Contains(Kinds, in.Kind) {
		f.Add("kind", "Pick the kind.")
	}
	if !slices.Contains(Units, in.Unit) {
		f.Add("unit", "Pick the unit.")
	}
	if !wholeAtLeast(in.ReorderLevel, 0) {
		f.Add("reorderLevel", "A whole number, zero or more.")
	}
	if !wholeAtLeast(in.Par, 0) {
		f.Add("par", "A whole number, zero or more.")
	} else if in.Par > 0 && in.Kind != "minibar" {
		f.Add("par", "Only minibar items have a par level.")
	}
	return f.Err()
}

// Apply copies the form onto the item; the average cost stays the replay's.
func (i *Item) Apply(in ItemInput) {
	i.Code, i.Name, i.Kind, i.Unit = in.Code, strings.TrimSpace(in.Name), in.Kind, in.Unit
	i.ReorderLevel, i.Par, i.Active = int(in.ReorderLevel), int(in.Par), in.Active
}

// Movement is StockMovement: one change to one item in one villa store; out of the store is negative.
type Movement struct {
	ID           string  `json:"id"`
	Number       string  `json:"number"`
	VillaID      string  `json:"villaId"`
	ItemID       string  `json:"itemId"`
	Kind         string  `json:"kind"`
	Quantity     int     `json:"quantity"`
	UnitCost     int64   `json:"unitCost"`
	On           string  `json:"on"`
	By           string  `json:"by"`
	UnitID       *string `json:"unitId"`
	BookingID    *string `json:"bookingId"`
	OrderID      *string `json:"orderId"`
	ReceiptID    *string `json:"receiptId"`
	CountID      *string `json:"countId"`
	TransferID   *string `json:"transferId"`
	OtherVillaID *string `json:"otherVillaId"`
	Reason       string  `json:"reason"`
}

// Value is movementValue.
func (m Movement) Value() int64 { return Round(float64(m.Quantity) * float64(m.UnitCost)) }

// OnHand is onHand: the sum of a store's movements of an item, up to a day when upTo is set.
func OnHand(movements []Movement, villaID, itemID, upTo string) int {
	n := 0
	for _, m := range movements {
		if m.VillaID == villaID && m.ItemID == itemID && (upTo == "" || m.On <= upTo) {
			n += m.Quantity
		}
	}
	return n
}

// IsLow is isLow.
func IsLow(i Item, quantity int) bool { return i.ReorderLevel > 0 && quantity <= i.ReorderLevel }

// StoreLevel is one item a villa store carries.
type StoreLevel struct {
	Item   Item
	OnHand int
	Value  int64
	Low    bool
}

// StoreLevels is storeLevels: every item the store has ever moved, valued at average.
func StoreLevels(items []Item, movements []Movement, villaID string, average func(itemID string) int64, upTo string) []StoreLevel {
	carried := map[string]bool{}
	for _, m := range movements {
		if m.VillaID == villaID {
			carried[m.ItemID] = true
		}
	}
	var out []StoreLevel
	for _, i := range items {
		if !carried[i.ID] {
			continue
		}
		q := OnHand(movements, villaID, i.ID, upTo)
		out = append(out, StoreLevel{Item: i, OnHand: q, Value: Round(float64(q) * float64(average(i.ID))), Low: i.Active && IsLow(i, q)})
	}
	return out
}

// AverageAfterReceipt is averageAfterReceipt: stock already held counts at the old average.
func AverageAfterReceipt(averageCost int64, held, quantity int, unitCost int64) int64 {
	before := max(0, held)
	if before+quantity > 0 {
		return Round((float64(before)*float64(averageCost) + float64(quantity)*float64(unitCost)) / float64(before+quantity))
	}
	return unitCost
}

func key(m Movement) string {
	r := "null"
	if m.ReceiptID != nil {
		r = *m.ReceiptID
	}
	return r + "|" + m.ItemID
}

// LiveMovements is liveMovements: a receipt movement with a negative quantity reverses a cancelled
// receipt, and neither half counts in the replay.
func LiveMovements(movements []Movement) []Movement {
	cancelled := map[string]bool{}
	for _, m := range movements {
		if m.Kind == Receipt && m.Quantity < 0 {
			cancelled[key(m)] = true
		}
	}
	out := make([]Movement, 0, len(movements))
	for _, m := range movements {
		if m.Kind != Receipt || !cancelled[key(m)] {
			out = append(out, m)
		}
	}
	return out
}

// CompareNumbers is localeCompare with { numeric: true } for movement numbers: digit runs compare
// as numbers, everything else as text.
func CompareNumbers(a, b string) int {
	for a != "" && b != "" {
		da, db := unicode.IsDigit(rune(a[0])), unicode.IsDigit(rune(b[0]))
		ra, rb := run(a, da), run(b, db)
		if da && db {
			na, nb := strings.TrimLeft(ra, "0"), strings.TrimLeft(rb, "0")
			if len(na) != len(nb) {
				return cmp(len(na), len(nb))
			}
			if c := strings.Compare(na, nb); c != 0 {
				return c
			}
		} else if c := strings.Compare(strings.ToLower(ra), strings.ToLower(rb)); c != 0 {
			return c
		}
		a, b = a[len(ra):], b[len(rb):]
	}
	return cmp(len(a), len(b))
}

func run(s string, digits bool) string {
	i := 0
	for i < len(s) && unicode.IsDigit(rune(s[i])) == digits {
		i++
	}
	return s[:i]
}

func cmp(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// replayLess is replayOrder: by day; inside a day receipts first, so the day's purchases price
// whatever left that day; then by number.
func replayLess(a, b Movement) bool {
	if a.On != b.On {
		return a.On < b.On
	}
	if ra, rb := boolInt(a.Kind == Receipt), boolInt(b.Kind == Receipt); ra != rb {
		return ra > rb
	}
	return CompareNumbers(a.Number, b.Number) < 0
}

// Step is one live movement in replay order with the item's moving average right after it.
type Step struct {
	Movement Movement
	Average  int64
}

type closing struct {
	day     string
	average int64
}

// Replay is CostReplay.
type Replay struct {
	Steps   []Step
	closing map[string][]closing
}

// ReplayCost is replayCost: the movements in date order for each item's moving weighted average.
// The average is one per item across every villa store: a receipt moves it, everything else
// leaves or arrives at it. Cancelled receipts drop out and a corrected receipt counts at its
// corrected lines.
func ReplayCost(movements []Movement) Replay {
	live := LiveMovements(movements)
	sort.SliceStable(live, func(i, j int) bool { return replayLess(live[i], live[j]) })
	held := map[string]int{}
	r := Replay{closing: map[string][]closing{}}
	for _, m := range live {
		days := r.closing[m.ItemID]
		var last *closing
		if len(days) > 0 {
			last = &days[len(days)-1]
		}
		var prev int64
		if last != nil {
			prev = last.average
		}
		avg := prev
		if m.Kind == Receipt {
			avg = AverageAfterReceipt(prev, held[m.ItemID], m.Quantity, m.UnitCost)
		}
		held[m.ItemID] += m.Quantity
		if last != nil && last.day == m.On {
			last.average = avg
		} else {
			days = append(days, closing{day: m.On, average: avg})
		}
		r.closing[m.ItemID] = days
		r.Steps = append(r.Steps, Step{Movement: m, Average: avg})
	}
	return r
}

// Average is an item's average at the close of a day, or the current one when on is empty; 0
// before its first receipt.
func (r Replay) Average(itemID, on string) int64 {
	days := r.closing[itemID]
	for i := len(days) - 1; i >= 0; i-- {
		if on == "" || days[i].day <= on {
			return days[i].average
		}
	}
	return 0
}

// UnitCost is the price per unit a movement is valued at: the purchase price on a receipt, the
// day's average on anything else.
func (r Replay) UnitCost(m Movement) int64 {
	if m.Kind == Receipt {
		return m.UnitCost
	}
	return r.Average(m.ItemID, m.On)
}

// Value is a movement's value at UnitCost.
func (r Replay) Value(m Movement) int64 {
	return Round(float64(m.Quantity) * float64(r.UnitCost(m)))
}

// Shortfall is the first day a store closes below zero, with what it holds then.
type Shortfall struct {
	On   string `json:"on"`
	Held int    `json:"held"`
}

// FirstShortfall is firstShortfall: the first day from `from` on which a villa store closes below
// zero of an item; nil when none does.
func FirstShortfall(movements []Movement, villaID, itemID, from string) *Shortfall {
	byDay := map[string]int{}
	for _, m := range LiveMovements(movements) {
		if m.VillaID == villaID && m.ItemID == itemID {
			byDay[m.On] += m.Quantity
		}
	}
	days := make([]string, 0, len(byDay))
	for d := range byDay {
		days = append(days, d)
	}
	sort.Strings(days)
	held := 0
	for _, d := range days {
		held += byDay[d]
		if held < 0 && d >= from {
			return &Shortfall{On: d, Held: held}
		}
	}
	return nil
}

// CanTake is assertCanTake: nothing leaves a store that does not hold it.
func CanTake(item Item, held, quantity int, storeName string) error {
	if quantity > held {
		return errs.Newf("STOCK_SHORT", "%s holds %d %s; %d cannot leave the store.", storeName, held, item.Name, quantity)
	}
	return nil
}

// Line is StockLine.
type Line struct {
	ItemID   string `json:"itemId"`
	Quantity int    `json:"quantity"`
}

// LineInput is a stock line as the form sends it.
type LineInput struct {
	ItemID   string  `json:"itemId"`
	Quantity float64 `json:"quantity"`
}

// ReceiptLine is ReceiptLine.
type ReceiptLine struct {
	ItemID   string `json:"itemId"`
	Quantity int    `json:"quantity"`
	UnitCost int64  `json:"unitCost"`
}

// ReceiptLineInput is a receipt line as the form sends it.
type ReceiptLineInput struct {
	ItemID   string  `json:"itemId"`
	Quantity float64 `json:"quantity"`
	UnitCost float64 `json:"unitCost"`
}

func validLines(lines []LineInput) bool {
	if len(lines) == 0 {
		return false
	}
	seen := map[string]bool{}
	for _, l := range lines {
		if l.ItemID == "" || !wholeAtLeast(l.Quantity, 1) || seen[l.ItemID] {
			return false
		}
		seen[l.ItemID] = true
	}
	return true
}

// Lines converts valid form lines.
func Lines(in []LineInput) []Line {
	out := make([]Line, 0, len(in))
	for _, l := range in {
		out = append(out, Line{ItemID: l.ItemID, Quantity: int(l.Quantity)})
	}
	return out
}
