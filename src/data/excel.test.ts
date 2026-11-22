import { existsSync, readFileSync } from 'node:fs'
import { expect,it } from 'vitest'
import { defaults,emptyLedger } from '../domain/model'
import { parseExcel } from './excel'

const reference='Registro_de_horas_actualizado.xlsx'
it.skipIf(!existsSync(reference))('lee las jornadas del libro real y reimporta sin duplicados',()=>{
  const bytes=readFileSync(reference)
  const first=parseExcel(bytes,emptyLedger,defaults)
  expect(first.ledger.periods).toHaveLength(2)
  expect(first.ledger.entries).toHaveLength(49)
  expect(first.comparisons[0].excel.map(v=>Math.round((v??0)*100)/100)).toEqual([160,10.42,1,171.42])
  expect(first.comparisons[0].calculated).toEqual([160,10.42,1,171.42])
  const second=parseExcel(bytes,first.ledger,defaults)
  expect(second.ledger).toEqual(first.ledger)
})
