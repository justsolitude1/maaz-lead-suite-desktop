# Lets another PC on your network use this machine's LM Studio for drafting.
#
# Run from an ADMIN PowerShell:
#   powershell -ExecutionPolicy Bypass -File setup-lan-sharing.ps1
#
# It is safe to run twice - it checks before it changes anything.
# To undo, see the bottom of this file.

$ErrorActionPreference = 'Stop'
$port = 1234
$ruleName = 'LM Studio (LAN)'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'This needs an elevated PowerShell. Right-click PowerShell, Run as administrator, then run it again.' -ForegroundColor Red
  exit 1
}

# 1. A network you own should be Private. Windows applies its strictest
#    inbound rules to Public, and a Private-scoped firewall rule will not
#    apply at all while the profile says Public.
foreach ($profile in Get-NetConnectionProfile) {
  if ($profile.NetworkCategory -eq 'Public') {
    Write-Host "Setting $($profile.InterfaceAlias) from Public to Private..." -ForegroundColor Yellow
    Set-NetConnectionProfile -InterfaceAlias $profile.InterfaceAlias -NetworkCategory Private
  } else {
    Write-Host "$($profile.InterfaceAlias) is already $($profile.NetworkCategory)." -ForegroundColor DarkGray
  }
}

# 2. Allow inbound on the LM Studio port, from this subnet only.
#    LocalSubnet is the important part: LM Studio has no authentication, so
#    anything that can reach the port can generate on your GPU.
if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
  Write-Host "Firewall rule '$ruleName' already exists." -ForegroundColor DarkGray
} else {
  Write-Host "Adding firewall rule '$ruleName' for TCP $port (LocalSubnet only)..." -ForegroundColor Yellow
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP `
    -LocalPort $port -Action Allow -Profile Private -RemoteAddress LocalSubnet | Out-Null
}

# 3. Report what the other PC needs.
Write-Host ''
Write-Host '--- result ---' -ForegroundColor Cyan
Get-NetConnectionProfile | Select-Object InterfaceAlias, NetworkCategory | Format-Table -AutoSize
Get-NetFirewallRule -DisplayName $ruleName | Select-Object DisplayName, Enabled, Action, Profile | Format-Table -AutoSize

$listening = (netstat -ano | Select-String ":$port\s" | Select-String 'LISTENING') -join "`n"
if ($listening -match '0\.0\.0\.0') {
  Write-Host "LM Studio is listening on all interfaces. Good." -ForegroundColor Green
} else {
  Write-Host "LM Studio is NOT listening on the network. Run:  lms server start --bind 0.0.0.0" -ForegroundColor Red
}

$ip = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object -First 1).IPAddress

Write-Host ''
Write-Host "On the OTHER PC, set this before launching Leads King:" -ForegroundColor Cyan
Write-Host "  `$env:LLM_URL = `"http://${ip}:${port}/v1`""
Write-Host ''
Write-Host "Test it from that PC first:" -ForegroundColor Cyan
Write-Host "  curl.exe --max-time 10 http://${ip}:${port}/v1/models"

# --- To undo ---
# Remove-NetFirewallRule -DisplayName 'LM Studio (LAN)'
# lms server start            # no --bind, back to localhost only
