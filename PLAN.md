# Plan de Horas

## Stack y estructura

- React, Vite, TypeScript estricto, Tailwind, Dexie, Zustand y Zod.
- `src/domain` para fechas civiles, cálculos y validación. `src/data` para IndexedDB, planillas, backups y sincronización. `src/ui` para componentes y vistas. `supabase/migrations` para SQL. `tests` para Playwright.
- Registros de períodos (UUID, desde, hasta, estado), jornadas (fecha, minutos, guardia y notas), compensatorios, vacaciones y feriados. Preferencias versionadas. Fechas civiles ISO, sumas en minutos enteros. Cola persistente con tombstones y marcas de tiempo del servidor.

## Diseño

Libreta de trabajo con tipografía editorial, superficies de papel cálido y tinta azul petróleo. El período y sus totales orientan la pantalla, seguidos de la grilla y los filtros. La carga rápida es la acción principal. Entrada breve de las vistas, transición de estados de guardado y hoja móvil con movimiento reducido según preferencias.

## Checklist

- [x] 1. Base, tokens claro/oscuro, componentes, navegación adaptable, tipografía, iconos, accesibilidad, estados de carga/vacío/error y movimiento.
- [x] 2. Fechas civiles, períodos encadenados, fecha de pago, estados y bloqueo, cálculo por franjas y feriados, cruces de medianoche, descanso, totales, guardias, validaciones y unitarios solicitados.
- [x] 3. Dexie, migraciones, Zod, autoguardado, grilla/tarjetas, Hoy, horario estándar, copiar día anterior, pendientes, calendario, vista anual y estadísticas.
- [x] 4. Compensatorio, vacaciones, feriados editables y nacionales 2026–2027, solapamientos, saldos y colores.
- [x] 5. Excel con vista previa y reimportación idempotente, contraste de totales, exportación XLSX, PDF para RRHH y período, texto copiable, backup JSON, restauración y aviso.
- [x] 6. Conciliación, estimador privado, recordatorios opt-in, atajos, búsqueda/filtros, deshacer/rehacer, onboarding, ajustes, PIN, borrado con backup y ayuda.
- [x] 7. Supabase opcional con link mágico, RLS, Realtime, cola/backoff, tombstones, fusión inicial, estado/sincronización manual, cifrado opcional y pruebas de dos sesiones reales o simuladas.
- [x] 8. PWA instalable, acceso Cargar hoy, offline, README de instalación/despliegue/Supabase/backups, lint, tipos, Vitest, E2E, build y verificación visual a 390 y 1440 px en temas claro/oscuro.
- [x] Revisiones Playwright móvil/escritorio y dos iteraciones visuales en pantallas principales. Un commit por etapa.

## Decisiones

- Se conserva el HTML previo como referencia de trabajo fuera del bundle y la planilla original queda fuera de Git y de la publicación.
- Zona civil argentina representada por `America/Argentina/Buenos_Aires` al determinar hoy. UTC solo para aritmética civil a través de días ordinales.
- Si una jornada no tiene suficientes horas al 50% para cubrir el descanso, se descuenta el saldo de las horas al 100% para mantener la igualdad entre categorías y total.
- Estimador y conciliación locales. El backup puede incluirlos si se opta expresamente.

- El archivo tenía dos períodos con datos y 49 jornadas con cargas o marcas. Se omitieron las hojas de plantilla vacías. Se propuso 14/12/2026 para el cierre que estaba en blanco.
- El decimal de cada período importado se calcula con el redondeo por jornada de Excel. La duración en h:mm se calcula en minutos exactos. Noviembre coincide en 171,42 h y diciembre en 62,66 h según la convención de la planilla.
- El cifrado protege el JSON de registros en Supabase. Los identificadores y marcas de sincronización son metadatos visibles. La conciliación y el valor hora quedan fuera de la nube.
- Los avisos locales se comprueban mientras la app está abierta. La compatibilidad de programación en segundo plano varía entre navegadores.

## Evidencia

- Pruebas de cálculo, importación y reimportación, cola, cifrado y políticas SQL en PostgreSQL embebido.
- Playwright con la compilación de producción en Chromium a 390 y 1440 px, en temas claro y oscuro. Se corrigieron el selector de período cortado, el etiquetado de pendientes, la jerarquía del resumen y la señal de progreso. Se volvieron a capturar las pantallas tras los cambios.
- Instalación y lanzamiento de la PWA en un perfil aislado de Chromium. Se cargó una jornada y se comprobó su persistencia al recargar con la red desactivada.
- Exportación de muestra para RRHH descargada desde la app y revisada con Poppler.
- Prueba con Supabase simulado en dos perfiles independientes. La verificación con un proyecto alojado queda disponible al configurar las variables.
