@echo off
cd /d "%~dp0bot"
call npm install --no-fund --no-audit
echo.
echo Done. Now create bot\.env (copy from .env.example) and run test.bat
pause
