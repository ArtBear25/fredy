@echo off
setlocal
cd /d "%~dp0"
title Fredy Bewerbungsmodul
set "PORT=%BEWERBUNGSMODUL_PORT%"
if not defined PORT set "PORT=8765"

echo Starte Bewerbungsmodul auf http://127.0.0.1:%PORT% ...
powershell.exe -NoLogo -NoProfile -WindowStyle Hidden -Command "$url = 'http://127.0.0.1:%PORT%'; try { $health = Invoke-RestMethod -Uri ($url + '/api/v1/health') -TimeoutSec 2; if ($health.status -eq 'ok') { exit 0 } } catch {}; exit 1"
if not errorlevel 1 (
  echo.
  echo Bewerbungsmodul laeuft bereits auf Port %PORT%.
  echo Es wird keine alte Instanz still weiterverwendet und keine zweite gestartet.
  echo Beende zuerst die laufende Instanz und starte danach dieses Fenster erneut.
  echo.
  pause
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" (
  python -m venv .venv
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
fc /b "requirements-lock.txt" ".venv\requirements-lock.txt" >nul 2>&1
if errorlevel 1 (
  ".venv\Scripts\python.exe" -m pip install --index-url https://pypi.org/simple -r requirements-lock.txt
  if errorlevel 1 (
    pause
    exit /b 1
  )
  copy /y "requirements-lock.txt" ".venv\requirements-lock.txt" >nul
)
start "" /b powershell.exe -NoLogo -NoProfile -WindowStyle Hidden -Command "$port = if ($env:BEWERBUNGSMODUL_PORT) { $env:BEWERBUNGSMODUL_PORT } else { '8765' }; $url = 'http://127.0.0.1:' + $port; for ($attempt = 0; $attempt -lt 60; $attempt++) { try { $response = Invoke-WebRequest -Uri ($url + '/api/v1/health') -UseBasicParsing -TimeoutSec 1; if ($response.StatusCode -eq 200) { Start-Process $url; exit 0 } } catch {}; Start-Sleep -Milliseconds 500 }; exit 1"
".venv\Scripts\python.exe" -m app.main
pause
