@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0internal\GPTWidget\Clean-Copies.ps1" -Interactive
pause
