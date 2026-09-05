# Read-only report on why a disk will not open. Opens handles and closes them;
# writes nothing, changes nothing.
param([int]$Number = -1)

$ErrorActionPreference = 'Continue'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RamNative {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode,
    IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr hObject);
}
'@

function Test-Open {
  param([string]$Path, [uint32]$Access, [string]$Label, [uint32]$Flags = 0)
  # OPEN_EXISTING, shared read/write. A raw Win32 code says far more than the
  # errno Node collapses it into.
  $h = [RamNative]::CreateFileW($Path, $Access, 3, [IntPtr]::Zero, 3, $Flags, [IntPtr]::Zero)
  if ($h -eq [IntPtr](-1)) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $text = (New-Object ComponentModel.Win32Exception($code)).Message
    '  {0,-16} FAILED  Win32 {1}: {2}' -f $Label, $code, $text
  } else {
    [void][RamNative]::CloseHandle($h)
    '  {0,-16} OK' -f $Label
  }
}

Write-Output '== Disks Windows can see =='
try {
  Get-Disk | Select-Object Number, FriendlyName, BusType,
    @{n = 'SizeGB'; e = { [math]::Round($_.Size / 1GB, 1) } },
    IsOffline, IsReadOnly, OperationalStatus, HealthStatus, PartitionStyle |
    Format-Table -AutoSize | Out-String -Width 200 | Write-Output
} catch {
  Write-Output "  Get-Disk failed: $($_.Exception.Message)"
}

Write-Output '== Offline/read-only policy =='
Write-Output '  (SAN policy OfflineAll or OfflineShared is what parks a freshly wiped disk offline)'
"san policy`nexit" | Out-File -Encoding ascii "$env:TEMP\ramtech-sanpolicy.txt"
& "$env:SystemRoot\System32\diskpart.exe" /s "$env:TEMP\ramtech-sanpolicy.txt" |
  Where-Object { $_ -match 'SAN Policy|policy' } | Write-Output
Remove-Item "$env:TEMP\ramtech-sanpolicy.txt" -ErrorAction SilentlyContinue

$numbers = if ($Number -ge 0) { @($Number) } else { (Get-Disk | Select-Object -ExpandProperty Number) }
foreach ($n in $numbers) {
  Write-Output "== Opening \\.\PHYSICALDRIVE$n =="
  Test-Open -Path "\\.\PHYSICALDRIVE$n" -Access ([uint32]2147483648) -Label 'read'        # GENERIC_READ
  Test-Open -Path "\\.\PHYSICALDRIVE$n" -Access ([uint32]3221225472) -Label 'read+write'  # GENERIC_READ|GENERIC_WRITE
  # The mask Node's own fs.open asks for: FILE_GENERIC_READ|FILE_GENERIC_WRITE
  # with FILE_ATTRIBUTE_NORMAL|FILE_FLAG_BACKUP_SEMANTICS. If this one fails
  # where read+write above succeeds, the disk is fine and the access mask is the
  # whole problem — the imager then has to open the handle itself.
  Test-Open -Path "\\.\PHYSICALDRIVE$n" -Access ([uint32]0x0012019F) -Flags ([uint32]0x02000080) -Label 'node-style'
}
