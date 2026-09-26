@echo off
rem Runs Jarvis straight from the sources in this folder, so edits apply live (sandbox mode).
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
