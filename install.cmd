@echo off
setlocal

set "SCRIPT_URL=https://raw.githubusercontent.com/goatcitadel/GoatCitadel/main/install.ps1"
set "TEMP_SCRIPT=%TEMP%\goatcitadel-install-%RANDOM%.ps1"

echo Downloading GoatCitadel installer...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing -Uri '%SCRIPT_URL%' -OutFile '%TEMP_SCRIPT%'"
if errorlevel 1 (
  echo Failed to download installer from %SCRIPT_URL%
  exit /b 1
)

echo Running GoatCitadel installer...
powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP_SCRIPT%" %*
set "EXIT_CODE=%ERRORLEVEL%"

del /f /q "%TEMP_SCRIPT%" >nul 2>nul
exit /b %EXIT_CODE%
