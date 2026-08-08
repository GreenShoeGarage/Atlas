@echo off
setlocal
set "ATLAS_DIR=%~dp0"
set "ATLAS_ROOT=%CD%"
if not "%~1"=="" (
  set "ATLAS_ROOT=%~1"
  shift
)
node "%ATLAS_DIR%atlas-bridge.js" --allow-root "%ATLAS_ROOT%" --app "%ATLAS_DIR%atlas-v1.0.0.html" %*
endlocal
