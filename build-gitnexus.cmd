@echo off
setlocal
powershell -ExecutionPolicy Bypass -File "%~dp0scripts\build-gitnexus.ps1"
exit /b %errorlevel%
