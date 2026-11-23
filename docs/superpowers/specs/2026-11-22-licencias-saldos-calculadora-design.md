# Licencias, saldos, calculadora de extras y estadísticas — diseño

Fecha: 2026-11-22 · Rama base: `codex/registro-horas`

## Intención

Horas es una PWA personal de registro de jornadas para una persona con **sueldo fijo**: las horas normales no cambian lo que cobra, solo cuentan las extra (50% y 100%). Además, cada **8 h acumuladas al 100% generan un franco compensatorio**. Hoy la app no distingue licencias, muestra las horas normales como protagonista, no calcula cuánto valen las extra de forma visible y obliga a llevar la cuenta de francos a mano.

Este trabajo hace que la app responda tres preguntas sin salir de ella:

1. ¿Qué días estuve de licencia y de qué tipo?
2. ¿Cuánto valen las horas extra de este período?
3. ¿Cuántos francos compensatorios y días de vacaciones me quedan?

## Objetivos

- Tres tipos de licencia: **enfermedad**, **mudanza**, **otra** (el motivo de "otra" va en notas).
- Contador del período centrado en horas extra; las normales salen del contador.
- Calculadora de valor de horas extra por período.
- Pestaña **Saldos**: francos compensatorios (calculados por horas al 100%) y vacaciones.
- Estadísticas anuales ampliadas.

## No objetivos

- No se cambia el motor de cálculo de franjas (`calculate` en `src/domain/hours.ts`).
- No se cambia el esquema SQL de Supabase ni la sincronización.
- No se valorizan guardias ni horas normales.
- No se agregan saldos para licencias (enfermedad/mudanza/otra no tienen tope).
- Los PDF/Excel/texto para RRHH siguen mostrando horas normales (son documentos de registro, no de pago).

## Anti-objetivos (sería un fracaso aunque funcione)

- Que se pierdan o dupliquen vacaciones existentes al migrar.
- Que un franco se cuente dos veces (por saldo inicial y por jornadas del mismo tramo).
- Que el valor hora o los importes salgan del dispositivo (nube, backup por defecto, exportaciones).
- Romper la sincronización con dispositivos que todavía tienen la versión anterior.

## Restricciones

- Español rioplatense en toda la UI, mismo estilo visual ("tarjeta de reloj fichador", ver `PLAN.md`).
- Sumas en minutos enteros; decimales con `decimalTotals` (respeta el redondeo por fila de períodos importados).
- Datos validados con Zod; cambios por `apply()` de `src/data/db.ts` (cola de sync + deshacer).
- Navegación inferior móvil: máximo 5 botones a 390 px.
- `npm run lint`, `npm run typecheck`, `npm test` y `npm run test:e2e` tienen que pasar.

## Enfoques considerados

**Licencias**

- **A (elegido): campo `kind` en la colección `leaves` existente.** `kind: 'vacaciones' | 'enfermedad' | 'mudanza' | 'otra'`, por defecto `'vacaciones'`. No toca SQL ni la lista de colecciones sincronizadas (`syncEngine.ts`, migración SQL). Los registros viejos se leen como vacaciones.
- B: colección nueva `licenses`. Requiere cambiar el `check` de la migración SQL, el enum de `syncEngine.ts`, backups e importación. Más trabajo sin beneficio.

**Francos compensatorios**

- **A (elegido): calcularlos a partir de las jornadas + un saldo inicial manual.** Lo que sobra pasa siempre al período siguiente (acumulado de todo el historial desde la fecha del saldo inicial).
- B: acumulado por año (vuelve a cero el 1° de enero). Descartado por la persona.
- C: crear registros de franco automáticamente. Descartado: genera registros sin intervención y complica deshacer/sincronizar.

**Calculadora**

- **A (elegido): solo horas extra, valor hora desde Ajustes** (dato privado existente `privateData.rate`), con un valor de prueba temporal en la propia calculadora.
- B: calcular también horas normales. Descartado: sueldo fijo.

## Diseño

### 1. Licencias

**Modelo** (`src/domain/model.ts`)

- `leaveSchema` suma `kind: z.enum(['vacaciones', 'enfermedad', 'mudanza', 'otra']).default('vacaciones')`.
- Exportar `type LeaveKind` y una tabla de etiquetas: `vacaciones → "Vacaciones"`, `enfermedad → "Licencia por enfermedad"`, `mudanza → "Licencia por mudanza"`, `otra → "Otra licencia"`. Abreviaturas para badges: `Vac`, `Enf`, `Mud`, `Lic`.
- Los datos existentes (IndexedDB, nube, backups) no tienen `kind`: el `default` los lee como vacaciones. Verificar que `ledgerSchema`, la carga de Dexie (`db.ts`), la sync (`syncEngine.ts`) y `transfer.ts` parsean con este esquema y no con una copia.

**Cálculos** (`src/domain/hours.ts`)

- `leaveBalance` cuenta **solo** `kind === 'vacaciones'`.
- `overlapsLeave` sigue comparando contra **todas** las licencias (no puede haber vacaciones y licencia el mismo día).
- `dayRows`: además de `vac: boolean`, cada fila expone `leave: LeaveKind | null` (la licencia que cubre el día). `vac` queda `true` solo para vacaciones. Nuevo tono `'lic'` para enfermedad/mudanza/otra (prioridad igual a `vac`). `pending` es `false` si hay cualquier licencia.

**UI**

- La vista `leaves` (`src/ui/Absences.tsx`) se muestra como **"Vacaciones"** y filtra `kind === 'vacaciones'`; se agrega una vista nueva **"Licencias"** (`AbsenceView` suma `'licenses'`, misma colección `leaves`, filtra `kind !== 'vacaciones'`).
- Formulario de licencias: selector de tipo (enfermedad / mudanza / otra), desde, hasta, notas. Si el tipo es "otra", **las notas son obligatorias** (mensaje: "Contá el motivo en las notas.").
- La lista de licencias muestra el tipo como título y el rango + días + notas debajo; badge con la abreviatura.
- Las tarjetas de saldo de vacaciones se mudan a la pestaña Saldos (sección 3); la vista "Vacaciones" conserva la lista y el selector de año puede quitarse.
- Botón "Licencias" en la sección **Más** junto a Compensatorio, Vacaciones, Feriados.
- `DayBadge` (`src/ui/Day.tsx`) y la leyenda del calendario (`src/ui/Calendar.tsx`) muestran el badge de licencia. Nuevo token de color `--lic` en `src/styles.css` (claro y oscuro), distinto de `--vac` y `--comp`, con contraste AA del texto.

**Exportaciones**

- `src/data/report.ts`: además de `| Vac`, agregar `| Lic. enfermedad`, `| Lic. mudanza`, `| Otra licencia`; las filas con licencia se incluyen en el detalle "todas las jornadas".
- `src/data/excel.ts` exportación: hoja "Vacaciones" suma columna **Tipo**. Importación: filas sin tipo → `vacaciones`; si existe la columna Tipo, mapear etiquetas a `kind`. La clave de fusión pasa a `from|to|kind`.

### 2. Contador del período solo con extras

En `PeriodView` (`src/ui/Period.tsx`), bloque "Totales del período":

- Tarjeta principal: **"Horas extra"** = `extra + double` (en minutos y decimal con `decimalTotals`, sumando `reported.extra + reported.double`). Debajo, se mantiene "N días trabajados".
- Tarjeta dividida: solo **Al 50%** y **Al 100%** (se quita "Normales").
- "Totales de la planilla original" (detalle de Excel) queda igual: es conciliación con la planilla.
- La tabla/tarjetas de jornadas no cambian.

### 3. Pestaña Saldos

Nueva vista `'balances'` en la navegación principal. Navegación: **Período · Calendario · Saldos · Resumen · Más** (5 botones; en escritorio dice "Resumen anual"). Icono sugerido: `Scale` o `Wallet` de lucide.

**Saldo inicial de francos (dato nuevo, sincronizado)**

Se agrega a las reglas compartidas (`settingsSchema` + `rulesSchema` en `model.ts`):

- `compSince: day | null` — fecha del saldo inicial. `null` = no hay saldo inicial; se cuentan todas las jornadas.
- `compOpeningDays: int ≥ 0` — francos disponibles a esa fecha. Default 0.
- `compOpeningMinutes: int 0–479` — horas al 100% sobrantes a esa fecha (todavía no completaban un franco). Default 0.

Importante: los dispositivos con datos de reglas viejos no traen estos campos. Los campos deben tener `.default(...)` en el esquema (o mezclarse con `defaults` antes de parsear) para que `rulesRecordSchema.safeParse` en `db.ts` (línea ~90) no falle y descarte las reglas remotas.

Se edita desde Ajustes ("Horario y reglas" → subsección "Saldo inicial de compensatorios") y desde un botón "Cargar saldo inicial" en la pestaña Saldos (abre el mismo formulario). Campos: fecha, francos disponibles, horas sobrantes (h:mm con `TimeField`/`parseClock`).

**Cálculo** (función pura nueva `compBalance(ledger, settings, now)` en `src/domain/hours.ts`)

```
desde = compSince  (exclusivo: cuentan jornadas con fecha > compSince; si es null, todas)
acumulado = compOpeningMinutes + Σ calculate(jornada).double   para jornadas en el rango y fecha <= now
ganados   = floor(acumulado / 480)
resto     = acumulado % 480            → "faltan 480 - resto para el próximo franco"
tomados   = cantidad de comps con taken != null y (compSince null o taken > compSince)
disponibles = compOpeningDays + ganados - tomados
```

- Ejemplo de la persona: 25:50 h al 100% → ganados 3, resto 1:50, faltan 6:10.
- Usa minutos exactos (no el redondeo por fila de Excel).
- `disponibles` puede ser negativo (tomó más de lo ganado): se muestra en rojo con el texto "Tomaste más francos de los ganados".
- También devuelve, para cada franco ganado, la **fecha en que se completó** (la jornada que cruzó cada múltiplo de 480), usada para registrar el franco.

**Relación con la lista "Compensatorio"**

- La colección `comps` sigue existiendo y sigue siendo el registro de francos (ganado el / tomado el). En Saldos, "tomados" sale de esa lista.
- Botón **"Registrar franco tomado"** en Saldos: abre el formulario de compensatorio existente con `earned` precargado con la fecha en que se completó el franco más antiguo no tomado (si no hay, hoy) y `taken` activado. Reutilizar `AbsenceForm` (exportarlo o extraerlo).
- La vista Compensatorio conserva su lista; sus tarjetas (Pendientes/Tomados/En total) se reemplazan por un enlace "Ver saldo" a la pestaña Saldos.

**Pantalla Saldos**

```
Saldos
┌ Francos compensatorios ───────────────────────┐
│  3 disponibles                                 │
│  Ganados 3 · Tomados 0 · Saldo inicial 0       │
│  Acumulado al 100%: 1:50 — faltan 6:10 ▓▓░░░░  │
│  [Registrar franco tomado] [Cargar saldo inicial] │
└────────────────────────────────────────────────┘
┌ Vacaciones 2026 [año ▾] ──────────────────────┐
│  Disponibles 14 · Tomados 5 · Saldo 9          │
└────────────────────────────────────────────────┘
```

- La barra de progreso muestra `resto / 480`.
- Vacaciones: la lógica existente `leaveBalance` (solo `kind === 'vacaciones'`), con el selector de año que hoy está en la vista Vacaciones.

### 4. Calculadora de horas extra

Nueva vista `'calculator'`, accesible desde **Más** ("Calculadora de extras") y desde un botón **"¿Cuánto valen?"** en la barra de estado del período (`status-line` de `PeriodView`), que la abre con ese período elegido.

- Selector de período (mismos nombres que `periodName`).
- Valor hora: se precarga de `privateData.rate`. Si no hay, aparece un campo con el texto "Cargá tu valor hora en Ajustes para no tener que repetirlo" y un botón a Ajustes. El campo de la calculadora acepta un **valor de prueba** que no se guarda (se aclara "No se guarda").
- Función pura nueva `extraPay(reported, rate)` en `src/domain/hours.ts` (o `src/domain/pay.ts`): `{ extra: rate*1.5*horas50, double: rate*2*horas100, total }`, usando las horas decimales de `decimalTotals(rows, Boolean(period.excel))` para coincidir con el recibo.
- Muestra:

```
Calculadora de extras    [Período nov 2026 ▾]
Valor hora  [$ 5.000 ]  (de Ajustes · No se guarda si lo cambiás)
Al 50%   12,50 h × $ 7.500  = $ 93.750
Al 100%   8,00 h × $ 10.000 = $ 80.000
Total extras                  $ 173.750
```

- Formato de moneda `Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' })`.
- El tile "Bruto estimado del período" de "Conciliar recibo" (`src/ui/Settings.tsx` ~544) pasa a usar `extraPay` y se titula **"Extras estimadas del período"** (sin horas normales).
- En Ajustes, la opción "Estimar el pago en este dispositivo" se renombra a "Valor hora para calcular extras" (mismo dato privado, sigue sin sincronizarse y fuera de las exportaciones).

### 5. Estadísticas (Resumen anual)

En `Annual` (`src/ui/Calendar.tsx`), coherente con el foco en extras:

- "Acumulado del año" pasa a **"Horas extra del año"** (50% + 100%). El gráfico de barras por período muestra solo 50% y 100% (la leyenda quita "Normales").
- Nuevo tile: **"Promedio semanal de extras"** = horas extra del año / semanas transcurridas del año (hasta hoy o hasta el último período del año, lo que sea menor; mínimo 1).
- Se mantiene "Días trabajados".
- Nuevo panel **"Ausencias del año"**: días de vacaciones, licencia por enfermedad, por mudanza y otras (días calendario que caen en el año), francos ganados en el año (fechas de completado dentro del año) y francos tomados en el año.

### Pruebas

- Vitest (`src/domain/hours.test.ts` y nuevos):
  - `compBalance`: 25:50 h → 3 ganados, resto 110 min; saldo inicial + jornadas; `compSince` excluye jornadas anteriores o iguales; tomados antes de `compSince` no restan; jornada nocturna que cruza a domingo suma su parte al 100%; disponibles negativos.
  - `leaveBalance` ignora licencias no-vacaciones; registro sin `kind` se parsea como vacaciones.
  - `dayRows`: licencia → tono `lic`, no pendiente.
  - `extraPay` con y sin redondeo de Excel.
  - Excel: exportar/importar conserva `kind`; planilla sin columna Tipo → vacaciones.
  - Reglas remotas sin los campos `comp*` se parsean con defaults.
- Playwright (`tests/horas.e2e.ts`): actualizar aserciones del contador (ya no hay "Normales") y del botón "Vacaciones"; agregar flujo: cargar licencia "otra" sin notas → error; con notas → aparece en calendario; cargar saldo inicial y ver Saldos; abrir calculadora desde el período. Revisar capturas a 390 y 1440 px en ambos temas y axe sin violaciones nuevas.

## Decisiones que tomó Claude (revisar)

1. Licencias como campo `kind` en `leaves` (sin tocar Supabase).
2. Licencias sin saldo y sin descontar vacaciones; impiden marcar el día como pendiente.
3. "Otra licencia" exige notas.
4. Saldo inicial = fecha + francos disponibles + horas sobrantes; solo cuenta lo posterior a la fecha. Se sincroniza con las reglas.
5. "Tomados" sale de la lista de Compensatorio (registros con fecha tomada). La app no crea francos sola.
6. Navegación: Período · Calendario · Saldos · Resumen · Más. La calculadora vive en Más y se abre desde el período.
7. Multiplicadores fijos 1,5 y 2; valor hora privado del dispositivo.
8. El Resumen anual también pasa a mostrar solo extras.
9. PDF, texto y Excel para RRHH siguen mostrando horas normales.

## Para quien construye

- Nombres de componentes, ubicación exacta de funciones nuevas y el icono de Saldos.
- Si `AbsenceForm` se exporta o se extrae a su propio archivo.
- Copys menores no fijados acá, respetando el tono del resto de la app.
- Orden sugerido de entrega (un commit por parte): 1 licencias → 2 contador → 3 saldos → 4 calculadora → 5 estadísticas → verificación E2E.
