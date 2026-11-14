# scripts/smoke-test.ps1
# Smoke test script for broke-travelers-api (Local, Staging, or Production).
# Usage:
#   .\scripts\smoke-test.ps1 [-BaseUrl http://localhost:3000] [-TestToken <optional_jwt>]

param(
    [string]$BaseUrl = "http://localhost:3000",
    [string]$TestToken = ""
)

$ErrorActionPreference = "Continue"
$failedCount = 0
$passedCount = 0

function Report-Check {
    param(
        [string]$Name,
        [bool]$Success,
        [string]$Details = ""
    )
    if ($Success) {
        $script:passedCount++
        Write-Host "  [PASS] $Name" -ForegroundColor Green
        if ($Details) {
            Write-Host "         $Details" -ForegroundColor DarkGray
        }
    } else {
        $script:failedCount++
        Write-Host "  [FAIL] $Name" -ForegroundColor Red
        if ($Details) {
            Write-Host "         $Details" -ForegroundColor Red
        }
    }
}

Write-Host "`n=== Broke Travelers API Smoke Test ===" -ForegroundColor Cyan
Write-Host "Target Base URL: $BaseUrl" -ForegroundColor Cyan
if ($TestToken) {
    Write-Host "Authenticated test token provided." -ForegroundColor Cyan
}

# 1. Shallow Liveness Check: GET /v1/health
try {
    $resHealth = Invoke-WebRequest -Uri "$BaseUrl/v1/health" -Method Get -SkipHttpErrorCheck -TimeoutSec 10
    $body = $resHealth.Content | ConvertFrom-Json
    $is200 = $resHealth.StatusCode -eq 200
    $isOk = $body.status -eq "ok"
    Report-Check -Name "GET /v1/health returns 200 with { status: 'ok' }" -Success ($is200 -and $isOk) -Details "Status: $($resHealth.StatusCode), Body: $($resHealth.Content.Trim())"
} catch {
    Report-Check -Name "GET /v1/health returns 200 with { status: 'ok' }" -Success $false -Details $_.Exception.Message
}

# 2. Deep Readiness Check: GET /v1/health/ready
try {
    $resReady = Invoke-WebRequest -Uri "$BaseUrl/v1/health/ready" -Method Get -SkipHttpErrorCheck -TimeoutSec 10
    $bodyReady = $resReady.Content | ConvertFrom-Json
    $is200Ready = $resReady.StatusCode -eq 200
    $isReady = $bodyReady.status -eq "ready"
    Report-Check -Name "GET /v1/health/ready returns 200 with { status: 'ready' }" -Success ($is200Ready -and $isReady) -Details "Status: $($resReady.StatusCode), Body: $($resReady.Content.Trim())"
} catch {
    Report-Check -Name "GET /v1/health/ready returns 200 with { status: 'ready' }" -Success $false -Details $_.Exception.Message
}

# 3. Unauthenticated Access Protection: GET /v1/profile -> 401 unauthenticated
try {
    $resAuth = Invoke-WebRequest -Uri "$BaseUrl/v1/profile" -Method Get -SkipHttpErrorCheck -TimeoutSec 10
    $bodyAuth = $resAuth.Content | ConvertFrom-Json
    $is401 = $resAuth.StatusCode -eq 401
    $isUnauthCode = $bodyAuth.error.code -eq "unauthenticated"
    Report-Check -Name "GET /v1/profile (unauthenticated) returns 401 with code 'unauthenticated'" -Success ($is401 -and $isUnauthCode) -Details "Status: $($resAuth.StatusCode), Error: $($bodyAuth.error.code)"
} catch {
    Report-Check -Name "GET /v1/profile (unauthenticated) returns 401 with code 'unauthenticated'" -Success $false -Details $_.Exception.Message
}

# 4. Security Headers Verification
try {
    $resSec = Invoke-WebRequest -Uri "$BaseUrl/v1/health" -Method Get -SkipHttpErrorCheck -TimeoutSec 10
    # PowerShell may return an array for multi-value headers; join to get a comparable string
    $ctoRaw = $resSec.Headers["X-Content-Type-Options"]
    $cto = if ($ctoRaw -is [array]) { $ctoRaw -join ', ' } else { [string]$ctoRaw }
    $hasNosniff = ($cto -eq "nosniff")
    $hasNoPoweredBy = (-not $resSec.Headers.ContainsKey("X-Powered-By"))
    
    Report-Check -Name "Security Header: X-Content-Type-Options: nosniff" -Success $hasNosniff -Details "Value: '$cto'"
    Report-Check -Name "Security Header: X-Powered-By header is removed" -Success $hasNoPoweredBy -Details "Header present: $(-not $hasNoPoweredBy)"
} catch {
    Report-Check -Name "Security Headers Verification" -Success $false -Details $_.Exception.Message
}

# 5. Optional Authenticated Profile Check
if ($TestToken) {
    try {
        $headers = @{
            "Authorization" = "Bearer $TestToken"
        }
        $resProf = Invoke-WebRequest -Uri "$BaseUrl/v1/profile" -Method Get -Headers $headers -SkipHttpErrorCheck -TimeoutSec 10
        $is200Prof = $resProf.StatusCode -eq 200
        Report-Check -Name "GET /v1/profile (authenticated) returns 200 OK" -Success $is200Prof -Details "Status: $($resProf.StatusCode)"
    } catch {
        Report-Check -Name "GET /v1/profile (authenticated) returns 200 OK" -Success $false -Details $_.Exception.Message
    }
}

Write-Host "`nSummary: $passedCount passed, $failedCount failed" -ForegroundColor $(if ($failedCount -eq 0) { "Green" } else { "Red" })

if ($failedCount -eq 0) {
    Write-Host "=== SMOKE TEST: ALL CHECKS PASSED ===`n" -ForegroundColor Green
    exit 0
} else {
    Write-Host "=== SMOKE TEST: FAILURES DETECTED ===`n" -ForegroundColor Red
    exit 1
}
