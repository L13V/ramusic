# Win32 Native Raw Disk Writer for RAMTECH Imager
# Writes raw / gzipped disk images directly to physical drives or files
# using Win32 CreateFileW, WriteFile, ReadFile, and FlushFileBuffers.
param(
    [Parameter(Mandatory=$true)][string]$Src,
    [Parameter(Mandatory=$true)][string]$Dest,
    [Parameter(Mandatory=$true)][string]$Progress,
    [switch]$Verify
)

$ErrorActionPreference = 'Stop'

$csharpCode = @'
using System;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class WinRawDiskWriter {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern SafeFileHandle CreateFileW(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        IntPtr lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool DeviceIoControl(
        SafeFileHandle hDevice,
        uint dwIoControlCode,
        IntPtr lpInBuffer,
        uint nInBufferSize,
        IntPtr lpOutBuffer,
        uint nOutBufferSize,
        out uint lpBytesReturned,
        IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool WriteFile(
        SafeFileHandle hFile,
        IntPtr lpBuffer,
        uint nNumberOfBytesToWrite,
        out uint lpNumberOfBytesWritten,
        IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadFile(
        SafeFileHandle hFile,
        IntPtr lpBuffer,
        uint nNumberOfBytesToRead,
        out uint lpNumberOfBytesRead,
        IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FlushFileBuffers(SafeFileHandle hFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetFilePointerEx(
        SafeFileHandle hFile,
        long liDistanceToMove,
        out long lpNewFilePointer,
        uint dwMoveMethod);

    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING = 3;
    private const uint OPEN_ALWAYS = 4;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x80;
    private const uint FSCTL_ALLOW_EXTENDED_DASD_IO = 0x00090083;
    private const uint FSCTL_LOCK_VOLUME = 0x00090018;
    private const uint FSCTL_DISMOUNT_VOLUME = 0x00090020;
    private const int SECTOR_SIZE = 512;
    private const int CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB

    public static string ExplainError(int code, string context) {
        string advice;
        switch (code) {
            case 5:
                advice = "Windows refused access to the drive (Access Denied). Close anything that might be holding it — Explorer windows, antivirus, backup or sync tools — then unplug the stick, plug it back in and try again.";
                break;
            case 32:
                advice = "The drive is still in use (Sharing Violation). Close any open Explorer windows, disk tools, or command prompts and try again.";
                break;
            case 19:
                advice = "The USB stick is write-protected. Check for a physical lock switch or try another USB stick.";
                break;
            case 21:
            case 1167:
            case 2:
                advice = "The USB stick was disconnected or is not ready. The stick may have been unplugged.";
                break;
            case 112:
            case 27:
                advice = "The USB stick is too small for this image. Use an 8 GB or larger stick.";
                break;
            case 1117:
                advice = "Windows reported an I/O device error on this stick. Unplug it and try a different port — one on the PC itself rather than a hub or front panel socket. If it fails in another port, the stick is worn out.";
                break;
            default:
                advice = new System.ComponentModel.Win32Exception(code).Message + " (Win32 " + code + ")";
                break;
        }
        return advice + (string.IsNullOrEmpty(context) ? "" : "\n\nDetails: " + context);
    }

    public static void Report(string progressPath, string phase, long written, long total, bool done, long bytesOnDevice, double elapsed, string error) {
        var sb = new System.Text.StringBuilder(256);
        sb.Append("{");
        sb.Append("\"phase\":\"").Append(phase).Append("\",");
        sb.Append("\"written\":").Append(written).Append(",");
        sb.Append("\"total\":").Append(total).Append(",");
        sb.Append("\"done\":").Append(done ? "true" : "false");
        if (bytesOnDevice >= 0) {
            sb.Append(",\"bytesOnDevice\":").Append(bytesOnDevice);
        }
        if (elapsed >= 0) {
            sb.Append(",\"elapsed\":").Append(elapsed.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
        }
        if (!string.IsNullOrEmpty(error)) {
            string escaped = error.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", "\\n");
            sb.Append(",\"error\":\"").Append(escaped).Append("\"");
        }
        sb.Append("}");
        string json = sb.ToString();

        string tmp = progressPath + ".tmp";
        try {
            File.WriteAllText(tmp, json);
            if (File.Exists(progressPath)) {
                File.Delete(progressPath);
            }
            File.Move(tmp, progressPath);
        } catch {
            try { File.WriteAllText(progressPath, json); } catch {}
        }
    }

    public static void Write(string srcPath, string destPath, string progressPath, bool verify) {
        if (!File.Exists(srcPath)) {
            throw new FileNotFoundException("Image file not found: " + srcPath);
        }

        long compressedTotal = new FileInfo(srcPath).Length;
        bool isGz = srcPath.EndsWith(".gz", StringComparison.OrdinalIgnoreCase);
        bool isDevice = destPath.StartsWith(@"\\.\PHYSICALDRIVE", StringComparison.OrdinalIgnoreCase) ||
                        destPath.StartsWith(@"\\?\PHYSICALDRIVE", StringComparison.OrdinalIgnoreCase);

        Report(progressPath, "preparing", 0, compressedTotal, false, 0, 0, null);

        SafeFileHandle hDest = null;
        int lastError = 0;
        DateTime deadline = DateTime.UtcNow.AddSeconds(isDevice ? 30 : 5);

        while (DateTime.UtcNow < deadline) {
            uint disposition = isDevice ? OPEN_EXISTING : OPEN_ALWAYS;
            uint flags = isDevice ? 0 : FILE_ATTRIBUTE_NORMAL;
            hDest = CreateFileW(
                destPath,
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                IntPtr.Zero,
                disposition,
                flags,
                IntPtr.Zero
            );

            if (!hDest.IsInvalid) {
                break;
            }

            lastError = Marshal.GetLastWin32Error();
            Report(progressPath, "preparing", 0, compressedTotal, false, 0, 0, null);
            System.Threading.Thread.Sleep(500);
        }

        if (hDest == null || hDest.IsInvalid) {
            throw new Exception(ExplainError(lastError, "Failed to open target device " + destPath));
        }

        using (hDest) {
            if (isDevice) {
                uint dummy;
                DeviceIoControl(hDest, FSCTL_ALLOW_EXTENDED_DASD_IO, IntPtr.Zero, 0, IntPtr.Zero, 0, out dummy, IntPtr.Zero);
                DeviceIoControl(hDest, FSCTL_LOCK_VOLUME, IntPtr.Zero, 0, IntPtr.Zero, 0, out dummy, IntPtr.Zero);
                DeviceIoControl(hDest, FSCTL_DISMOUNT_VOLUME, IntPtr.Zero, 0, IntPtr.Zero, 0, out dummy, IntPtr.Zero);
            }

            byte[] expectedHash;
            long totalImageBytes = 0;
            long totalBytesWritten = 0;
            var sw = System.Diagnostics.Stopwatch.StartNew();
            var lastReport = System.Diagnostics.Stopwatch.StartNew();

            using (FileStream srcFile = new FileStream(srcPath, FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 1024))
            using (Stream uncompressed = isGz ? (Stream)new GZipStream(srcFile, CompressionMode.Decompress) : (Stream)srcFile)
            using (SHA256 sha256 = SHA256.Create()) {
                byte[] buffer = new byte[CHUNK_SIZE];
                GCHandle pin = GCHandle.Alloc(buffer, GCHandleType.Pinned);
                try {
                    IntPtr bufPtr = pin.AddrOfPinnedObject();

                    while (true) {
                        int chunkFilled = 0;
                        while (chunkFilled < CHUNK_SIZE) {
                            int n = uncompressed.Read(buffer, chunkFilled, CHUNK_SIZE - chunkFilled);
                            if (n <= 0) break;
                            chunkFilled += n;
                        }

                        if (chunkFilled == 0) {
                            break;
                        }

                        sha256.TransformBlock(buffer, 0, chunkFilled, null, 0);
                        totalImageBytes += chunkFilled;

                        int bytesToWrite = chunkFilled;
                        if (isDevice) {
                            int rem = bytesToWrite % SECTOR_SIZE;
                            if (rem != 0) {
                                int pad = SECTOR_SIZE - rem;
                                Array.Clear(buffer, bytesToWrite, pad);
                                bytesToWrite += pad;
                            }
                        }

                        int writtenSoFar = 0;
                        while (writtenSoFar < bytesToWrite) {
                            IntPtr slicePtr = new IntPtr(bufPtr.ToInt64() + writtenSoFar);
                            uint countToWrite = (uint)(bytesToWrite - writtenSoFar);
                            uint written;
                            if (!WriteFile(hDest, slicePtr, countToWrite, out written, IntPtr.Zero) || written == 0) {
                                int err = Marshal.GetLastWin32Error();
                                throw new Exception(ExplainError(err, "WriteFile failed at offset " + (totalBytesWritten + writtenSoFar)));
                            }
                            writtenSoFar += (int)written;
                        }
                        totalBytesWritten += bytesToWrite;

                        if (lastReport.ElapsedMilliseconds > 250) {
                            lastReport.Restart();
                            long readCompressed = isGz ? srcFile.Position : totalImageBytes;
                            Report(progressPath, "writing", readCompressed, compressedTotal, false, totalBytesWritten, sw.Elapsed.TotalSeconds, null);
                        }
                    }
                } finally {
                    pin.Free();
                }

                sha256.TransformFinalBlock(new byte[0], 0, 0);
                expectedHash = sha256.Hash;
            }

            FlushFileBuffers(hDest);

            if (verify) {
                Report(progressPath, "verifying", 0, totalImageBytes, false, totalBytesWritten, sw.Elapsed.TotalSeconds, null);

                long newPos;
                if (!SetFilePointerEx(hDest, 0, out newPos, 0 /* FILE_BEGIN */)) {
                    int err = Marshal.GetLastWin32Error();
                    throw new Exception(ExplainError(err, "SetFilePointerEx rewind failed"));
                }

                using (SHA256 verifySha = SHA256.Create()) {
                    byte[] vBuf = new byte[CHUNK_SIZE];
                    GCHandle vPin = GCHandle.Alloc(vBuf, GCHandleType.Pinned);
                    try {
                        IntPtr vBufPtr = vPin.AddrOfPinnedObject();
                        long pos = 0;
                        lastReport.Restart();

                        while (pos < totalImageBytes) {
                            long wantLong = Math.Min((long)CHUNK_SIZE, totalImageBytes - pos);
                            int want = (int)wantLong;
                            int aligned = isDevice ? (((want + SECTOR_SIZE - 1) / SECTOR_SIZE) * SECTOR_SIZE) : want;

                            int got = 0;
                            while (got < aligned) {
                                IntPtr slicePtr = new IntPtr(vBufPtr.ToInt64() + got);
                                uint countToRead = (uint)(aligned - got);
                                uint read;
                                if (!ReadFile(hDest, slicePtr, countToRead, out read, IntPtr.Zero) || read == 0) {
                                    int err = Marshal.GetLastWin32Error();
                                    throw new Exception(ExplainError(err, "ReadFile failed at offset " + (pos + got)));
                                }
                                got += (int)read;
                            }

                            verifySha.TransformBlock(vBuf, 0, want, null, 0);
                            pos += want;

                            if (lastReport.ElapsedMilliseconds > 250) {
                                lastReport.Restart();
                                Report(progressPath, "verifying", pos, totalImageBytes, false, totalBytesWritten, sw.Elapsed.TotalSeconds, null);
                            }
                        }
                    } finally {
                        vPin.Free();
                    }

                    verifySha.TransformFinalBlock(new byte[0], 0, 0);
                    byte[] actualHash = verifySha.Hash;

                    if (BitConverter.ToString(expectedHash) != BitConverter.ToString(actualHash)) {
                        throw new Exception("Verification failed — the stick did not read back what was written. Try another USB port or another stick.");
                    }
                }
            }

            FlushFileBuffers(hDest);
            Report(progressPath, "done", compressedTotal, compressedTotal, true, totalImageBytes, sw.Elapsed.TotalSeconds, null);
        }
    }
}
'@

try {
    Add-Type -TypeDefinition $csharpCode
    [WinRawDiskWriter]::Write($Src, $Dest, $Progress, [bool]$Verify)
    exit 0
} catch {
    $err = $_.Exception.Message
    if ($_.Exception.InnerException) {
        $err = $_.Exception.InnerException.Message
    }
    try {
        [WinRawDiskWriter]::Report($Progress, "error", 0, 0, $true, 0, 0, $err)
    } catch {
        $escaped = $err -replace '\\', '\\' -replace '"', '\"' -replace "`r", "" -replace "`n", "\n"
        Set-Content -Path $Progress -Value ("{`"phase`":`"error`",`"done`":true,`"error`":`"$escaped`"}") -Force
    }
    [Console]::Error.WriteLine($err)
    exit 1
}
