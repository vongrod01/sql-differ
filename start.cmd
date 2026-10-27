@echo off
rem Starts the database-diff web app on http://127.0.0.1:4870/ and opens it in the browser.
cd /d "%~dp0"
nodemon app\server.js --open
pause
