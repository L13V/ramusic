'use strict';
// Why Windows refused a handle on a disk, in Windows' own words.
//
// Node collapses a dozen distinct Win32 failures into a handful of errnos — a
// dying stick, a disk Windows has parked offline, and an access mask the
// storage driver will not grant can all arrive as the same EIO — and the answer
// to each is different. So when an open fails, ask Win32 directly and put the
// raw code in the report.
//
// Read-only: every handle here is opened and closed again, nothing is written.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Access masks and flags, in decimal: PowerShell parses 0x80000000 as a
// negative Int32, which then will not cast to the [uint32] CreateFileW wants.
const GENERIC_READ = 2147483648;   // 0x80000000
const GENERIC_RW = 3221225472;     // 0xC0000000
const NODE_MASK = 1180063;         // 0x0012019F  FILE_GENERIC_READ|FILE_GENERIC_WRITE
const NODE_FLAGS = 33554560;       // 0x02000080  FILE_FLAG_BACKUP_SEMANTICS|FILE_ATTRIBUTE_NORMAL

// The device path arrives as a parameter rather than being built here: it is
// nothing but backslashes, and every layer between this file and PowerShell
// wants to eat some of them.
const SCRIPT = `param([string]$Path)
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RamProbe {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec,
    uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr h);
}
'@
function Probe([string]$Label, [uint32]$Access, [uint32]$Flags) {
  # OPEN_EXISTING, shared read/write — the terms every imaging tool asks on.
  $h = [RamProbe]::CreateFileW($Path, $Access, 3, [IntPtr]::Zero, 3, $Flags, [IntPtr]::Zero)
  if ($h -eq [IntPtr](-1)) {
    $c = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    '  {0,-11} Win32 {1}: {2}' -f $Label, $c, (New-Object ComponentModel.Win32Exception($c)).Message
  } else {
    [void][RamProbe]::CloseHandle($h)
    '  {0,-11} opened' -f $Label
  }
}
Probe 'read' ([uint32]${GENERIC_READ}) ([uint32]0)
Probe 'read+write' ([uint32]${GENERIC_RW}) ([uint32]0)
Probe 'node-style' ([uint32]${NODE_MASK}) ([uint32]${NODE_FLAGS})
`;

/**
 * Open `target` three ways and report what Win32 said about each: plain read,
 * plain read/write, and the exact mask Node's own fs.open asks for. A disk that
 * opens on one and not the others is a different problem from one that fails
 * all three. Returns '' when the probe itself cannot run — it is only ever
 * decoration on a failure that has already happened.
 */
function probeOpen(target) {
  if (process.platform !== 'win32') return '';
  const tmp = path.join(os.tmpdir(), `ramtech-probe-${process.pid}.ps1`);
  try {
    fs.writeFileSync(tmp, SCRIPT);
    const out = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp, '-Path', target],
      { encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
    return String(out).trimEnd();
  } catch (err) {
    return String((err && err.stdout) || '').trimEnd();
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

module.exports = { probeOpen };
