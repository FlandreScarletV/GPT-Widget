@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0internal\codex-model-inspector\Configure-Key.ps1"
if errorlevel 1 pause
