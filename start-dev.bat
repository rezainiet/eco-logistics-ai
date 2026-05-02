@echo off
REM Quick-start helper for the ecommerce-logistics monorepo dev server.
REM Web app runs on http://localhost:3001 (port 3000 left to your other project).
REM API runs on http://localhost:4000.

echo Starting ecommerce-logistics dev servers...
echo   Web:  http://localhost:3001
echo   API:  http://localhost:4000
echo.

REM Free anything stuck on 3001 from a previous run (best-effort, ignore failures).
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING') do taskkill /F /PID %%a 2>nul

cd /d "%~dp0"
call npm run dev
