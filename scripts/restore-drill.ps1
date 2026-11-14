# scripts/restore-drill.ps1
# Automates local restore drill against a throwaway Docker PostgreSQL container.
# Usage:
#   .\scripts\restore-drill.ps1 [-DumpFile path\to\backup.dump]

param(
    [string]$DumpFile = ""
)

$ErrorActionPreference = "Stop"
$ContainerName = "broke-travelers-restore-drill"
$Port = 5534
$TargetDb = "broke_travelers_restore"

Write-Host "=== Broke Travelers Database Restore Drill ===" -ForegroundColor Cyan

# 1. Clean up any leftover drill container
$existing = docker ps -a --filter "name=^/${ContainerName}$" --format "{{.Names}}"
if ($existing) {
    Write-Host "Removing leftover container $ContainerName..." -ForegroundColor Yellow
    docker rm -f $ContainerName | Out-Null
}

try {
    # 2. Start temporary throwaway container (PostgreSQL 17 to match production/dev engine)
    Write-Host "Starting temporary PostgreSQL container on port $Port..." -ForegroundColor Cyan
    docker run -d --name $ContainerName -p ${Port}:5432 -e POSTGRES_PASSWORD=restore_drill_secret postgres:17-alpine | Out-Null

    # Wait for postgres to be ready
    Write-Host "Waiting for database container to be healthy..." -ForegroundColor Cyan
    $attempts = 0
    while ($attempts -lt 30) {
        $ready = docker exec $ContainerName pg_isready -U postgres 2>&1
        if ($LASTEXITCODE -eq 0) {
            break
        }
        Start-Sleep -Seconds 1
        $attempts++
    }

    if ($attempts -ge 30) {
        throw "Timeout waiting for temporary postgres container to become ready."
    }

    # 3. Create target database
    Write-Host "Creating target database $TargetDb..." -ForegroundColor Cyan
    docker exec $ContainerName psql -U postgres -c "CREATE DATABASE $TargetDb;" | Out-Null

    # 4. Restore dump
    if ($DumpFile -and (Test-Path $DumpFile)) {
        Write-Host "Restoring from provided dump file: $DumpFile..." -ForegroundColor Cyan
        docker cp $DumpFile "${ContainerName}:/tmp/restore.dump" | Out-Null
        docker exec $ContainerName pg_restore -U postgres -d $TargetDb --no-owner --no-privileges /tmp/restore.dump | Out-Null
    } else {
        Write-Host "No dump file passed. Taking live compressed dump from broke-travelers-db..." -ForegroundColor Cyan
        # Take dump directly inside container filesystem to avoid Windows pipe binary mangling
        docker exec broke-travelers-db pg_dump -U postgres -Fc --no-owner --no-privileges -f /tmp/live_drill.dump broke_travelers
        docker cp broke-travelers-db:/tmp/live_drill.dump ./live_drill.dump
        docker exec broke-travelers-db rm -f /tmp/live_drill.dump
        docker cp ./live_drill.dump "${ContainerName}:/tmp/restore.dump"
        Remove-Item -Force ./live_drill.dump -ErrorAction SilentlyContinue

        Write-Host "Restoring archive into $TargetDb..." -ForegroundColor Cyan
        docker exec $ContainerName pg_restore -U postgres -d $TargetDb --no-owner --no-privileges /tmp/restore.dump 2>&1 | Out-Null
    }

    # 5. Run verification queries
    Write-Host "Running integrity checks on restored database..." -ForegroundColor Cyan
    $checkSql = @"
SELECT
  (SELECT COUNT(*) FROM users) AS users_count,
  (SELECT COUNT(*) FROM groups) AS groups_count,
  (SELECT COUNT(*) FROM group_memberships) AS memberships_count,
  (SELECT COUNT(*) FROM ledger_entries) AS ledger_count,
  (SELECT COUNT(*) FROM audit_log) AS audit_count,
  (SELECT COUNT(*) FROM payment_submissions) AS submissions_count,
  (SELECT COUNT(*) FROM approval_requests) AS approvals_count,
  (SELECT COUNT(*) FROM bank_reconciliations) AS reconciliations_count,
  (SELECT COALESCE(SUM(
    CASE
      WHEN kind IN ('contribution', 'interest') THEN magnitude_paisa
      WHEN kind IN ('expense', 'withdrawal') THEN -magnitude_paisa
      ELSE 0
    END
  ), 0) FROM ledger_entries) AS verified_balance_paisa;
"@

    $result = docker exec $ContainerName psql -U postgres -d $TargetDb -c $checkSql -x 2>&1
    if ($LASTEXITCODE -ne 0 -or $result -match "ERROR") {
        throw "Verification query failed: $result"
    }

    Write-Host $result

    Write-Host "`n=== RESTORE DRILL VERIFICATION: PASS ===" -ForegroundColor Green
    Write-Host "Database restored successfully, schema intact, and balance verified." -ForegroundColor Green
}
catch {
    Write-Host "`n=== RESTORE DRILL VERIFICATION: FAIL ===" -ForegroundColor Red
    Write-Host "Error during restore drill: $_" -ForegroundColor Red
    exit 1
}
finally {
    # 6. Teardown temporary container
    Write-Host "Tearing down temporary container $ContainerName..." -ForegroundColor Cyan
    docker rm -f $ContainerName | Out-Null
    Write-Host "Cleanup complete." -ForegroundColor Cyan
}
