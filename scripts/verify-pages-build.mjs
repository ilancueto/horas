// Verifica que `dist` respete la base pública con la que se construyó la app.
// Uso: node scripts/verify-pages-build.mjs <base>   (por ejemplo /horas/ o /)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const base = process.argv[2] ?? '/'
const dist = join(process.cwd(), 'dist')
const errors = []

if (!base.startsWith('/') || !base.endsWith('/'))
  errors.push(`la base debe empezar y terminar con "/" (recibida: ${base})`)

function read(file) {
  try {
    return readFileSync(join(dist, file), 'utf8')
  } catch {
    errors.push(`no se pudo leer dist/${file} (¿corriste el build?)`)
    return null
  }
}

const html = read('index.html')
if (html !== null) {
  if (!html.includes(`"${base}assets/`)) errors.push(`index.html no referencia ${base}assets/`)
  if (base !== '/' && /(?:src|href)="\/assets\//.test(html))
    errors.push('index.html todavía referencia /assets/ en la raíz del dominio')
}

const manifestText = read('manifest.webmanifest')
if (manifestText !== null) {
  let manifest = null
  try {
    manifest = JSON.parse(manifestText)
  } catch {
    errors.push('manifest.webmanifest no es JSON válido')
  }
  if (manifest) {
    for (const key of ['id', 'start_url', 'scope'])
      if (manifest[key] !== base)
        errors.push(`manifest.${key} es ${JSON.stringify(manifest[key])}, se esperaba "${base}"`)
    const urls = [
      ...(manifest.icons ?? []).map((icon) => ['icons[].src', icon.src]),
      ...(manifest.shortcuts ?? []).flatMap((shortcut) => [
        ['shortcuts[].url', shortcut.url],
        ...(shortcut.icons ?? []).map((icon) => ['shortcuts[].icons[].src', icon.src]),
      ]),
    ]
    if (urls.length === 0) errors.push('manifest.webmanifest no tiene íconos ni atajos')
    for (const [where, url] of urls)
      if (typeof url !== 'string' || !url.startsWith(base))
        errors.push(`manifest ${where} = ${JSON.stringify(url)} no empieza con "${base}"`)
  }
}

const sw = read('sw.js')
if (sw !== null) {
  if (!sw.includes(`"${base}index.html"`))
    errors.push(`sw.js no usa "${base}index.html" como navigateFallback`)
  if (!/importScripts\([^)]*notifications\.js/.test(sw))
    errors.push('sw.js no importa notifications.js')
}

if (errors.length > 0) {
  console.error(`verify-pages-build: FALLA para la base "${base}":`)
  for (const error of errors) console.error('  - ' + error)
  process.exit(1)
}
console.log(`verify-pages-build: OK para la base "${base}"`)
