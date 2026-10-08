# Post-reboot verification for Josh Enterprises local hosting.
# Run after reboot: powershell -ExecutionPolicy Bypass -File scripts\verify-docker.ps1
$fail = $false

Write-Host "--- WSL ---"
wsl --version 2>&1 | Select-Object -First 5
wsl --list --verbose 2>&1 | Select-Object -First 8

Write-Host "--- Docker ---"
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' --version 2>&1
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' ps 2>&1 | Select-Object -First 5
if ($LASTEXITCODE -ne 0) {
  Write-Host "Daemon not running — open Docker Desktop and wait for green status, then re-run this script."
  $fail = $true
}

if (-not $fail) {
  Write-Host "--- Compose smoke ---"
  Set-Location (Join-Path $PSScriptRoot "..")
  & 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' compose -f docker-compose.yml up -d --build 2>&1 | Select-Object -Last 10
  Start-Sleep -Seconds 10
  try {
    Invoke-RestMethod http://localhost:3000/health | Format-Table | Out-String | Write-Host
    Invoke-RestMethod http://localhost:4000/health | Format-Table | Out-String | Write-Host
    Write-Host "HOSTED OK"
  } catch {
    Write-Host "Smoke test failed: $_"
  }
}
