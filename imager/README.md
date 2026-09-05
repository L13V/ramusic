# RAMTECH Imager

A GUI for the one job: **get RAMTECH OS onto a USB stick.** Pick the image, pick
the stick, press Write. It downloads the latest release, verifies its SHA-256,
erases the stick, writes the raw image and reads it back to check it.

```bash
npm install
npm start                # run from source
npm run dist             # build an installer for this platform
```

## Why it exists
The generic tools work — balenaEtcher and Rufus both take the `.img.gz`
directly — but they ask questions this job doesn't have answers for
(partition scheme, target system, persistent size), and getting one wrong
produces a stick that silently won't boot. This asks two questions and has no
wrong answers.

## How it works
- **`lib/drives.js`** lists removable drives by shelling out per platform —
  `Win32_DiskDrive` via PowerShell, `diskutil list -plist | plutil` on macOS,
  `lsblk -J` on Linux. No native modules, so `npm install` can't fail on the one
  machine you need it on. Anything non-removable, mounted at a system path, or
  larger than 512 GB is filtered out before it can be offered as a target.
- **`lib/writer-child.js`** is the privileged half: it streams the gzip through
  `zlib` and writes sector-aligned 4 MiB blocks straight to the block device,
  hashing as it goes so the verify pass has something to compare against. It
  reports progress by rewriting a small JSON file rather than on stdout, because
  the elevation wrappers on macOS and Linux buffer a child's output until it
  exits.
- **`lib/elevate.js`** gets it those rights: Windows elevates the whole app
  (the packaged build asks in its manifest), macOS wraps the child in
  `osascript … with administrator privileges`, Linux uses `pkexec`.

Before writing, Windows runs `diskpart clean` on the target — that is the only
reliable way to make it drop every volume lock on a disk.

## The image format
The image is a **gzipped raw disk image**, not an ISO. Two consequences that are
deliberate:

- **gzip, not xz**, because every JS runtime can decompress gzip with no
  dependency. The file is a few hundred MB bigger; the tool stays trivial.
- The **persistence partition is inside the image**, so writing it is a
  byte-for-byte copy with no partitioning step. Windows cannot create an ext4
  filesystem, and a one-click imager that only works on Linux would defeat the
  point.
