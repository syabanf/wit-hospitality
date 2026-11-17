package bootstrap

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	propertycommand "github.com/syabanf/wit-hospitality/api/internal/property/app/command"
)

// companyAccounts answers property's corporate rate check from billing's city ledger accounts in
// the shared database, for a process where billing runs beside property.
type companyAccounts struct{ db *db.DB }

var _ propertycommand.Accounts = companyAccounts{}

// CompanyAccount reports whether id is a city ledger account of kind company.
func (a companyAccounts) CompanyAccount(ctx context.Context, id string) (bool, error) {
	var company bool
	err := a.db.Q(ctx).QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM billing.cl_accounts WHERE id = $1 AND doc->>'kind' = 'company')`, id).Scan(&company)
	return company, err
}
