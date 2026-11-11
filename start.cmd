@echo off
rem Starts the database-diff web app on http://127.0.0.1:4870/ and opens it in the browser.
rem (Working on the app itself? "npm run dev" restarts it whenever its code changes.)
cd /d "%~dp0"
rem Runs older than this many days are deleted when the app starts, and once a day while it runs
rem (the newest 20 are always kept). 90 is the default; 0 keeps everything. Remove "rem" to change it:
rem set DATABASE_DIFF_RETENTION_DAYS=90
node app\server.js --open
pause
