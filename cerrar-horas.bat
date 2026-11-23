@echo off
rem Frena el servidor de Horas (puerto 5180) y cierra su ventana.
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 5180 -State Listen -ErrorAction SilentlyContinue; if (-not $c) { Write-Host 'Horas no estaba corriendo.'; exit 0 }; foreach ($p in ($c.OwningProcess | Sort-Object -Unique)) { taskkill /PID $p /T /F | Out-Null }; Write-Host 'Horas cerrado.'"
