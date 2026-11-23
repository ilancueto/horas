# Licencias, saldos, calculadora de extras y estadísticas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sumar tipos de licencia, un contador del período centrado en horas extra, una pestaña Saldos (francos por horas al 100% + vacaciones), una calculadora del valor de las extras y estadísticas anuales de extras y ausencias.

**Architecture:** Toda la lógica nueva son funciones puras en `src/domain/` (probadas con Vitest) que la UI de React consume vía `useHours()`. Las licencias son un campo `kind` en la colección `leaves` existente y el saldo inicial de francos son tres campos nuevos de las reglas sincronizadas; no cambia el SQL ni el motor de sync.

**Tech Stack:** React 19, TypeScript estricto, Zod 4, Dexie, Zustand, Vitest, Playwright, lucide-react, Tailwind/CSS propio.

**Spec:** `docs/superpowers/specs/2026-11-22-licencias-saldos-calculadora-design.md` (leerlo completo antes de empezar; los textos de UI y los ejemplos salen de ahí).

## Global Constraints

- UI en español rioplatense, mismo tono que el resto de la app ("Cargá", "Revisá").
- Sumas en minutos enteros. Horas decimales mostradas con `decimalTotals(rows, Boolean(period.excel))`.
- Todo cambio de datos pasa por `apply()` de `src/data/db.ts`; los ajustes por `saveSettings` existente (ver cómo lo usa `Preferences` en `src/ui/Settings.tsx`).
- No tocar `supabase/migrations/*`, ni el enum de colecciones de `src/data/syncEngine.ts`.
- Valor hora e importes: solo `privateData` local; nunca a la nube ni a exportaciones por defecto.
- Navegación inferior: exactamente 5 botones (Período · Calendario · Saldos · Resumen · Más); en escritorio "Resumen anual".
- Multiplicadores fijos: 50% = ×1,5; 100% = ×2. Un franco = 480 minutos al 100%.
- Moneda: `new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' })`.
- PDF/texto/Excel para RRHH siguen mostrando horas normales.
- Antes de cada commit: `npm run lint`, `npm run typecheck`, `npm test` en verde. Un commit por tarea, mensaje en español, terminando en `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- Datos viejos sin `kind` (IndexedDB, nube, backup JSON, Excel exportado antes): deben leerse como vacaciones sin errores ni pérdida. → test en Task 1 y Task 3.
- Reglas remotas o ajustes locales guardados antes del cambio (sin campos `comp*`): no deben descartarse. → test en Task 5.
- Jornada nocturna que cruza a domingo/feriado: su parte al 100% suma al acumulado de francos. → test en Task 5.
- Jornadas futuras (fecha > hoy) cargadas por adelantado no deben generar francos. → test en Task 5.
- Calculadora sin valor hora configurado y con valor de prueba vacío/0/negativo: no muestra `NaN` ni importes negativos. → test en Task 7.

---

### Task 1: Tipos de licencia en el dominio

**Files:**
- Modify: `src/domain/model.ts` (`leaveSchema`, exports nuevos)
- Modify: `src/domain/hours.ts` (`leaveBalance`, `dayRows`)
- Test: `src/domain/hours.test.ts`

**Interfaces:**
- Produces:
  - `export const leaveKinds = ['vacaciones', 'enfermedad', 'mudanza', 'otra'] as const`
  - `export type LeaveKind = (typeof leaveKinds)[number]`
  - `export const leaveLabels: Record<LeaveKind, { label: string; short: string }>` con `vacaciones: {label:'Vacaciones', short:'Vac'}`, `enfermedad: {label:'Licencia por enfermedad', short:'Enf'}`, `mudanza: {label:'Licencia por mudanza', short:'Mud'}`, `otra: {label:'Otra licencia', short:'Lic'}`
  - `leaveSchema` con `kind: z.enum(leaveKinds).default('vacaciones')`
  - `DayRow` suma `leave: LeaveKind | null`; `tone` puede ser `'lic'`; `vac` es `true` solo si `leave === 'vacaciones'`.
  - `leaveBalance(leaves, year, available)` (misma firma) cuenta solo `kind === 'vacaciones'`.

- [ ] **Step 1: Escribir los tests que fallan** en `src/domain/hours.test.ts`:
  - `it('lee licencias sin tipo como vacaciones')`: `leaveSchema.parse({ id, from:'2026-11-02', to:'2026-11-03', notes:'' }).kind` → `'vacaciones'`.
  - `it('el saldo de vacaciones ignora otras licencias')`: leaves = vacaciones 02–03/11 + enfermedad 09–11/11 → `leaveBalance(leaves,'2026',14)` → `{ used: 2, remaining: 12 }`.
  - `it('una licencia marca el día y no lo deja pendiente')`: período 01–30/11/2026, licencia `mudanza` el 10/11 (martes), `now='2026-11-20'` → fila del 10: `leave==='mudanza'`, `vac===false`, `tone==='lic'`, `pending===false`; fila de vacaciones → `tone==='vac'`, `vac===true`.
- [ ] **Step 2:** `npx vitest run src/domain/hours.test.ts` → FAIL (falta `kind`/`leave`).
- [ ] **Step 3:** Implementar en `model.ts` y `hours.ts`. En `dayRows`, buscar la licencia que cubre la fecha (`ledger.leaves.find(l => l.from <= date && l.to >= date)`); `tone`: `vac` si vacaciones, `lic` si otra licencia (misma prioridad que vac, antes de `comp`). `overlapsLeave` no cambia.
- [ ] **Step 4:** `npm run typecheck` y `npx vitest run` → PASS. Corregir usos de `leaveSchema`/`Item<'leaves'>` que ahora requieren `kind` (p. ej. `AbsenceForm` en `src/ui/Absences.tsx` y `parseExcel` en `src/data/excel.ts`: pasar `kind: 'vacaciones'` por ahora).
- [ ] **Step 5:** Commit `Licencias: tipo en el modelo y en el cálculo de días`.

### Task 2: Vista y formulario de Licencias

**Files:**
- Modify: `src/ui/Absences.tsx` (nueva vista `'licenses'`, filtro por tipo, formulario)
- Modify: `src/ui/App.tsx` (tipo `View`, botón "Licencias" en Más, render de la vista)
- Modify: `src/ui/Day.tsx` (`DayBadge`)
- Modify: `src/ui/Calendar.tsx` (leyenda: badge "Licencia")
- Modify: `src/styles.css` (token `--lic` claro y oscuro; clases `.lic` y filas `tr.lic`, `.day-card.lic` como `.vac`)
- Modify: `src/data/report.ts` (marcas de licencia)
- Test: `tests/horas.e2e.ts`

**Interfaces:**
- Consumes: `leaveKinds`, `leaveLabels`, `LeaveKind`, `DayRow.leave` (Task 1).
- Produces: `export type AbsenceView = 'comps' | 'leaves' | 'licenses' | 'holidays'`; `export function AbsenceForm(props: { view: AbsenceView; today: string; item?: Item<AbsenceView>; close: () => void; initial?: Partial<Item<'comps'>> })` exportado (Task 6 lo reutiliza con `initial`).

- [ ] **Step 1: Escribir el e2e que falla** en `tests/horas.e2e.ts`, test `'carga licencias por tipo'` (usar helpers `start`, `nav`): Más → "Licencias" → "Agregar licencia" → elegir tipo "Otra licencia", Desde `2026-11-26`, Hasta `2026-11-26`, notas vacías → Guardar → ver texto `Contá el motivo en las notas.`; completar notas `Trámite` → Guardar → ver `Otra licencia` en la lista; ir a Período → `getByText('Lic', { exact: true })` visible 1 vez. Agregar `['Licencias', 'licencias']` al loop de capturas.
- [ ] **Step 2:** `npm run test:e2e -- -g "licencias"` → FAIL.
- [ ] **Step 3:** Implementar:
  - `config.licenses = { title: 'Licencias', one: 'licencia', icon: <icono lucide a elección, p. ej. Stethoscope>, tone: 'lic' }`. Las vistas `leaves` y `licenses` usan la colección `leaves` filtrando `kind === 'vacaciones'` / `!== 'vacaciones'`; `apply` siempre con `collection: 'leaves'`.
  - Formulario de `licenses`: `<select name="kind" aria-label="Tipo">` con enfermedad/mudanza/otra (labels de `leaveLabels`), Desde/Hasta/Notas como vacaciones. Si `kind==='otra'` y notas vacías → `setWarning('Contá el motivo en las notas.')` y no guardar. Vacaciones guarda `kind:'vacaciones'`.
  - Lista de licencias: título `leaveLabels[kind].label`, debajo rango + días + notas; badge `leaveLabels[kind].short` con clase `lic`.
  - `DayBadge`: si `row.leave && row.leave !== 'vacaciones'` badge `lic` con `short` y `title=label`.
  - `report.ts`: donde hoy agrega `'  |  Vac'`, agregar `'  |  ' + leaveLabels[r.leave].label` para licencias no-vacaciones; incluir filas con `r.leave` en el detalle `'all'`.
  - `--lic`: un tono distinto de `--vac` (verde) y `--comp`, p. ej. lila claro `oklch(0.92 0.05 300)` / oscuro `oklch(0.33 0.06 300)`; verificar contraste con axe.
- [ ] **Step 4:** `npm run test:e2e` → PASS (incluye axe y capturas a 390/1440).
- [ ] **Step 5:** Commit `Licencias: vista, formulario y marcas en calendario e informes`.

### Task 3: Licencias en Excel y backup

**Files:**
- Modify: `src/data/excel.ts` (export hoja "Vacaciones" + import + clave de fusión)
- Test: `src/data/excel.test.ts`, `src/data/migration.test.ts` o test nuevo `src/data/transfer.test.ts`

**Interfaces:**
- Consumes: `leaveLabels`, `LeaveKind` (Task 1).
- Produces: hoja "Vacaciones" con encabezado `['Desde', 'Hasta', 'Días', 'Notas', 'Tipo']`; columna E = `leaveLabels[kind].label`.

- [ ] **Step 1: Tests que fallan:**
  - `it('exporta e importa el tipo de licencia')`: armar un libro con la función de exportación (si `exportExcel` escribe archivo con `XLSX.writeFile`, extraer `buildWorkbook(ledger, settings): XLSX.WorkBook` y que `exportExcel` lo use), convertir a bytes con `XLSX.write(book, { type: 'array' })`, `parseExcel(bytes, emptyLedger, defaults)` → `ledger.leaves.map(l => l.kind)` igual a los originales (`['vacaciones','enfermedad','otra']`).
  - `it('una planilla sin columna Tipo importa vacaciones')`: borrar la columna E de la hoja antes de parsear → todas `'vacaciones'`.
  - `it('restaura un backup viejo sin tipo')`: JSON de backup con `leaves: [{id, from, to, notes}]` pasa por el parser de `src/data/transfer.ts` → `kind === 'vacaciones'`.
- [ ] **Step 2:** `npx vitest run src/data` → FAIL.
- [ ] **Step 3:** Importación: leer `text(sheet, 'E' + i)`; mapear por label (insensible a mayúsculas) a `LeaveKind`, cualquier otro valor o vacío → `'vacaciones'`. Clave de fusión de leaves: `l.from + '|' + l.to + '|' + l.kind`.
- [ ] **Step 4:** `npx vitest run` → PASS; el test con la planilla real (si existe) sigue pasando.
- [ ] **Step 5:** Commit `Licencias: tipo en Excel y backups`.

### Task 4: Contador del período solo con extras

**Files:**
- Modify: `src/ui/Period.tsx` (bloque `overview-period`, ~líneas 245–296)
- Test: `tests/horas.e2e.ts`

- [ ] **Step 1: E2E que falla:** en el flujo existente (tras cargar jornadas), `const totals = page.getByRole('region', { name: 'Totales del período' })`; `expect(totals).toContainText('Horas extra')`, `expect(totals).not.toContainText('Normales')`, `expect(totals).toContainText(/días? trabajados?/)`.
- [ ] **Step 2:** `npm run test:e2e -- -g "<nombre del test>"` → FAIL.
- [ ] **Step 3:** Tarjeta principal: título "Horas extra", valor `totals.extra + totals.double` con `decimalValue={reported.extra + reported.double}`; mantener `small` con días trabajados. Tarjeta dividida: solo `['Al 50%','extra']` y `['Al 100%','double']`. No tocar "Totales de la planilla original".
- [ ] **Step 4:** `npm run test:e2e` → PASS; revisar capturas del período a 390 px (la tarjeta dividida con 2 columnas no debe verse vacía).
- [ ] **Step 5:** Commit `Período: el contador muestra solo horas extra`.

### Task 5: Saldo de francos compensatorios (dominio + reglas)

**Files:**
- Modify: `src/domain/model.ts` (`settingsSchema`, `defaults`, `rulesSchema`)
- Modify: `src/domain/hours.ts` (`compBalance`)
- Test: `src/domain/hours.test.ts`, `src/data/sync.test.ts` (o el test que cubra `readSettings` en `db.ts`)

**Interfaces:**
- Produces:
  - `settingsSchema` suma `compSince: day.nullable().default(null)`, `compOpeningDays: z.number().int().min(0).max(999).default(0)`, `compOpeningMinutes: z.number().int().min(0).max(479).default(0)`; `defaults` con los mismos valores; `rulesSchema` los incluye en el `pick`.
  - `export type CompBalance = { opening: number; accumulated: number; earned: number; remainder: number; missing: number; taken: number; available: number; earnedDates: string[] }`
  - `export function compBalance(ledger: Ledger, settings: Settings, now: string): CompBalance`

- [ ] **Step 1: Tests que fallan** (`describe('saldo de francos')`), con jornadas en domingos para que todo sea al 100% (`defaults`, descanso 0):
  - 25:50 h al 100% sin saldo inicial (p. ej. domingos 01/11 8:00, 08/11 8:00, 15/11 8:00, 22/11 1:50) y `now='2026-11-22'` → `earned 3`, `remainder 110`, `missing 370`, `available 3`, `earnedDates ['2026-11-01','2026-11-08','2026-11-15']`.
  - Saldo inicial `compSince '2026-11-07'`, `compOpeningDays 2`, `compOpeningMinutes 420` + jornada 08/11 de 1:00 al 100% + jornada 01/11 (anterior, se ignora) → `accumulated 480`, `earned 1`, `available 3`, `earnedDates ['2026-11-08']`.
  - Jornada el mismo día de `compSince` no cuenta (exclusivo).
  - Comps tomados: uno con `taken '2026-11-05'` (antes de `compSince '2026-11-07'`, no resta) y otro `taken '2026-11-20'` (resta) → `taken 1`.
  - Jornada futura (`date > now`) no suma.
  - Turno sábado 22:00 → domingo 06:00 suma su parte del domingo al acumulado (usar `calculate`, comparar con su `.double`).
  - Tomados > ganados → `available` negativo (p. ej. -1).
  - `settingsSchema.parse({...defaults sin comp*})` y `rulesRecordSchema.parse({ id: rulesId, ...reglas viejas sin comp* })` → `compSince null`, `compOpeningDays 0`, `compOpeningMinutes 0`.
- [ ] **Step 2:** `npx vitest run src/domain` → FAIL.
- [ ] **Step 3:** Implementar `compBalance`:

```
holidays = holidayMap(ledger)
entries  = ledger.entries filtradas por (compSince null || date > compSince) && date <= now, ordenadas por date
acc = compOpeningMinutes; earnedDates = []
por cada entry: antes = floor(acc/480); acc += calculate(entry, settings, holidays).double
                por cada k en (antes, floor(acc/480)]: earnedDates.push(entry.date)
earned = earnedDates.length; remainder = acc % 480; missing = 480 - remainder
taken = comps con taken != null && taken <= now && (compSince null || taken > compSince)
available = compOpeningDays + earned - taken; opening = compOpeningDays; accumulated = acc
```

  Verificar que `readSettings` en `db.ts` y la restauración de backup siguen funcionando con datos sin los campos (los `.default` lo resuelven; el refine de `rulesRecordSchema` se mantiene).
- [ ] **Step 4:** `npx vitest run` y `npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `Saldos: cálculo de francos por horas al 100% y saldo inicial`.

### Task 6: Pestaña Saldos y saldo inicial en Ajustes

**Files:**
- Create: `src/ui/Balances.tsx`
- Modify: `src/ui/App.tsx` (vista `'balances'`, `nav`, etiqueta móvil)
- Modify: `src/ui/Absences.tsx` (Vacaciones pierde tarjetas de saldo y selector de año; Compensatorio reemplaza sus tarjetas por botón "Ver saldo")
- Modify: `src/ui/Settings.tsx` (subsección "Saldo inicial de compensatorios" en "Horario y reglas")
- Test: `tests/horas.e2e.ts`

**Interfaces:**
- Consumes: `compBalance`, `CompBalance` (Task 5); `leaveBalance` (Task 1); `AbsenceForm` con `initial` (Task 2).
- Produces: `export function Balances(props: { today: string; openSettings: () => void; openComps: () => void })`; `View` suma `'balances'` y `'calculator'` (este último lo usa Task 7). En `Absences`, prop nueva `openBalances: () => void`.

- [ ] **Step 1: E2E que falla** `'muestra saldos de francos y vacaciones'`: `start(page)`; Ajustes → completar "Fecha del saldo inicial" `2026-11-01`, "Francos disponibles" `2`, "Horas sobrantes al 100%" `07:00` → guardar; cargar jornada del domingo 22/11 08:00–10:00 con descanso 0 (flujo de `openDay` del calendario); `nav(page,'Saldos')` → ver `3 disponibles`, texto `faltan 7:00`; botón "Registrar franco tomado" abre el diálogo de compensatorio con "Tomado" activo → elegir fecha `2026-11-23` (debe ser ≤ hoy, 24/11) → guardar → ver `2 disponibles`. Ver bloque "Vacaciones 2026" con `Saldo 14`. Agregar captura `saldos-<tema>` al loop.
- [ ] **Step 2:** `npm run test:e2e -- -g "saldos"` → FAIL.
- [ ] **Step 3:** Implementar:
  - `nav` en `App.tsx`: `['period','Período',ListChecks]`, `['calendar','Calendario',CalendarDays]`, `['balances','Saldos',<Scale o Wallet>]`, `['annual','Resumen anual',Activity]`, `['more','Más',Menu]`; móvil muestra "Resumen" para annual (lógica existente).
  - `Balances`: panel "Francos compensatorios" con `available` grande (`N disponibles`; si < 0 clase `warning` y texto `Tomaste más francos de los ganados`), línea `Ganados {earned} · Tomados {taken} · Saldo inicial {opening}`, `Acumulado al 100%: {clock(remainder)} — faltan {clock(missing)}` y `<progress max={480} value={remainder} aria-label="Progreso hacia el próximo franco">`; botones "Registrar franco tomado" (abre `AbsenceForm view="comps"` con `initial={{ earned: <earnedDates[taken + ...] más antiguo no tomado o today>, taken: today }}` y el check "Tomado" activo) y "Cargar saldo inicial" (`openSettings`). Panel "Vacaciones {año}" con `<select aria-label="Año de vacaciones">` y tiles Disponibles/Tomados/Saldo con `leaveBalance`.
  - Fecha precargada del franco: `earnedDates[k]` con `k = taken - compOpeningDays` si `0 <= k < earnedDates.length`; si no, `today`.
  - Ajustes: en "Horario y reglas" un `<h4>`/subtítulo "Saldo inicial de compensatorios" con `<input type="date" aria-label="Fecha del saldo inicial">` (vacío = `null`), `<input type="number" min=0 aria-label="Francos disponibles">`, `TimeField label="Horas sobrantes al 100%"` (rechazar ≥ 8:00 con `notify('Las horas sobrantes tienen que ser menos de 8:00.')`). Se guardan con los demás ajustes (van a reglas sincronizadas).
  - `Absences`: quitar tiles/selector de año de vacaciones; en Compensatorio reemplazar tiles por `<button onClick={openBalances}>Ver saldo</button>`.
- [ ] **Step 4:** `npm run test:e2e` → PASS (ajustar el e2e existente de compensatorio/vacaciones si buscaba los tiles quitados).
- [ ] **Step 5:** Commit `Saldos: pestaña de francos y vacaciones con saldo inicial`.

### Task 7: Calculadora de horas extra

**Files:**
- Create: `src/domain/pay.ts`, `src/domain/pay.test.ts`
- Create: `src/ui/Calculator.tsx`
- Modify: `src/ui/App.tsx` (vista `'calculator'`, botón en Más, prop a `PeriodView`)
- Modify: `src/ui/Period.tsx` (botón "¿Cuánto valen?" en `status-line`, prop `calculate: () => void`)
- Modify: `src/ui/Settings.tsx` (tile de Conciliar recibo ~544 usa `extraPay`, título "Extras estimadas del período"; etiqueta de la opción ~394 "Valor hora para calcular extras")
- Test: `src/domain/pay.test.ts`, `tests/horas.e2e.ts`

**Interfaces:**
- Consumes: `decimalTotals`, `dayRows` (existentes); `privateData.rate` de `useHours()`.
- Produces: `export function extraPay(hours: { extra: number; double: number }, rate: number): { extra: number; double: number; total: number }` (horas decimales → pesos; `rate` no finito o ≤ 0 → todos 0). `export function Calculator(props: { periodId?: string; today: string; openSettings: () => void })`.

- [ ] **Step 1: Tests que fallan** en `pay.test.ts`:
  - `extraPay({ extra: 12.5, double: 8 }, 5000)` → `{ extra: 93750, double: 80000, total: 173750 }`.
  - `extraPay({ extra: 1, double: 1 }, 0)`, `(…, -5)`, `(…, NaN)` → `{ extra: 0, double: 0, total: 0 }`.
  - E2E `'calcula el valor de las extras'`: Ajustes → activar valor hora `5000` → guardar; cargar jornada con extras; en Período tocar "¿Cuánto valen?" → ver `Calculadora de extras` y el total en pesos; cambiar "Valor hora" a `0` → total `$ 0,00` sin `NaN`; volver a Ajustes → el valor sigue siendo `5000`.
- [ ] **Step 2:** `npx vitest run src/domain/pay.test.ts` → FAIL.
- [ ] **Step 3:** Implementar `extraPay` y `Calculator`: selector de período (`chain(ledger.periods)`, nombres con `periodName` de `Period.tsx` — exportarlo si no lo está), input "Valor hora" precargado con `privateData.rate ?? ''` y aviso `No se guarda si lo cambiás`; sin rate guardado, texto `Cargá tu valor hora en Ajustes para no tener que repetirlo` + botón Ajustes. Horas: `decimalTotals(dayRows(period, ledger, settings, today), Boolean(period.excel))` (mismo redondeo que el recibo). Filas: `Al 50%  {number(h)} h × {ars(rate*1.5)} = {ars(...)}`, idem 100%, `Total extras`. En Más: botón "Calculadora de extras". "¿Cuánto valen?" abre la calculadora con el período visible.
- [ ] **Step 4:** `npx vitest run` y `npm run test:e2e` → PASS.
- [ ] **Step 5:** Commit `Calculadora de extras por período`.

### Task 8: Estadísticas del Resumen anual

**Files:**
- Modify: `src/domain/hours.ts` (`yearStats`)
- Modify: `src/ui/Calendar.tsx` (`Annual`)
- Test: `src/domain/hours.test.ts`, `tests/horas.e2e.ts`

**Interfaces:**
- Consumes: `compBalance` (Task 5), `LeaveKind`/`leaveKinds` (Task 1).
- Produces: `export function yearStats(ledger: Ledger, settings: Settings, year: string, now: string): { extra: number; weeklyExtra: number; leaveDays: Record<LeaveKind, number>; compsEarned: number; compsTaken: number }` (minutos para `extra`/`weeklyExtra`).

- [ ] **Step 1: Tests que fallan** `describe('estadísticas anuales')`:
  - `leaveDays` cuenta días calendario dentro del año: vacaciones 30/12/2026–02/01/2027 → en `'2026'` da 2 y en `'2027'` da 2.
  - `extra` = suma de `extra + double` de las jornadas del año (≤ `now`).
  - `weeklyExtra = round(extra / max(1, (daysBetween(año-01-01, min(now, año-12-31)) + 1) / 7))`.
  - `compsEarned` = `compBalance(...).earnedDates` dentro del año; `compsTaken` = comps con `taken` en el año.
- [ ] **Step 2:** `npx vitest run src/domain` → FAIL.
- [ ] **Step 3:** Implementar y actualizar `Annual`: tile "Horas extra del año" (`yearStats.extra`, reemplaza "Acumulado del año"); tile "Promedio semanal de extras"; conservar "Días trabajados"; quitar "Horas extra promedio por período" si queda redundante (decisión del implementador). Gráfico por período: solo segmentos `extra` y `double`, `max` calculado sobre `extra+double`, leyenda sin "Normales", valor a la derecha = extras. Panel nuevo "Ausencias del año": una línea por `leaveKinds` con `leaveLabels[k].label` y días, más `Francos ganados` y `Francos tomados`.
- [ ] **Step 4:** `npx vitest run` y `npm run test:e2e` → PASS; e2e: en Resumen ver `Horas extra del año` y `Ausencias del año`.
- [ ] **Step 5:** Commit `Resumen anual: extras, promedio semanal y ausencias`.

### Task 9: Verificación final

**Files:**
- Modify: `README.md` (sección corta: licencias, Saldos y saldo inicial, calculadora de extras; el valor hora sigue siendo local)
- Modify: `PLAN.md` (agregar ítem al checklist y decisiones de este trabajo)

- [ ] **Step 1:** `npm run lint && npm run typecheck && npm test` → todo en verde.
- [ ] **Step 2:** `npm run test:e2e` → todo en verde (escritorio 1440 y celular 390, temas claro/oscuro, axe sin violaciones).
- [ ] **Step 3:** Revisar visualmente las capturas nuevas (`saldos-*`, `licencias-*`, período, resumen, calculadora) en `test-results/`: nada cortado a 390 px, barra inferior con 5 botones legibles.
- [ ] **Step 4:** Actualizar README y PLAN.md.
- [ ] **Step 5:** Commit `Documentar licencias, saldos y calculadora`.
