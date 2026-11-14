# scripts/show-db-target.ps1
# Prints the target host and database name of DATABASE_URL and DIRECT_URL
# in the current PowerShell session.
# NEVER prints usernames, passwords, or secrets.
#
# Usage:
#   .\scripts\show-db-target.ps1

function Show-Target {
    param(
        [string]$VarName,
        [string]$Url
    )

    if (-not $Url) {
        Write-Host "  ${VarName}: [NOT SET / EMPTY]" -ForegroundColor DarkGray
        return
    }

    try {
        # Extract host and database safely without exposing user or password
        $match = [regex]::Match($Url, '@([^:/]+)(?::(\d+))?/([^?]+)')
        if ($match.Success) {
            $hostName = $match.Groups[1].Value
            $port = if ($match.Groups[2].Value) { ":$($match.Groups[2].Value)" } else { "" }
            $dbName = $match.Groups[3].Value

            $color = if ($hostName -eq "localhost" -or $hostName -eq "127.0.0.1") {
                "Yellow"
            } else {
                "Green"
            }

            Write-Host "  ${VarName} Target:" -ForegroundColor Cyan
            Write-Host "    Host:     $hostName$port" -ForegroundColor $color
            Write-Host "    Database: $dbName" -ForegroundColor $color

            if ($hostName -eq "localhost" -or $hostName -eq "127.0.0.1") {
                Write-Host "    [NOTICE] Targets LOCAL database." -ForegroundColor Yellow
            } else {
                Write-Host "    [NOTICE] Targets REMOTE / MANAGED database." -ForegroundColor Green
            }
        } else {
            # Fallback to Uri parser
            $uri = [System.Uri]$Url
            Write-Host "  ${VarName} Target:" -ForegroundColor Cyan
            Write-Host "    Host:     $($uri.Host)" -ForegroundColor Green
            Write-Host "    Database: $($uri.AbsolutePath.TrimStart('/'))" -ForegroundColor Green
        }
    } catch {
        Write-Host "  ${VarName}: [Could not parse URL format]" -ForegroundColor Red
    }
}

Write-Host "`n=== Database Targets in Current Session ===" -ForegroundColor Cyan
Show-Target -VarName "DATABASE_URL" -Url $env:DATABASE_URL
Show-Target -VarName "DIRECT_URL"   -Url $env:DIRECT_URL
Write-Host ""
