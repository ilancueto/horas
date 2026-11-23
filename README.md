# Horas

Registro personal de jornadas, horas extra y períodos de pago. Funciona en español rioplatense, con fecha y hora de Buenos Aires. Se puede usar solo con el almacenamiento del dispositivo o sincronizar varios dispositivos por Supabase.

## Arrancar en la compu

Usá Node.js 24 LTS.

```sh
npm ci
npm run dev
```

Abrí la dirección que indica Vite. En el primer uso elegí **Importar mi Excel** o **Empezar de cero**. La planilla original se conserva en tu carpeta y está excluida de Git y del sitio publicado. La app lee el archivo localmente cuando lo elegís.

Para probar la PWA de producción:

```sh
npm run build
npm run preview -- --port 47683
```

## Instalar en el celular o la compu

1. Publicá la app por HTTPS y abrila una vez con conexión. Esperá a que termine de cargar.
2. En Android, abrí el menú de Chrome y elegí **Instalar aplicación** o **Agregar a la pantalla principal**. En iPhone, abrí Safari y elegí **Compartir → Agregar a pantalla de inicio**. En Chrome o Edge de escritorio, usá el botón de instalación de la barra de direcciones o del menú.
3. Abrila desde el ícono. En los sistemas que admiten accesos directos del manifest, **Cargar hoy** abre la jornada actual.

El service worker guarda la aplicación, las tipografías y los módulos de importación/exportación. Las jornadas quedan en IndexedDB. Cada origen tiene su propio almacenamiento. Si cambiás de dirección, migrá los datos con un JSON o con la misma cuenta de Supabase. Los recordatorios requieren permiso de notificaciones y se comprueban mientras Horas está abierta. Los navegadores no ofrecen programación local fiable con la PWA totalmente cerrada.

## Importar, exportar y respaldar

- En **Más → Archivos y respaldo**, podés importar otra planilla, exportar XLSX o bajar un JSON. Antes de confirmar el Excel, revisá el resumen de la importación. Se conservan las ediciones locales de registros que ya existen.
- Las dos hojas con jornadas de la planilla de referencia se incorporan con 49 filas con datos. El segundo período tenía el cierre en blanco, por lo que se propone un cierre editable que cubre la última carga. Las hojas de plantilla sin datos se omiten.
- La vista previa contrasta los valores guardados en Excel con los valores recalculados usando sus feriados y su redondeo por fila. Los totales de noviembre y diciembre coinciden con ese método. En los períodos importados, el decimal del período, la conciliación y el PDF usan el redondeo por fila de Excel. La duración en h:mm conserva los minutos exactos. **Totales de la planilla original** permite comparar ambas formas de sumar.
- En el período, **Resumen para RRHH** ofrece texto copiable y dos PDF imprimibles. Los importes de pago y la conciliación quedan locales y se excluyen de las descargas por defecto. Podés incluirlos explícitamente en el backup JSON.
- **Restaurar backup** valida el archivo antes de mostrar la confirmación. Descargá un respaldo previo desde el diálogo. Los respaldos son archivos de lectura directa, incluso cuando el cifrado en la nube está activo.

Los feriados de 2026 incluyen los días turísticos publicados para ese año. Para 2027 se aplican las reglas de los feriados nacionales de la Ley 27.399. Podés agregar fechas extraordinarias desde **Feriados**. [Ley 27.399](https://www.argentina.gob.ar/normativa/nacional/ley-27399-281835/texto) · [Calendario oficial](https://www.argentina.gob.ar/feriados) · [Resolución 164/2025](https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-164-2025-421799)

## Licencias, saldos y calculadora de extras

- **Licencias**: en **Más → Licencias** cargás licencias por enfermedad, por mudanza u otras, con su rango de fechas. Se ven en el calendario, en el resumen anual y en el resumen para RRHH, cada una con su color.
- **Saldos**: la pestaña muestra los francos compensatorios disponibles (ganados con cada 8 h acumuladas al 100%, menos los tomados) y los días de vacaciones del año. Desde **Cargar saldo inicial** podés partir de los francos y las horas al 100% que ya tenías antes de usar la app. El saldo inicial se sincroniza con las reglas de cálculo.
- **Calculadora de extras**: en **Más → Calculadora de extras** elegís un período y ves cuánto suman las horas al 50% y al 100% con tu valor hora. Es una estimación con las horas decimales del período.
- El contador del período y el resumen anual muestran solo horas extra. El resumen para RRHH y los archivos exportados siguen mostrando las horas normales.
- El valor hora queda solo en el dispositivo: no entra en las exportaciones ni en la sincronización, salvo que lo incluyas a propósito en el backup JSON.
- Antes de usar Licencias, actualizá la app en todos tus dispositivos: uno con una versión vieja descarta el tipo de licencia y la lee como vacaciones.
- Un dispositivo con una versión vieja que guarde las reglas puede borrar el saldo inicial, y uno nuevo que después baje y edite las reglas puede pisarlo en los demás. Si pasa, volvé a cargarlo desde Ajustes.

## Activar Supabase

1. Creá un proyecto en Supabase. En **SQL Editor**, ejecutá el archivo de `supabase/migrations/`. Si preferís la CLI, autenticá la CLI, vinculá el proyecto con `supabase link --project-ref TU_REFERENCIA` y aplicá la migración con `supabase db push`. Usá una sola de las dos vías.
2. Copiá la URL HTTPS del proyecto y la **clave publicable** desde **Connect** o **Settings → API Keys**. Copiá `.env.example` a `.env.local` y cargá `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY`. Estas dos variables se incorporan al build. Usá exclusivamente una clave de cliente publicable.
3. En **Authentication → URL Configuration**, ingresá tu URL de producción como **Site URL** y agregala a **Redirect URLs**. Para pruebas locales, agregá las URLs que uses, por ejemplo `http://127.0.0.1:5173/` y `http://127.0.0.1:47683/`. El proveedor Email tiene que estar activo. Para enviar enlaces a cuentas fuera de tu equipo, revisá la configuración SMTP y los límites de envío de tu proyecto.
4. Reiniciá Vite o volvé a desplegar. Abrí **Más → Sincronización**, pedí el link de acceso y abrilo en el mismo dispositivo. Repetí el ingreso con el mismo correo en el otro dispositivo. Si ambos ya tienen datos, confirmá la fusión.
5. Opcionalmente, activá el cifrado con una frase desde **Más → Sincronización**. Necesitás esa frase al abrir una nueva sesión. Los registros ya subidos se cifran al activar la opción. Guardá la frase en un lugar seguro. Sin ella, no se pueden recuperar los registros cifrados de la nube.

Se sincronizan períodos, jornadas, días especiales, licencias y reglas de cálculo (incluido el saldo inicial de compensatorios). El PIN, tema, recordatorios, conciliación y estimación de pago son de cada dispositivo. El PIN controla la pantalla de acceso. El cifrado AES-GCM protege el contenido JSON de los registros en la nube. El identificador de cuenta, la colección, el identificador de registro y las marcas de sincronización siguen siendo visibles para el servidor. Los IDs estables de jornadas, feriados y períodos se derivan de sus fechas.

Los cambios pendientes conservan su revisión hasta confirmarse. Ante cambios concurrentes del mismo registro gana la última escritura aceptada por el servidor. El servidor conserva los borrados lógicos y reconoce los reintentos de una revisión ya aceptada.

[Enlaces mágicos en Supabase](https://supabase.com/docs/guides/auth/auth-email-passwordless) · [URLs de retorno](https://supabase.com/docs/guides/auth/redirect-urls) · [Realtime](https://supabase.com/docs/guides/realtime/postgres-changes)

## Publicar por HTTPS

- **Cloudflare Pages**. Conectá el repositorio al crear el proyecto. Comando `npm run build`, directorio de salida `dist` y Node 24. Cargá las variables de Supabase en la configuración del build si querés sincronización.
- **Vercel**. Importá el repositorio con el framework **Vite**. El archivo `vercel.json` deja configurados el comando, la salida y la política de actualización del service worker. Si usás nube, cargá las dos variables en el entorno que vas a publicar.
- En ambos casos, si cambia el dominio, actualizá la URL de retorno de Supabase y volvé a instalar la PWA desde el dominio definitivo.

[Cloudflare Pages](https://developers.cloudflare.com/pages/framework-guides/) · [Vite en Vercel](https://vercel.com/docs/frameworks/frontend/vite)

## Verificación

```sh
npm run lint
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
```

Vitest prueba las franjas de horas, fechas, ausencias, importación, persistencia, cola, cifrado y la migración con PostgreSQL embebido. Playwright recorre la compilación de producción en escritorio (1440 px) y celular emulado (390 px), captura ambos temas, verifica accesibilidad, comprueba el manifest y prueba el acceso directo con la red desconectada. Se simulan dos perfiles de navegador con Supabase, incluyendo Realtime, reconexión y fusión, porque el repositorio no trae credenciales de un proyecto real. Las pruebas con la planilla privada se omiten únicamente cuando el archivo no está en la carpeta del proyecto.
