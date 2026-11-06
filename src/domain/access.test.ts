import { describe, expect, it } from 'vitest'
import { allowedVilla, can, DEFAULT_PERMISSIONS, MODULES, ROLES } from './access'

describe('villa owner access', () => {
  it('gives a villa owner the owner portal and nothing else', () => {
    expect(DEFAULT_PERMISSIONS.investor.portal).toEqual(['view', 'create'])
    for (const m of MODULES.filter((x) => x !== 'portal')) expect(DEFAULT_PERMISSIONS.investor[m], m).toEqual([])
    expect(can(DEFAULT_PERMISSIONS, 'investor', 'finance', 'view')).toBe(false)
    expect(can(DEFAULT_PERMISSIONS, 'investor', 'reports', 'view')).toBe(false)
  })

  it('keeps the portal to villa owners: operator roles work owners under Finance', () => {
    for (const r of ROLES.filter((x) => x !== 'investor')) expect(DEFAULT_PERMISSIONS[r].portal, r).toEqual([])
    expect(can(DEFAULT_PERMISSIONS, 'finance', 'finance', 'post')).toBe(true)
    expect(can(DEFAULT_PERMISSIONS, 'owner', 'finance', 'approve')).toBe(true)
    expect(can(DEFAULT_PERMISSIONS, 'manager', 'finance', 'post')).toBe(false)
  })

  it('scopes a villa owner to the villas they own', () => {
    const hendra = { locationIds: [], villaIds: ['vil-karang', 'vil-pandawa'] }
    expect(allowedVilla(hendra, { id: 'vil-karang', locationId: 'loc-uluwatu' })).toBe(true)
    expect(allowedVilla(hendra, { id: 'vil-saka', locationId: 'loc-canggu' })).toBe(false)
    expect(allowedVilla(hendra, { id: 'vil-lumbung', locationId: 'loc-seminyak' })).toBe(false)
  })
})
