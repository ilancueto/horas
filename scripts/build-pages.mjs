// Compila la app bajo la base de GitHub Pages (`/horas/`) en `dist-pages/`, sin tocar `dist/`.
// La usa la prueba de humo de Playwright (`tests/pages.e2e.ts`). Se fija `VITE_BASE` desde Node
// para que funcione igual en PowerShell, cmd, Git Bash (que reescribe `/horas/`) y Linux.
import { build } from 'vite'

process.env.VITE_BASE = '/horas/'
await build({ build: { outDir: 'dist-pages', emptyOutDir: true } })
