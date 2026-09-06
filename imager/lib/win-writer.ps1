# Win32 Native Raw Disk Writer for RAMTECH Imager
# Writes raw / gzipped disk images directly to physical drives or files
# using Win32 CreateFileW, WriteFile, ReadFile, and FlushFileBuffers.
param(
    [Parameter(Mandatory=$true)][string]$Src,
    [Parameter(Mandatory=$true)][string]$Dest,
    [Parameter(Mandatory=$true)][string]$Progress,
    [long]$Total = 0,
    [switch]$Verify
)

$ErrorActionPreference = 'Stop'

$csharpCode = @'
using System;
using System.IO;
using System.IO.Compression;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
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
    // Unbuffered, but NOT write-through. Unbuffered keeps the Windows file cache
    // out of the way, so WriteFile waits for the stick and progress is the
    // stick's real pace. Write-through on top of it additionally asks the drive
    // to flush its own cache on every call, which on USB mass storage costs more
    // throughput than anything else in this file.
    private const uint FILE_FLAG_NO_BUFFERING = 0x20000000;
    private const uint FSCTL_ALLOW_EXTENDED_DASD_IO = 0x00090083;
    private const uint FSCTL_LOCK_VOLUME = 0x00090018;
    private const uint FSCTL_DISMOUNT_VOLUME = 0x00090020;
    private const int SECTOR_SIZE = 512;
    // Unbuffered I/O has to be aligned to the drive physical sector, which is
    // 512 on most sticks and 4096 on some. 4096 is a multiple of both, so one
    // number is correct for either without asking the driver which it is.
    private const int ALIGN = 4096;
    private const int CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB
    private const int QUEUE_DEPTH = 4;

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

    // ── Buffers ──────────────────────────────────────────────────
    // Unbuffered I/O needs the buffer address sector-aligned as well as the
    // lengths and offsets, and the GC pins an array wherever it already sits —
    // so each buffer is over-allocated by one alignment unit and an aligned
    // window is taken inside it.
    private class Chunk {
        public byte[] Data;
        public int Off;
        public IntPtr Ptr;
        public int Len;
        private GCHandle pin;

        public Chunk() {
            Data = new byte[CHUNK_SIZE + ALIGN];
            pin = GCHandle.Alloc(Data, GCHandleType.Pinned);
            long b = pin.AddrOfPinnedObject().ToInt64();
            Off = (int)((ALIGN - (b % ALIGN)) % ALIGN);
            Ptr = new IntPtr(b + Off);
        }

        public void Free() { if (pin.IsAllocated) pin.Free(); }
    }

    private class Pipe {
        private readonly Queue<Chunk> q = new Queue<Chunk>();
        public void Put(Chunk c) { lock (q) { q.Enqueue(c); Monitor.Pulse(q); } }
        public Chunk Take() {
            lock (q) {
                while (q.Count == 0) Monitor.Wait(q);
                return q.Dequeue();
            }
        }
    }

    // Decompression runs on its own thread so it overlaps the device write
    // instead of taking turns with it. The stick is by far the slower of the
    // two, so overlapping makes the decompression cost nothing at all.
    private class Pump {
        public Stream Source;
        public Pipe Free = new Pipe();
        public Pipe Full = new Pipe();
        public Exception Error;

        public void Run() {
            try {
                while (true) {
                    Chunk c = Free.Take();
                    int filled = 0;
                    while (filled < CHUNK_SIZE) {
                        int n = Source.Read(c.Data, c.Off + filled, CHUNK_SIZE - filled);
                        if (n <= 0) break;
                        filled += n;
                    }
                    c.Len = filled;
                    if (filled == 0) { Full.Put(null); return; }
                    Full.Put(c);
                }
            } catch (Exception ex) {
                Error = ex;
                Full.Put(null);
            }
        }
    }

    /// A 64-bit FNV-1a over the block, taken eight bytes at a time. Enough to
    /// name the first block that came back wrong, which is what tells a worn
    /// stick apart from one that lies about its capacity.
    private static ulong Fingerprint(byte[] b, int off, int len) {
        ulong h = 14695981039346656037UL;
        int i = off;
        int wordEnd = off + (len & ~7);
        for (; i < wordEnd; i += 8) {
            h = (h ^ BitConverter.ToUInt64(b, i)) * 1099511628211UL;
        }
        for (; i < off + len; i++) {
            h = (h ^ b[i]) * 1099511628211UL;
        }
        return h;
    }

    private static void Seek(SafeFileHandle h, long pos) {
        long dummy;
        if (!SetFilePointerEx(h, pos, out dummy, 0 /* FILE_BEGIN */)) {
            throw new Exception(ExplainError(Marshal.GetLastWin32Error(), "Seek to " + pos + " failed"));
        }
    }

    private static int PaddedLength(int len, int align, bool isDevice) {
        if (!isDevice) return len;
        int rem = len % align;
        return rem == 0 ? len : len + (align - rem);
    }

    private static void WriteBlock(SafeFileHandle h, Chunk c, int count, long atOffset) {
        int done = 0;
        while (done < count) {
            IntPtr slice = new IntPtr(c.Ptr.ToInt64() + done);
            uint written;
            if (!WriteFile(h, slice, (uint)(count - done), out written, IntPtr.Zero) || written == 0) {
                throw new Exception(ExplainError(Marshal.GetLastWin32Error(),
                    "WriteFile failed at offset " + (atOffset + done)));
            }
            done += (int)written;
        }
    }

    private static void ReadBlock(SafeFileHandle h, Chunk c, int count, long atOffset) {
        int done = 0;
        while (done < count) {
            IntPtr slice = new IntPtr(c.Ptr.ToInt64() + done);
            uint read;
            if (!ReadFile(h, slice, (uint)(count - done), out read, IntPtr.Zero) || read == 0) {
                throw new Exception(ExplainError(Marshal.GetLastWin32Error(),
                    "ReadFile failed at offset " + (atOffset + done)));
            }
            done += (int)read;
        }
    }

    public static void Write(string srcPath, string destPath, string progressPath, bool verify, long imageTotal) {
        if (!File.Exists(srcPath)) {
            throw new FileNotFoundException("Image file not found: " + srcPath);
        }

        long compressedTotal = new FileInfo(srcPath).Length;
        bool isGz = srcPath.EndsWith(".gz", StringComparison.OrdinalIgnoreCase);
        bool isDevice = destPath.StartsWith(@"\\.\PHYSICALDRIVE", StringComparison.OrdinalIgnoreCase) ||
                        destPath.StartsWith(@"\\?\PHYSICALDRIVE", StringComparison.OrdinalIgnoreCase);

        // Progress is counted in bytes written to the stick, not bytes read from
        // the .gz: an empty 4 GiB persistence partition is ~9 MB of the one and
        // 4 GiB of the other, so the compressed file makes the bar hit 100% with
        // most of the write still to come. The parent works the real size out.
        long progressTotal = imageTotal > 0 ? imageTotal : compressedTotal;

        Report(progressPath, "preparing", 0, progressTotal, false, 0, 0, null);

        SafeFileHandle hDest = null;
        int lastError = 0;
        bool unbuffered = isDevice;
        DateTime deadline = DateTime.UtcNow.AddSeconds(isDevice ? 30 : 5);

        while (DateTime.UtcNow < deadline) {
            uint disposition = isDevice ? OPEN_EXISTING : OPEN_ALWAYS;
            uint flags = isDevice
                ? (unbuffered ? FILE_FLAG_NO_BUFFERING : 0)
                : FILE_ATTRIBUTE_NORMAL;
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
            // A driver that will not take unbuffered I/O rejects the flags, not the
            // disk: retry cached rather than failing the write outright.
            if (unbuffered && (lastError == 87 || lastError == 1)) {
                unbuffered = false;
                continue;
            }
            Report(progressPath, "preparing", 0, progressTotal, false, 0, 0, null);
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

            // A cached handle only needs whole sectors; unbuffered needs the full
            // alignment. Aligning always costs nothing, so one path covers both.
            int align = unbuffered ? ALIGN : SECTOR_SIZE;

            var fps = new List<ulong>();   // fingerprint of each block, in image order
            var lens = new List<int>();    // and how many bytes of it are real
            Chunk head = null;             // block 0, held back — see below
            long imageBytes = 0;
            long onDevice = 0;
            var sw = System.Diagnostics.Stopwatch.StartNew();
            var lastReport = System.Diagnostics.Stopwatch.StartNew();

            var pool = new List<Chunk>();
            FileStream srcFile = null;
            Stream uncompressed = null;
            try {
                srcFile = new FileStream(srcPath, FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 1024);
                uncompressed = isGz ? (Stream)new GZipStream(srcFile, CompressionMode.Decompress) : (Stream)srcFile;

                var pump = new Pump();
                pump.Source = uncompressed;
                for (int i = 0; i < QUEUE_DEPTH; i++) {
                    Chunk c = new Chunk();
                    pool.Add(c);
                    pump.Free.Put(c);
                }
                Thread producer = new Thread(pump.Run);
                producer.IsBackground = true;
                producer.Start();

                // The first block carries the partition table. Windows watches
                // removable media for a layout it recognises and will mount — and
                // write to — any volume that appears, while this write is still
                // running. That is what made verification come back with bytes
                // that were never written. Holding block 0 back until everything
                // else is on the stick (and verified) means there is nothing for
                // Windows to notice until the drive is finished.
                Seek(hDest, CHUNK_SIZE);

                int index = 0;
                for (;;) {
                    Chunk c = pump.Full.Take();
                    if (c == null) break;

                    fps.Add(Fingerprint(c.Data, c.Off, c.Len));
                    lens.Add(c.Len);
                    imageBytes += c.Len;

                    if (index == 0) {
                        head = c;   // kept out of the pool until the very end
                    } else {
                        int count = PaddedLength(c.Len, align, isDevice);
                        if (count > c.Len) Array.Clear(c.Data, c.Off + c.Len, count - c.Len);
                        WriteBlock(hDest, c, count, onDevice + CHUNK_SIZE);
                        onDevice += count;
                        pump.Free.Put(c);
                    }
                    index++;

                    if (lastReport.ElapsedMilliseconds > 250) {
                        lastReport.Restart();
                        // The gzip footer only pinned the size modulo 4 GiB; if the
                        // estimate was short, recover the missing multiple rather
                        // than let the bar run past the end.
                        while (imageBytes > progressTotal) progressTotal += 4294967296L;
                        Report(progressPath, "writing", imageBytes, progressTotal, false, onDevice, sw.Elapsed.TotalSeconds, null);
                    }
                }

                producer.Join();
                if (pump.Error != null) throw pump.Error;
                if (head == null) throw new Exception("The image is empty.");
            } finally {
                if (uncompressed != null) uncompressed.Dispose();
                if (srcFile != null) srcFile.Dispose();
            }

            try {
                Report(progressPath, "flushing", imageBytes, imageBytes, false, onDevice, sw.Elapsed.TotalSeconds, null);
                FlushFileBuffers(hDest);

                Chunk scratch = pool[0] == head ? pool[1] : pool[0];

                if (verify) {
                    VerifyRange(hDest, scratch, fps, lens, 1, CHUNK_SIZE, align, isDevice,
                        progressPath, imageBytes, onDevice, sw, lastReport);
                }

                // Everything else is on the stick and checked; now make it bootable.
                Seek(hDest, 0);
                int headCount = PaddedLength(head.Len, align, isDevice);
                if (headCount > head.Len) Array.Clear(head.Data, head.Off + head.Len, headCount - head.Len);
                WriteBlock(hDest, head, headCount, 0);
                onDevice += headCount;
                FlushFileBuffers(hDest);

                if (verify) {
                    VerifyRange(hDest, scratch, fps, lens, 0, 0, align, isDevice,
                        progressPath, imageBytes, onDevice, sw, lastReport);
                }

                Report(progressPath, "done", imageBytes, imageBytes, true, imageBytes, sw.Elapsed.TotalSeconds, null);
            } finally {
                for (int i = 0; i < pool.Count; i++) pool[i].Free();
            }
        }
    }

    /// Read blocks back and compare fingerprints. `from` is the first block index
    /// to check and `at` the byte offset it lives at; the run continues to the end
    /// of the image, or stops after one block when checking the held-back head.
    private static void VerifyRange(SafeFileHandle h, Chunk buf, List<ulong> fps, List<int> lens,
                                    int from, long at, int align, bool isDevice,
                                    string progressPath, long imageBytes, long onDevice,
                                    System.Diagnostics.Stopwatch sw, System.Diagnostics.Stopwatch lastReport) {
        int last = from == 0 ? 0 : fps.Count - 1;
        long firstBad = -1;
        int badBlocks = 0;
        long checkedBytes = 0;

        Seek(h, at);
        // Only the body pass opens the phase. The head is one block checked at
        // the very end, and announcing it would snap a full bar back to zero.
        if (from > 0) {
            Report(progressPath, "verifying", 0, imageBytes, false, onDevice, sw.Elapsed.TotalSeconds, null);
        }

        for (int i = from; i <= last; i++) {
            int want = lens[i];
            int count = PaddedLength(want, align, isDevice);
            long offset = at + checkedBytes;
            ReadBlock(h, buf, count, offset);
            if (Fingerprint(buf.Data, buf.Off, want) != fps[i]) {
                badBlocks++;
                if (firstBad < 0) firstBad = (long)i * CHUNK_SIZE;
            }
            checkedBytes += count;

            if (from > 0 && lastReport.ElapsedMilliseconds > 250) {
                lastReport.Restart();
                Report(progressPath, "verifying", at + checkedBytes, imageBytes, false, onDevice, sw.Elapsed.TotalSeconds, null);
            }
        }

        if (badBlocks == 0) return;

        int checkedBlocks = last - from + 1;
        string cause;
        if (checkedBlocks == 1) {
            // Only the partition-table block is checked on its own, and it is the
            // last thing written, so nothing has had a chance to overwrite it.
            cause = "That block is the partition table, written last of all. A stick that fails only here is refusing writes rather than losing them — try a different stick.";
        } else {
            // A stick that claims more capacity than it has takes the whole write
            // and then hands back rubbish for everything past its real end, so the
            // damage runs to the end in one piece. Wear is scattered.
            long runToEnd = last - (firstBad / CHUNK_SIZE) + 1;
            cause = badBlocks == runToEnd && badBlocks > 1
                ? "Everything from that point on is wrong, which is what a stick that reports more capacity than it really has does. Use a different stick, from a brand you recognise."
                : "The differences are scattered rather than in one run, which points at worn-out flash. Try a different USB port — one on the PC itself rather than a hub — and if it fails the same way, use another stick.";
        }
        throw new Exception("Verification failed — the stick did not read back what was written.\n\n"
            + "The first difference is " + (firstBad / (1024 * 1024)) + " MB into the image; "
            + badBlocks + " of " + checkedBlocks + " blocks read back wrong. " + cause);
    }
}
'@

try {
    Add-Type -TypeDefinition $csharpCode
    [WinRawDiskWriter]::Write($Src, $Dest, $Progress, [bool]$Verify, $Total)
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
