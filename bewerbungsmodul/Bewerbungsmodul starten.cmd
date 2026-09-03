@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" python -m venv .venv
call ".venv\Scripts\activate.bat"
python -m pip install -e ".[dev]"
if errorlevel 1 pause & exit /b 1
python -m app.main
pause
