@echo off
rem Synapse : double-clique sur ce fichier pour ouvrir l'application.
setlocal
title Synapse
set "NODE="
rem Node.js: PATH first, else the newest portable install (last folder in name order)
for /f "delims=" %%i in ('where node.exe 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE for /d %%d in ("%LOCALAPPDATA%\Programs\nodejs\*") do if exist "%%~d\node.exe" set "NODE=%%~d\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE (
  echo.
  echo   Synapse a besoin de Node.js pour fonctionner, gratuit.
  echo   La page de telechargement va s'ouvrir : choisis la version LTS,
  echo   installe-la, puis relance Synapse.
  echo.
  start "" "https://nodejs.org/fr/download"
  pause
  exit /b 1
)
"%NODE%" "%~dp0app\scripts\synapse.mjs" %*
if errorlevel 1 (
  echo.
  pause
)
