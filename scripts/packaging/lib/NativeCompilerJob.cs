// Packaging-only Win32 ownership. Pattern: worker_host.cpp's atomic Job list.
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Diagnostics;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public sealed class NativeCompilerResult {
    public long? ExitCode;
    public bool Deadline, ParentExited, JobEmpty, RootExited, AtomicMembership, CallerVerified;
    public uint DescendantsRetired;
    public string ErrorCode;
    public int NativeError;
    public byte[] Stdout = new byte[0], Stderr = new byte[0];
}

public static class NativeCompilerJob {
    private sealed class Pump {
        internal readonly MemoryStream Bytes = new MemoryStream();
        internal int Overflow, Failed;
        internal void Read(Stream input, int limit) {
            byte[] buffer = new byte[4096];
            try {
                int count;
                while ((count = input.Read(buffer, 0, buffer.Length)) != 0) {
                    int remaining = limit - (int)Bytes.Length;
                    if (remaining > 0) Bytes.Write(buffer, 0, Math.Min(count, remaining));
                    if (count > remaining) Interlocked.Exchange(ref Overflow, 1);
                }
            } catch { Interlocked.Exchange(ref Failed, 1); }
        }
    }

    public static NativeCompilerResult Run(string command, string[] arguments, string cwd,
        string[] environmentKeys, string[] environmentValues, IntPtr callerHandle, uint callerId,
        long callerCreation, string callerImage, long deadlineUnixMs, int maxBuffer) {
        NativeCompilerResult result = new NativeCompilerResult();
        IntPtr job = IntPtr.Zero, input = IntPtr.Zero, stdoutRead = IntPtr.Zero, stdoutWrite = IntPtr.Zero;
        IntPtr stderrRead = IntPtr.Zero, stderrWrite = IntPtr.Zero, attributes = IntPtr.Zero;
        IntPtr handleList = IntPtr.Zero, jobList = IntPtr.Zero, environment = IntPtr.Zero;
        ProcessInformation process = new ProcessInformation();
        bool attributesReady = false, created = false;
        FileStream stdout = null, stderr = null;
        Task outTask = null, errTask = null;
        Pump outPump = new Pump(), errPump = new Pump();
        // Hold no-delete/no-write leases over every command-path component and image.
        List<IntPtr> leases = new List<IntPtr>();
        try {
            if (IntPtr.Size != 8 || Marshal.SizeOf(typeof(ExtendedLimits)) != 144 ||
                Marshal.SizeOf(typeof(StartupInfoEx)) != 112 || maxBuffer < 1 || maxBuffer > 8 * 1024 * 1024)
                throw new InvalidOperationException("Unsupported compiler owner layout/bounds.");
            VerifyCaller(callerHandle, callerId, callerCreation, callerImage);
            result.CallerVerified = true;
            if (WaitForSingleObject(callerHandle, 0) == 0) { result.ParentExited = true; result.ErrorCode = "ECANCELED"; return result; }
            if (Now() >= deadlineUnixMs) { result.Deadline = true; result.ErrorCode = "ETIMEDOUT"; return result; }
            PinPath(command, false, leases);
            PinPath(cwd, true, leases);
            job = CreateJobObjectW(IntPtr.Zero, null); CheckHandle(job);
            ExtendedLimits limits = new ExtendedLimits(); limits.Basic.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE, no breakaway.
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
            SecurityAttributes security = new SecurityAttributes(); security.Length = Marshal.SizeOf(typeof(SecurityAttributes)); security.InheritHandle = true;
            Check(CreatePipe(out stdoutRead, out stdoutWrite, ref security, 0));
            Check(CreatePipe(out stderrRead, out stderrWrite, ref security, 0));
            Check(SetHandleInformation(stdoutRead, 1, 0)); Check(SetHandleInformation(stderrRead, 1, 0));
            input = CreateFileW("NUL", 0x80000000, 3, ref security, 3, 0x80, IntPtr.Zero); CheckHandle(input);
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            if (size == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            attributes = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size)); attributesReady = true;
            handleList = Marshal.AllocHGlobal(3 * IntPtr.Size);
            Marshal.WriteIntPtr(handleList, 0, input); Marshal.WriteIntPtr(handleList, IntPtr.Size, stdoutWrite); Marshal.WriteIntPtr(handleList, 2 * IntPtr.Size, stderrWrite);
            Check(UpdateProcThreadAttribute(attributes, 0, (UIntPtr)0x20002, handleList, (UIntPtr)(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            jobList = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList, job);
            Check(UpdateProcThreadAttribute(attributes, 0, (UIntPtr)0x2000d, jobList, (UIntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero));
            environment = BuildEnvironment(environmentKeys, environmentValues);
            StartupInfoEx startup = new StartupInfoEx(); startup.Startup.Size = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.Startup.Flags = 0x101; startup.Startup.ShowWindow = 0;
            startup.Startup.StandardInput = input; startup.Startup.StandardOutput = stdoutWrite; startup.Startup.StandardError = stderrWrite;
            startup.AttributeList = attributes;
            string rendered = String.Join(" ", new string[] { command }.Concat(arguments).Select(Quote));
            if (rendered.Length > 30000) throw new InvalidOperationException("Compiler arguments exceed bounds.");
            // Both handle and Job-list attributes are atomic with process creation.
            // Failure never falls back to an unowned launch or breakaway.
            Check(CreateProcessW(command, new StringBuilder(rendered), IntPtr.Zero, IntPtr.Zero, true,
                0x08080404, environment, cwd, ref startup, out process)); created = true;
            bool member; Check(IsProcessInJob(process.Process, job, out member));
            if (!member) throw new InvalidOperationException("Atomic compiler custody failed.");
            result.AtomicMembership = true;
            Close(ref stdoutWrite); Close(ref stderrWrite); Close(ref input);
            stdout = new FileStream(new SafeFileHandle(stdoutRead, true), FileAccess.Read); stdoutRead = IntPtr.Zero;
            stderr = new FileStream(new SafeFileHandle(stderrRead, true), FileAccess.Read); stderrRead = IntPtr.Zero;
            FileStream outStream = stdout, errStream = stderr;
            outTask = Task.Run(delegate { outPump.Read(outStream, maxBuffer); });
            errTask = Task.Run(delegate { errPump.Read(errStream, maxBuffer); });
            if (WaitForSingleObject(callerHandle, 0) == 0) { result.ParentExited = true; result.ErrorCode = "ECANCELED"; }
            else if (Now() >= deadlineUnixMs) { result.Deadline = true; result.ErrorCode = "ETIMEDOUT"; }
            else {
                if (ResumeThread(process.Thread) != 1) throw new Win32Exception(Marshal.GetLastWin32Error());
                Close(ref process.Thread);
                for (;;) {
                    long remaining = deadlineUnixMs - Now();
                    if (remaining <= 0) { result.Deadline = true; result.ErrorCode = "ETIMEDOUT"; break; }
                    uint wait = WaitForSingleObject(process.Process, (uint)Math.Min(25L, remaining));
                    if (wait == 0) {
                        uint exit; Check(GetExitCodeProcess(process.Process, out exit));
                        result.ExitCode = exit; result.RootExited = true; break;
                    }
                    if (wait != 258) throw new Win32Exception(Marshal.GetLastWin32Error());
                    if (Volatile.Read(ref outPump.Overflow) != 0 || Volatile.Read(ref errPump.Overflow) != 0) { result.ErrorCode = "ENOBUFS"; break; }
                    if (WaitForSingleObject(callerHandle, 0) == 0) { result.ParentExited = true; result.ErrorCode = "ECANCELED"; break; }
                    if (Now() >= deadlineUnixMs) { result.Deadline = true; result.ErrorCode = "ETIMEDOUT"; break; }
                }
            }
        } catch (Win32Exception error) {
            result.NativeError = error.NativeErrorCode;
            result.ErrorCode = error.NativeErrorCode == 2 || error.NativeErrorCode == 3 ? "ENOENT" : "ECOMPILEROWNER";
        } catch { result.ErrorCode = "ECOMPILEROWNER"; }
        finally {
            // Root exit is captured before teardown; child retirement never turns
            // a failed compilation, deadline, overflow or parent death into success.
            try {
                if (job != IntPtr.Zero) {
                    if (result.RootExited) { Close(ref process.Thread); Close(ref process.Process); }
                    result.DescendantsRetired = ActiveProcesses(job);
                    Check(TerminateJobObject(job, 1));
                    Close(ref process.Thread); Close(ref process.Process);
                    Stopwatch drain = Stopwatch.StartNew();
                    do { result.JobEmpty = ActiveProcesses(job) == 0; if (result.JobEmpty) break; Thread.Sleep(10); } while (drain.ElapsedMilliseconds < 2000);
                } else result.JobEmpty = !created;
            } catch { result.JobEmpty = false; }
            finally {
                Close(ref job); Close(ref process.Thread); Close(ref process.Process);
                Close(ref stdoutWrite); Close(ref stderrWrite); Close(ref input); Close(ref stdoutRead); Close(ref stderrRead);
                if (attributesReady) DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
                if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
                if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            }
            try {
                List<Task> pumps = new List<Task>(); if (outTask != null) pumps.Add(outTask); if (errTask != null) pumps.Add(errTask);
                if (!Task.WaitAll(pumps.ToArray(), 2000)) result.JobEmpty = false;
            } catch { result.JobEmpty = false; }
            if (stdout != null) stdout.Dispose(); if (stderr != null) stderr.Dispose();
            if (outTask == null || outTask.IsCompleted) result.Stdout = outPump.Bytes.ToArray();
            if (errTask == null || errTask.IsCompleted) result.Stderr = errPump.Bytes.ToArray();
            if (result.ErrorCode == null && (outPump.Overflow != 0 || errPump.Overflow != 0)) result.ErrorCode = "ENOBUFS";
            if (result.ErrorCode == null && (outPump.Failed != 0 || errPump.Failed != 0)) result.ErrorCode = "EOUTPUT";
            if (result.ErrorCode == null && !result.JobEmpty) result.ErrorCode = "ECOMPILERCLEANUP";
            for (int index = leases.Count - 1; index >= 0; index--) { IntPtr lease = leases[index]; Close(ref lease); }
        }
        return result;
    }

    private static long Now() { return (DateTime.UtcNow.Ticks - 621355968000000000L) / 10000; }
    private static void VerifyCaller(IntPtr handle, uint pid, long creation, string image) {
        if (GetProcessId(handle) != pid) throw new InvalidOperationException("Caller HANDLE identity mismatch.");
        long actual, exit, kernel, user; Check(GetProcessTimes(handle, out actual, out exit, out kernel, out user));
        if (actual != creation) throw new InvalidOperationException("Caller creation identity mismatch.");
        StringBuilder actualImage = new StringBuilder(32768); uint size = (uint)actualImage.Capacity;
        Check(QueryFullProcessImageNameW(handle, 0, actualImage, ref size));
        if (!String.Equals(actualImage.ToString(), image, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Caller image identity mismatch.");
    }
    private static void PinPath(string file, bool directory, List<IntPtr> leases) {
        if (String.IsNullOrEmpty(file) || !Path.IsPathRooted(file) || !String.Equals(Path.GetFullPath(file), file, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Noncanonical compiler path.");
        List<string> parents = new List<string>(); string cursor = directory ? file : Path.GetDirectoryName(file);
        while (!String.IsNullOrEmpty(cursor)) { parents.Add(cursor); string next = Path.GetDirectoryName(cursor); if (next == cursor) break; cursor = next; }
        parents.Reverse(); foreach (string parent in parents) Pin(parent, true, leases);
        if (!directory) Pin(file, false, leases);
    }
    private static void Pin(string file, bool directory, List<IntPtr> leases) {
        SecurityAttributes security = new SecurityAttributes(); security.Length = Marshal.SizeOf(typeof(SecurityAttributes));
        IntPtr handle = CreateFileW(file, directory ? 0x80u : 0x80000000u, directory ? 3u : 1u, ref security, 3, 0x00200000u | (directory ? 0x02000000u : 0u), IntPtr.Zero);
        CheckHandle(handle); leases.Add(handle);
        FileAttributeTag information; Check(GetFileInformationByHandleEx(handle, 9, out information, (uint)Marshal.SizeOf(typeof(FileAttributeTag))));
        if ((information.Attributes & 0x400) != 0 || ((information.Attributes & 0x10) != 0) != directory) throw new InvalidOperationException("Compiler path is linked or has wrong kind.");
        StringBuilder final = new StringBuilder(32768); uint length = GetFinalPathNameByHandleW(handle, final, (uint)final.Capacity, 0);
        if (length == 0 || length >= final.Capacity || !String.Equals(final.ToString(), "\\\\?\\" + file, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Compiler path identity changed.");
    }
    private static IntPtr BuildEnvironment(string[] keys, string[] values) {
        if (keys == null || values == null || keys.Length != values.Length || keys.Length > 128) throw new InvalidOperationException("Invalid compiler environment.");
        SortedDictionary<string, string> entries = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int index = 0; index < keys.Length; index++) {
            string key = keys[index], value = values[index];
            if (String.IsNullOrEmpty(key) || key.IndexOfAny(new char[] { '=', '\0' }) >= 0 || value == null || value.IndexOf('\0') >= 0 || entries.ContainsKey(key)) throw new InvalidOperationException("Invalid compiler environment entry.");
            entries.Add(key, value);
        }
        string text = String.Join("\0", entries.Select(delegate(KeyValuePair<string, string> pair) { return pair.Key + "=" + pair.Value; })) + "\0\0";
        if (text.Length > 32767) throw new InvalidOperationException("Compiler environment exceeds bound.");
        return Marshal.StringToHGlobalUni(text);
    }
    private static string Quote(string value) {
        if (value == null || value.IndexOfAny(new char[] { '\0', '\r', '\n' }) >= 0) throw new InvalidOperationException("Invalid compiler argument.");
        StringBuilder output = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) { if (c == '\\') slashes++; else { output.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); output.Append(c); slashes = 0; } }
        output.Append('\\', slashes * 2); return output.Append('"').ToString();
    }
    private static uint ActiveProcesses(IntPtr job) { BasicAccounting accounting; Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(BasicAccounting)), IntPtr.Zero)); return accounting.ActiveProcesses; }
    private static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    private static void CheckHandle(IntPtr handle) { if (handle == IntPtr.Zero || handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    private static void Close(ref IntPtr handle) { IntPtr owned = handle; handle = IntPtr.Zero; if (owned != IntPtr.Zero && owned != new IntPtr(-1)) CloseHandle(owned); }
    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo { public int Size; public string Reserved, Desktop, Title; public uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags; public ushort ShowWindow, ReservedBytes; public IntPtr ReservedData, StandardInput, StandardOutput, StandardError; }
    [StructLayout(LayoutKind.Sequential)] private struct StartupInfoEx { public StartupInfo Startup; public IntPtr AttributeList; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits { public long ProcessTime, JobTime; public uint LimitFlags; public UIntPtr MinimumWorkingSet, MaximumWorkingSet; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] private struct BasicAccounting { public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime; public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses; }
    [StructLayout(LayoutKind.Sequential)] private struct FileAttributeTag { public uint Attributes, ReparseTag; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits information, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryInformationJobObject(IntPtr job, int kind, out BasicAccounting information, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool member);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder image, ref uint size);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes security, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr CreateFileW(string file, uint access, uint share, ref SecurityAttributes security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandleEx(IntPtr file, int kind, out FileAttributeTag information, uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern uint GetFinalPathNameByHandleW(IntPtr file, StringBuilder output, uint size, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInformation information);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
}
