@echo off
cd /d "%~dp0"
echo Starting Wix Sync Server...
node sync-server.js
pause
