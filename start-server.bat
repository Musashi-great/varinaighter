@echo off
echo Starting local server on http://localhost:8080
echo Press Ctrl+C to stop

REM Try Python 3 first
python -m http.server 8080 2>nul
if %errorlevel% neq 0 (
    REM Try Python 2
    python -m SimpleHTTPServer 8080 2>nul
)

pause
