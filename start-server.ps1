# Start local server for testing
Write-Host "Starting local server on http://localhost:8080" -ForegroundColor Green
Write-Host "Press Ctrl+C to stop" -ForegroundColor Yellow
Write-Host ""

# Change to script directory
Set-Location $PSScriptRoot

# Try Python
try {
    python -m http.server 8080
} catch {
    Write-Host "Python not found. Please install Python or use another HTTP server." -ForegroundColor Red
}
