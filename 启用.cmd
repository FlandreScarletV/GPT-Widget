@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0internal\GPTWidget\Bootstrap.ps1" -Mode Enable
if errorlevel 1 pause
