import { expect, it } from 'vitest'
import { defaults, emptyLedger } from '../domain/model'
import { readBackup } from './transfer'

it('restaura un backup viejo sin tipo', () => {
  const old = {
    version: 1,
    created: '2026-03-01',
    ledger: {
      ...emptyLedger,
      leaves: [{ id: crypto.randomUUID(), from: '2026-03-01', to: '2026-03-02', notes: 'x' }],
    },
    settings: defaults,
  }
  const out = readBackup(JSON.stringify(old))
  expect(out.ledger.leaves[0].kind).toBe('vacaciones')
})
