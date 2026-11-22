import { useState } from 'react'
import { Clipboard, Download, FileSpreadsheet, FileText, HardDrive } from 'lucide-react'
import { daysBetween, number } from '../domain/dates'
import type { DayRow } from '../domain/hours'
import type { Period } from '../domain/model'
import { apply, diffLedger, notify, saveSettings, useHours } from '../data/db'
import type { ExcelPreview } from '../data/excel'
import { downloadPDF, reportText } from '../data/report'
import { backup, readBackup, type Backup } from '../data/transfer'
import { Dialog } from './base'

export function ImportExcel({ close, onDone }: { close: () => void; onDone?: () => void }) {
  const { ledger, settings } = useHours()
  const [preview, setPreview] = useState<ExcelPreview>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Dialog title="Importar mi Excel" close={close}>
      <div className="stack">
        <label>
          Planilla de registro
          <input
            type="file"
            accept=".xlsx"
            onChange={async (e) => {
              const file = e.target.files?.[0]
              if (!file) return
              setBusy(true)
              setError('')
              setPreview(undefined)
              try {
                const { parseExcel } = await import('../data/excel')
                setPreview(parseExcel(await file.arrayBuffer(), ledger, settings))
              } catch {
                setError(
                  'No pudimos leer la planilla. Revisá que sea un archivo XLSX con las hojas de Horas.',
                )
              } finally {
                setBusy(false)
              }
            }}
          />
        </label>
        {busy && <p role="status">Leyendo planilla…</p>}
        {error && (
          <p role="alert" className="warning">
            {error}
          </p>
        )}
        {preview && (
          <>
            <p>
              {preview.imported.periods.length} períodos · {preview.imported.entries.length}{' '}
              jornadas con datos · {preview.imported.comps.length} compensatorios ·{' '}
              {preview.imported.leaves.length} vacaciones · {preview.imported.holidays.length}{' '}
              feriados
            </p>
            {!!preview.comparisons.length && (
              <div className="comparison">
                <table>
                  <caption>Totales en horas · normales / 50% / 100% / total</caption>
                  <thead>
                    <tr>
                      <th>Hoja</th>
                      <th>Excel</th>
                      <th>Recalculado*</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.comparisons.map((c) => (
                      <tr key={c.id}>
                        <th>{c.sheet}</th>
                        <td>
                          {c.excel.map((v) => (v === undefined ? '—' : number(v))).join(' / ')}
                        </td>
                        <td>{c.calculated.map(number).join(' / ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <small>*Con los feriados de la planilla y redondeo por fila.</small>
              </div>
            )}
            {!!preview.warnings.length && (
              <ul className="warnings">
                {preview.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
            <p className="muted">Si un registro ya existe, se conserva la versión guardada.</p>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  const { mergeLedger } = await import('../data/excel')
                  const current = useHours.getState().ledger
                  const changes = diffLedger(current, mergeLedger(current, preview.imported))
                  if (changes.length && !(await apply(changes, 'Planilla importada'))) return
                  if (
                    !(await saveSettings({
                      annualLeave: preview.annualLeave ?? settings.annualLeave,
                      onboarded: true,
                    }))
                  )
                    return
                  notify(changes.length ? 'Planilla importada' : 'La planilla ya estaba importada')
                  onDone?.()
                  close()
                } catch {
                  setError('No pudimos guardar la importación. Volvé a intentar.')
                } finally {
                  setBusy(false)
                }
              }}
            >
              Confirmar importación
            </button>
          </>
        )}
      </div>
    </Dialog>
  )
}
export function DataTools({ today, openImport }: { today: string; openImport: () => void }) {
  const { ledger, settings, backupAt } = useHours()
  const [include, setInclude] = useState(false)
  const [restore, setRestore] = useState<Backup>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const old = !backupAt || daysBetween(backupAt, today) >= 30
  return (
    <section className="panel stack">
      <h2>Archivos y respaldo</h2>
      <p className={old ? 'warning' : 'muted'}>
        {!backupAt
          ? 'Todavía no hiciste un backup.'
          : old
            ? 'Pasaron ' + daysBetween(backupAt, today) + ' días desde tu último backup.'
            : 'Último backup: ' + backupAt}
      </p>
      <div className="actions">
        <button onClick={openImport}>
          <FileSpreadsheet size={17} /> Importar mi Excel
        </button>
        <button
          onClick={async () => {
            try {
              const { downloadExcel } = await import('../data/excel')
              downloadExcel(ledger, settings, today)
            } catch {
              notify('No pudimos generar el Excel. Volvé a intentar.')
            }
          }}
        >
          <Download size={17} /> Exportar XLSX
        </button>
        <button
          onClick={() =>
            void backup(today, include).catch(() => notify('No pudimos guardar el backup.'))
          }
        >
          <HardDrive size={17} /> Backup JSON
        </button>
      </div>
      <label className="check">
        <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} />{' '}
        Incluir valor hora y conciliación en el backup JSON
      </label>
      <label>
        Restaurar backup
        <input
          type="file"
          accept=".json,application/json"
          onChange={async (e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (!file) return
            try {
              setRestore(readBackup(await file.text()))
              setError('')
            } catch (err) {
              setError((err as Error).message)
            }
          }}
        />
      </label>
      {error && (
        <p role="alert" className="warning">
          {error}
        </p>
      )}
      {restore && (
        <Dialog title="Restaurar backup" close={() => !busy && setRestore(undefined)}>
          <div className="stack">
            <p>
              Se reemplazarán tus datos locales con el respaldo del {restore.created} (
              {restore.ledger.periods.length} períodos). Los datos privados se restauran si están
              incluidos.
            </p>
            <div className="actions">
              <button
                className="primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await backup(today)
                    if (
                      !(await apply(
                        () => diffLedger(useHours.getState().ledger, restore.ledger),
                        'Backup restaurado',
                        false,
                        {
                          settings: { ...restore.settings, onboarded: true },
                          privateData: restore.privateData,
                        },
                      ))
                    )
                      return
                    useHours.setState({ past: [], future: [] })
                    setRestore(undefined)
                  } catch {
                    setError('No se pudo restaurar el backup. Volvé a intentar.')
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                Descargar backup y restaurar
              </button>
              <button disabled={busy} onClick={() => setRestore(undefined)}>
                Cancelar
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  )
}
export function Report({
  period,
  rows,
  close,
}: {
  period: Period
  rows: DayRow[]
  close: () => void
}) {
  const text = reportText(period, rows, 'extra')
  const [error, setError] = useState('')
  return (
    <Dialog title="Resumen para RRHH" close={close}>
      <div className="stack">
        <label>
          Texto para copiar
          <textarea readOnly rows={8} value={text} onFocus={(e) => e.target.select()} />
        </label>
        <div className="actions">
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text)
                notify('Resumen copiado')
              } catch {
                setError('Seleccioná el texto y copialo con Ctrl+C.')
              }
            }}
          >
            <Clipboard size={16} /> Copiar
          </button>
          <button
            onClick={() =>
              void downloadPDF(period, rows, 'extra').catch(() =>
                setError('No pudimos generar el PDF.'),
              )
            }
          >
            <FileText size={16} /> PDF de extras
          </button>
          <button
            onClick={() =>
              void downloadPDF(period, rows, 'all').catch(() =>
                setError('No pudimos generar el PDF.'),
              )
            }
          >
            <FileText size={16} /> PDF del período
          </button>
        </div>
        <button
          className="primary"
          disabled={period.status !== 'Abierto'}
          onClick={async () => {
            if (
              await apply(
                [{ collection: 'periods', item: { ...period, status: 'Enviado a RRHH' } }],
                'Período enviado a RRHH',
              )
            )
              close()
          }}
        >
          Marcar como enviado
        </button>
        {error && (
          <p role="alert" className="warning">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  )
}
