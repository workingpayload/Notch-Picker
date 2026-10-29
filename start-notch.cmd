@echo off
rem Starts Notch Picker without keeping a console window open.
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" call npm install
start "" "node_modules\electron\dist\electron.exe" .
