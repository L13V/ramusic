'use strict';
// Removable-drive enumeration, one small shell-out per platform. Deliberately
// no native module: a native dep is the thing that breaks a "just run it" tool
// on the one machine you need it on.
const { execFile } = require('child_process');
const { promisify } = require('util');
const pexecFile = promisify(execFile);

const GB = 1024 * 1024 * 1024;

async function listWindows() {
  // Win32_DiskDrive gives the physical device; the partition/logical-disk join
  // gives the drive letters people actually recognise the stick by.
  const ps = `
$ErrorActionPreference='Stop'
Get-CimInstance Win32_DiskDrive | ForEach-Object {
  $d = $_
  $letters = @()
  try {
    $letters = Get-CimAssociatedInstance -InputObject $d -ResultClassName Win32_DiskPartition |
      ForEach-Object { Get-CimAssociatedInstance -InputObject $_ -ResultClassName Win32_LogicalDisk } |
      ForEach-Object { $_.DeviceID }
  } catch {}
  [pscustomobject]@{
    device    = $d.DeviceID
    index     = $d.Index
    model     = $d.Model
    size      = [int64]$d.Size
    bus       = $d.InterfaceType
    media     = $d.MediaType
    mounts    = @($letters)
  }
} | ConvertTo-Json -Depth 4 -Compress`;
  const { stdout } = await pexecFile('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', ps], { maxBuffer: 8 << 20 });
  const rows = normalizeJson(stdout);
  return rows.map((r) => ({
    id: r.device,                       // \.\PHYSICALDRIVE2
    index: r.index,
    description: (r.model || 'USB device').trim(),
    size: Number(r.size) || 0,
    mounts: r.mounts || [],
    // A USB bus or "Removable Media" is the whole safety story on Windows;
    // internal NVMe/SATA disks report neither.
    removable: r.bus === 'USB' || /removable/i.test(r.media || ''),
  }));
}

async function listMac() {
  // plutil turns diskutil's plist into JSON, so no plist parser is needed.
  const { stdout } = await pexecFile('/bin/sh',
    ['-c', 'diskutil list -plist | plutil -convert json -o - -'], { maxBuffer: 8 << 20 });
  const all = JSON.parse(stdout);
  const disks = all.AllDisksAndPartitions || [];
  const out = [];
  for (const d of disks) {
    const { stdout: infoOut } = await pexecFile('/bin/sh',
      ['-c', `diskutil info -plist /dev/${d.DeviceIdentifier} | plutil -convert json -o - -`]);
    const i = JSON.parse(infoOut);
    out.push({
      id: `/dev/${d.DeviceIdentifier}`,
      description: (i.MediaName || i.IORegistryEntryName || 'USB device').trim(),
      size: Number(i.TotalSize) || 0,
      mounts: (d.Partitions || []).map((p) => p.MountPoint).filter(Boolean),
      removable: Boolean(i.RemovableMedia || i.Ejectable) && !i.Internal,
    });
  }
  return out;
}

async function listLinux() {
  const { stdout } = await pexecFile('lsblk',
    ['-J', '-b', '-o', 'NAME,PATH,SIZE,MODEL,TRAN,RM,HOTPLUG,TYPE,MOUNTPOINTS'], { maxBuffer: 8 << 20 });
  const tree = JSON.parse(stdout).blockdevices || [];
  return tree.filter((d) => d.type === 'disk').map((d) => ({
    id: d.path,
    description: (d.model || 'USB device').trim(),
    size: Number(d.size) || 0,
    mounts: collectMounts(d),
    removable: Boolean(d.rm) || d.tran === 'usb' || Boolean(d.hotplug),
  }));
}

function collectMounts(node) {
  const mine = (node.mountpoints || []).filter(Boolean);
  const kids = (node.children || []).flatMap(collectMounts);
  return [...mine, ...kids];
}

// PowerShell emits a bare object (not an array) for a single result.
function normalizeJson(stdout) {
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * Candidate USB sticks, safest-looking first. Anything that isn't removable, is
 * mounted at a system path, or is implausibly large is filtered out — this tool
 * destroys whatever it writes to, so the list stays conservative.
 */
async function list() {
  let drives;
  if (process.platform === 'win32') drives = await listWindows();
  else if (process.platform === 'darwin') drives = await listMac();
  else drives = await listLinux();

  return drives
    .filter((d) => d.removable && d.size > 0)
    .filter((d) => !d.mounts.some((m) => m === '/' || m === '/boot' || m === '/boot/efi' || m === 'C:'))
    .filter((d) => d.size <= 512 * GB)   // a 2 TB "removable" disk is not a boot stick
    .sort((a, b) => a.size - b.size);
}

module.exports = { list };
