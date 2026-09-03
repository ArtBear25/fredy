@echo off
setlocal
cd /d "%~dp0"

where corepack >nul 2>&1
if errorlevel 1 (
    echo Fredy kann nicht gestartet werden: Corepack wurde nicht gefunden.
    pause
    exit /b 1
)

powershell.exe -NoLogo -NoProfile -Command "try { $response = Invoke-WebRequest -Uri 'http://127.0.0.1:9998/' -UseBasicParsing -TimeoutSec 1; if ($response.StatusCode -eq 200) { Start-Process 'http://localhost:9998'; exit 0 } } catch {}; exit 1"
if not errorlevel 1 exit /b 0

start "Fredy Server - Fenster zum Beenden schliessen" /min cmd.exe /k "corepack yarn start:backend"

powershell.exe -NoLogo -NoProfile -Command "$url = 'http://127.0.0.1:9998/'; for ($attempt = 0; $attempt -lt 60; $attempt++) { try { $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 1; if ($response.StatusCode -eq 200) { Start-Process 'http://localhost:9998'; exit 0 } } catch {}; Start-Sleep -Milliseconds 500 }; exit 1"
if errorlevel 1 (
    echo Fredy konnte innerhalb von 30 Sekunden nicht gestartet werden.
    echo Bitte das Fenster "Fredy Server" auf eine Fehlermeldung pruefen.
    pause
    exit /b 1
)

exit /b 0
