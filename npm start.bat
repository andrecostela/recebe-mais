@echo off
title Servidor Node.js - localhost:3000

echo.
echo ========================================
echo    Iniciando servidor...
echo ========================================
echo.

cd /d "%~dp0"

start "" http://localhost:3000

npm start

pause