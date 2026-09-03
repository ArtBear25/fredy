@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" python -m venv .venv
call ".venv\Scripts\activate.bat"
python -m pip install -e ".[dev]"
if errorlevel 1 pause & exit /b 1
start "" /b powershell.exe -NoLogo -NoProfile -WindowStyle Hidden -Command "$url = 'http://127.0.0.1:8765'; for ($attempt = 0; $attempt -lt 60; $attempt++) { try { $response = Invoke-WebRequest -Uri ($url + '/api/v1/health') -UseBasicParsing -TimeoutSec 1; if ($response.StatusCode -eq 200) { Start-Process $url; exit 0 } } catch {}; Start-Sleep -Milliseconds 500 }; exit 1"
python -m app.main
pause
