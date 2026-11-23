@echo off
rem Levanta Horas en http://127.0.0.1:5180 y abre el navegador.
cd /d "%~dp0"
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 5180 -State Listen -ErrorAction SilentlyContinue) { exit 1 }"
if errorlevel 1 (
  echo Horas ya esta corriendo.
) else (
  if not exist node_modules call npm install
  start "Horas (servidor)" /min cmd /c "npm run dev -- --port 5180 --strictPort"
  powershell -NoProfile -Command "for ($i=0; $i -lt 60; $i++) { if (Get-NetTCPConnection -LocalPort 5180 -State Listen -ErrorAction SilentlyContinue) { exit 0 }; Start-Sleep -Milliseconds 500 }; exit 1"
)
start "" http://127.0.0.1:5180
