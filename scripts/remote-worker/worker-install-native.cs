using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace GoatCitadel.RemoteWorker.Install
{
    // Installer-only primitives. Loading this type never changes SCM or filesystem state.
    public static class NativeFiles
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct Attributes { public int Size; public IntPtr Descriptor; public int Inherit; }
        [StructLayout(LayoutKind.Sequential)]
        private struct RenameInformation
        {
            public uint ReplaceIfExists;
            public IntPtr RootDirectory;
            public uint FileNameLength;
            public ushort FileName;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct Information
        {
            public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
            public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security,
            uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle file, out Information information);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, [Out] byte[] information, uint size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool GetVolumeInformationByHandleW(SafeFileHandle file, IntPtr name, uint nameSize,
            IntPtr serial, IntPtr componentLength, out uint flags, StringBuilder filesystem, uint filesystemSize);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint size, uint flags);
        [DllImport("kernel32.dll")]
        private static extern uint GetFileType(SafeFileHandle file);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, ref int value, uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, IntPtr value, uint size);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision,
            out IntPtr descriptor, out uint size);
        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr OpenSCManagerW(string machine, string database, uint access);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateServiceW(IntPtr manager, string name, string display, uint access,
            uint type, uint start, uint error, string binary, string group, IntPtr tag, string dependencies,
            string account, string password);
        [DllImport("advapi32.dll")]
        private static extern bool CloseServiceHandle(IntPtr service);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool ChangeServiceConfig2W(IntPtr service, uint kind, IntPtr information);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern uint GetSecurityInfo(SafeFileHandle handle, int kind, uint selection,
            out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr descriptor, uint revision,
            uint selection, out IntPtr text, out uint size);

        public static string GetCellDirectorySddl(SafeFileHandle directory)
        {
            IntPtr owner, group, dacl, sacl, descriptor, text = IntPtr.Zero;
            uint error = GetSecurityInfo(directory, 1, 0x17u, out owner, out group, out dacl, out sacl, out descriptor);
            if (error != 0) throw new Win32Exception((int)error);
            try
            {
                uint size;
                if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, 0x17u, out text, out size))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                return Marshal.PtrToStringUni(text);
            }
            finally { if (text != IntPtr.Zero) LocalFree(text); LocalFree(descriptor); }
        }
        public static byte[] GetCellDirectoryIdentity(SafeFileHandle directory)
        {
            Information basic;
            if (!GetFileInformationByHandle(directory, out basic)) throw new Win32Exception(Marshal.GetLastWin32Error());
            const uint unsafeAttributes = 0x400u | 0x200u | 0x800u | 0x4000u | 0x1000u | 0x40000u | 0x400000u;
            if (GetFileType(directory) != 1 || (basic.Attributes & (unsafeAttributes | 0x10u)) != 0x10u || basic.Links != 1)
                throw new InvalidOperationException("REFUSED: cell custody needs an ordinary directory.");
            byte[] standard = new byte[24];
            if (!GetFileInformationByHandleEx(directory, 1, standard, 24)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (standard[20] != 0 || standard[21] == 0)
                throw new InvalidOperationException("REFUSED: cell custody directory is pending deletion.");
            StringBuilder filesystem = new StringBuilder(16);
            uint flags;
            if (!GetVolumeInformationByHandleW(directory, IntPtr.Zero, 0, IntPtr.Zero, IntPtr.Zero, out flags, filesystem, 16))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (filesystem.ToString() != "NTFS" || (flags & 8) == 0)
                throw new InvalidOperationException("REFUSED: cell custody requires NTFS with persistent ACLs.");
            byte[] streams = new byte[8192];
            if (!GetFileInformationByHandleEx(directory, 7, streams, (uint)streams.Length))
            {
                int error = Marshal.GetLastWin32Error();
                if (error != 38) throw new Win32Exception(error);
            }
            else if (BitConverter.ToUInt32(streams, 0) != 0 || BitConverter.ToUInt32(streams, 4) != 0)
                throw new InvalidOperationException("REFUSED: cell custody directory has an alternate stream.");
            byte[] identity = new byte[24];
            if (!GetFileInformationByHandleEx(directory, 18, identity, 24)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (BitConverter.ToUInt64(identity, 0) == 0 || !AnyNonzero(identity, 8, 16))
                throw new InvalidOperationException("REFUSED: cell custody directory identity is empty.");
            return identity;
        }
        private static bool AnyNonzero(byte[] bytes, int start, int count)
        {
            for (int index = start; index < start + count; index++) if (bytes[index] != 0) return true;
            return false;
        }
        public static byte[] CreateCellControllerCustody(string controllerSha256, string helperSha256,
            SafeFileHandle nativeDirectory, SafeFileHandle cellsDirectory)
        {
            foreach (string pin in new string[] { controllerSha256, helperSha256 })
                if (pin == null || !System.Text.RegularExpressions.Regex.IsMatch(pin, "\\A[a-f0-9]{64}\\z") || pin == new string('0', 64))
                    throw new InvalidOperationException("REFUSED: exact controller and helper image hashes are required.");
            if (controllerSha256 == helperSha256)
                throw new InvalidOperationException("REFUSED: controller and helper must be distinct images.");
            byte[] native = GetCellDirectoryIdentity(nativeDirectory), cells = GetCellDirectoryIdentity(cellsDirectory);
            if (BitConverter.ToUInt64(native, 0) != BitConverter.ToUInt64(cells, 0) ||
                Convert.ToBase64String(native) == Convert.ToBase64String(cells))
                throw new InvalidOperationException("REFUSED: custody directories must be distinct on the same volume.");
            byte[] record = new byte[120];
            Encoding.ASCII.GetBytes("GCCUST01").CopyTo(record, 0);
            for (int index = 0; index < 32; index++)
            {
                record[8 + index] = Convert.ToByte(controllerSha256.Substring(index * 2, 2), 16);
                record[40 + index] = Convert.ToByte(helperSha256.Substring(index * 2, 2), 16);
            }
            native.CopyTo(record, 72); cells.CopyTo(record, 96);
            return record;
        }

        // The installer retains every pinned directory through record publication.
        // This encodes identities only; caller-owned ACL/path review is separate.
        public static byte[] CreateCellCapacityCustody(SafeFileHandle[] directories)
        {
            if (directories == null || directories.Length != 13)
                throw new InvalidOperationException("REFUSED: capacity custody requires all thirteen roots.");
            SafeFileHandle[] snapshot = (SafeFileHandle[])directories.Clone();
            byte[] record = new byte[320];
            Encoding.ASCII.GetBytes("GCCAPS01").CopyTo(record, 0);
            ulong volume = 0;
            var seen = new System.Collections.Generic.HashSet<string>(StringComparer.Ordinal);
            for (int index = 0; index < snapshot.Length; index++)
            {
                SafeFileHandle directory = snapshot[index];
                if (directory == null || directory.IsClosed || directory.IsInvalid)
                    throw new InvalidOperationException("REFUSED: capacity custody needs retained directory handles.");
                byte[] identity = GetCellDirectoryIdentity(directory);
                ulong currentVolume = BitConverter.ToUInt64(identity, 0);
                if ((index != 0 && currentVolume != volume) || !seen.Add(Convert.ToBase64String(identity)))
                    throw new InvalidOperationException("REFUSED: capacity roots must be distinct on one volume.");
                volume = currentVolume; identity.CopyTo(record, 8 + index * 24);
            }
            return record;
        }

        public static byte[] CreateCellRuntimeCustody(string packageSha256, string bundleSha256, SafeFileHandle runtimeDirectory)
        {
            foreach (string pin in new string[] { packageSha256, bundleSha256 })
                if (pin == null || !System.Text.RegularExpressions.Regex.IsMatch(pin, "\\A[a-f0-9]{64}\\z") || pin == new string('0', 64))
                    throw new InvalidOperationException("REFUSED: independent package and runtime manifest pins are required.");
            byte[] identity = GetCellDirectoryIdentity(runtimeDirectory);
            byte[] record = new byte[96];
            Encoding.ASCII.GetBytes("GCRTCS01").CopyTo(record, 0);
            identity.CopyTo(record, 8);
            for (int index = 0; index < 32; index++)
            {
                record[32 + index] = Convert.ToByte(bundleSha256.Substring(index * 2, 2), 16);
                record[64 + index] = Convert.ToByte(packageSha256.Substring(index * 2, 2), 16);
            }
            return record;
        }

        private static string CanonicalPath(string path)
        {
            string full = Path.GetFullPath(path);
            if (full.Length < 4 || full.Length >= 512 || full[1] != ':' || full[2] != '\\' ||
                !string.Equals(full, path, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("REFUSED: a file path is not a canonical bounded drive path.");
            foreach (string part in full.Substring(3).Split('\\'))
            {
                if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" ") ||
                    part.IndexOfAny(new char[] { ':', '/', '*', '?', '"', '<', '>', '|' }) >= 0)
                    throw new InvalidOperationException("REFUSED: an ambiguous file path is not supported.");
                foreach (char value in part) if (value < 32) throw new InvalidOperationException("REFUSED: invalid file path.");
            }
            return full;
        }
        private static void Validate(SafeFileHandle handle, string expected, long maximum)
        {
            Information info;
            if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
            long length = ((long)info.SizeHigh << 32) | info.SizeLow;
            StringBuilder final = new StringBuilder(516);
            uint count = GetFinalPathNameByHandleW(handle, final, 516, 0);
            if (GetFileType(handle) != 1 || (info.Attributes & (0x10u | 0x400u)) != 0 || info.Links != 1 ||
                length < 0 || length > maximum || count == 0 || count >= 516 ||
                !string.Equals(final.ToString(), @"\\?\" + expected, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("REFUSED: file identity, link, size or final path differs.");
        }
        public static FileStream OpenRead(string path, long maximum)
        {
            return Open(path, maximum, false);
        }
        public static FileStream OpenForRemoval(string path, long maximum)
        {
            return Open(path, maximum, true);
        }
        private static FileStream Open(string path, long maximum, bool removal)
        {
            string full = CanonicalPath(path);
            SafeFileHandle handle = CreateFileW(full, 0x80000000u | (removal ? 0x00010000u : 0u), 1, IntPtr.Zero, 3, 0x00200000u, IntPtr.Zero);
            try
            {
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                Validate(handle, full, maximum);
                return new FileStream(handle, FileAccess.Read, 65536, false);
            }
            catch { handle.Dispose(); throw; }
        }
        public static void DeleteOpenedFile(FileStream stream)
        {
            int remove = 1;
            if (!SetFileInformationByHandle(stream.SafeFileHandle, 4, ref remove, 4))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        public static FileStream CreateProtectedFile(string path, string sddl, out bool created)
        {
            return CreateProtectedFile(path, sddl, false, out created);
        }
        public static FileStream CreateProtectedPublicationFile(string path, string sddl, out bool created)
        {
            return CreateProtectedFile(path, sddl, true, out created);
        }
        private static FileStream CreateProtectedFile(string path, string sddl, bool publication, out bool created)
        {
            created = false;
            string full = CanonicalPath(path);
            IntPtr descriptor = IntPtr.Zero, raw = IntPtr.Zero;
            uint bytes;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out descriptor, out bytes))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                Attributes attributes = new Attributes { Size = Marshal.SizeOf(typeof(Attributes)), Descriptor = descriptor, Inherit = 0 };
                raw = Marshal.AllocHGlobal(attributes.Size);
                Marshal.StructureToPtr(attributes, raw, false);
                // The final owner/DACL exist at CREATE_NEW, before any other process can open the file.
                SafeFileHandle handle = CreateFileW(full, 0xc0000000u | (publication ? 0x00010000u : 0u),
                    1, raw, 1, 0x00200000u, IntPtr.Zero);
                try
                {
                    if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                    created = true;
                    Validate(handle, full, 0);
                    return new FileStream(handle, FileAccess.ReadWrite, 65536, false);
                }
                catch { handle.Dispose(); throw; }
            }
            finally { if (raw != IntPtr.Zero) Marshal.FreeHGlobal(raw); LocalFree(descriptor); }
        }
        public static void PublishOpenedFile(FileStream stream, string source, string destination)
        {
            PublishOpenedFile(stream, source, destination, false);
        }
        public static void ReplaceOpenedMeshRegistrySelection(FileStream stream, string source, string destination)
        {
            if (Path.GetFileName(destination) != "mesh-registry.sha256" ||
                !Path.GetFileName(source).StartsWith("mesh-registry-selection-", StringComparison.Ordinal) ||
                !Path.GetFileName(source).EndsWith(".tmp", StringComparison.Ordinal) ||
                (stream.Length != 8 && stream.Length != 64))
                throw new InvalidOperationException("REFUSED: invalid mesh registry selection publication.");
            // The administrator recipe holds the configuration lock and checks
            // the expected selection. A running host's pinned read handle denies
            // replacement even if the service starts after stopped-state review.
            PublishOpenedFile(stream, source, destination, true);
        }
        private static void PublishOpenedFile(FileStream stream, string source, string destination, bool replace)
        {
            string from = CanonicalPath(source), to = CanonicalPath(destination);
            if (!string.Equals(Path.GetDirectoryName(from), Path.GetDirectoryName(to), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("REFUSED: publication must stay in its pinned directory.");
            Validate(stream.SafeFileHandle, from, 2097152);
            byte[] name = Encoding.Unicode.GetBytes(to);
            int offset = Marshal.OffsetOf(typeof(RenameInformation), "FileName").ToInt32();
            int length = checked(offset + name.Length + 2);
            IntPtr info = Marshal.AllocHGlobal(length);
            try
            {
                // Existing publication callers retain create-only semantics.
                Marshal.Copy(new byte[length], 0, info, length);
                if (replace) Marshal.WriteInt32(info, 1);
                Marshal.WriteInt32(info, Marshal.OffsetOf(typeof(RenameInformation), "FileNameLength").ToInt32(), name.Length);
                Marshal.Copy(name, 0, IntPtr.Add(info, offset), name.Length);
                if (!SetFileInformationByHandle(stream.SafeFileHandle, 3, info, (uint)length))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            finally { Marshal.FreeHGlobal(info); }
        }
        // Existing installer-owned empty file only. Exclusive sharing excludes
        // both controller/host reader leases without changing file contents.
        public static FileStream AcquireInstalledStateWriterGate(string path)
        {
            string full = CanonicalPath(path);
            SafeFileHandle handle = CreateFileW(full, 0x80000000u, 0, IntPtr.Zero, 3, 0x00200000u, IntPtr.Zero);
            try
            {
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                Validate(handle, full, 0);
                return new FileStream(handle, FileAccess.Read, 1, false);
            }
            catch { handle.Dispose(); throw; }
        }
        public static FileStream AcquireEnrollmentLock(string path)
        {
            string full = CanonicalPath(path);
            // The caller pins an administrator-only directory before this
            // OPEN_ALWAYS. An existing file must remain empty and unaliased.
            SafeFileHandle handle = CreateFileW(full, 0xc0000000u, 0, IntPtr.Zero, 4, 0x00200000u, IntPtr.Zero);
            try
            {
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                Validate(handle, full, 0);
                return new FileStream(handle, FileAccess.ReadWrite, 1, false);
            }
            catch { handle.Dispose(); throw; }
        }
        private sealed class ServiceLease : SafeHandleZeroOrMinusOneIsInvalid
        {
            public readonly bool CellController;
            public ServiceLease(IntPtr service, bool cellController = false) : base(true) { SetHandle(service); CellController = cellController; }
            protected override bool ReleaseHandle() { return CloseServiceHandle(handle); }
        }
        public static IDisposable CreateStoppedCellControllerService(string image)
        {
            string full = CanonicalPath(image);
            string drive = Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.Windows));
            string expected = drive + @"ProgramData\GoatCitadel\RemoteWorker\payload\app\worker\native\GoatCitadelRemoteWorkerCellController.exe";
            if (!string.Equals(full, expected, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("REFUSED: the controller service image has the wrong installed path.");
            IntPtr manager = OpenSCManagerW(null, null, 3);
            if (manager == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                IntPtr service = CreateServiceW(manager, "GoatCitadelRemoteWorkerCellController", "GoatCitadel Remote Worker Cell Controller",
                    0x000f01ffu, 16, 3, 1, "\"" + full + "\"", null, IntPtr.Zero, null, "LocalSystem", null);
                if (service == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                return new ServiceLease(service, true);
            }
            finally { CloseServiceHandle(manager); }
        }
        public static void ConfigureCellControllerPrivileges(IDisposable createdService)
        {
            ServiceLease lease = createdService as ServiceLease;
            if (lease == null || !lease.CellController) throw new InvalidOperationException("REFUSED: only a controller created by this invocation can be configured.");
            bool retained = false;
            IntPtr text = IntPtr.Zero, info = IntPtr.Zero;
            try
            {
                lease.DangerousAddRef(ref retained);
                text = Marshal.StringToHGlobalUni("SeChangeNotifyPrivilege\0SeManageVolumePrivilege\0");
                info = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(info, text);
                if (!ChangeServiceConfig2W(lease.DangerousGetHandle(), 6, info)) throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            finally
            {
                if (info != IntPtr.Zero) Marshal.FreeHGlobal(info);
                if (text != IntPtr.Zero) Marshal.FreeHGlobal(text);
                if (retained) lease.DangerousRelease();
            }
        }
        public static IDisposable CreateStoppedWorkerService(string image)
        {
            string full = CanonicalPath(image);
            if (!full.EndsWith(@"\payload\bin\GoatCitadelRemoteWorkerHost.exe", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("REFUSED: the worker service image has the wrong layout.");
            IntPtr manager = OpenSCManagerW(null, null, 3);
            if (manager == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                IntPtr service = CreateServiceW(manager, "GoatCitadelRemoteWorker", "GoatCitadel Remote Worker",
                    0x000f01ffu, 16, 3, 1, "\"" + full + "\"", null, IntPtr.Zero, null,
                    @"NT SERVICE\GoatCitadelRemoteWorker", null);
                if (service == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                // Keep the SCM name reserved through configuration and rollback.
                return new ServiceLease(service);
            }
            finally { CloseServiceHandle(manager); }
        }
    }
}
