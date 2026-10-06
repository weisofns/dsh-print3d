@echo off
rem DSH 3D printing - printer settings window launcher
rem Requires Windows PowerShell 5.1 (built into Windows).
setlocal
cd /d "%~dp0"
set "PS1=%~dp0printer-setup.ps1"

if not exist "%PS1%" (
  echo [!] printer-setup.ps1 not found next to this launcher.
  pause
  exit /b 1
)

powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%PS1%"
if errorlevel 1 (
  echo.
  echo [!] The settings window exited with an error.
  pause
)
endlocal
