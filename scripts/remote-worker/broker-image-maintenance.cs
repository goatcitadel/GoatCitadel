using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace GoatCitadel.RemoteWorker.BrokerCoordinator {
    public sealed class ExistingServiceLease : IDisposable {
        readonly IntPtr manager, service;
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern IntPtr OpenSCManagerW(string machine, string database, uint access);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern IntPtr OpenServiceW(IntPtr manager, string name, uint access);
        [DllImport("advapi32.dll")] static extern bool CloseServiceHandle(IntPtr handle);
        [DllImport("advapi32.dll", SetLastError=true)]
        static extern bool QueryServiceStatusEx(IntPtr service, int level, [Out] byte[] bytes, uint length, out uint needed);
        public ExistingServiceLease(string name) {
            if (name != "GoatCitadelRemoteWorkerProvisioner" && name != "GoatCitadelRemoteWorkerProvisionerAvailability")
                throw new InvalidOperationException("Only the fixed broker/signer services can be retained.");
            manager=OpenSCManagerW(null,null,1);
            if (manager == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            service=OpenServiceW(manager,name,0x00020005);
            if (service == IntPtr.Zero) { int error=Marshal.GetLastWin32Error(); CloseServiceHandle(manager); throw new Win32Exception(error); }
        }
        public void AssertStopped() {
            var bytes=new byte[36]; uint needed;
            if (!QueryServiceStatusEx(service,0,bytes,36,out needed)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (BitConverter.ToUInt32(bytes,0) != 16 || BitConverter.ToUInt32(bytes,4) != 1 ||
                BitConverter.ToUInt32(bytes,28) != 0 || BitConverter.ToUInt32(bytes,32) != 0)
                throw new InvalidOperationException("Both services must already be stopped with no PID; preserve this installation.");
        }
        public void Dispose() { CloseServiceHandle(service); CloseServiceHandle(manager); }
    }
    // Maintenance of existing, pinned executable bytes only. No directory,
    // service, key, owner, permission, volume or process-control mutations.
    public sealed class ImageMaintenanceLease : IDisposable {
        readonly SafeFileHandle handle;
        readonly FileStream stream;
        readonly string path, identity, security, originalHash;
        readonly byte[] original;
        readonly bool writable;
        const int MaximumBytes = 64 * 1024 * 1024;

        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool GetFileInformationByHandle(SafeFileHandle file, [Out] byte[] information);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint length, uint flags);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool GetVolumeInformationByHandleW(SafeFileHandle file, IntPtr name, uint nameSize,
            IntPtr serial, IntPtr maximumComponent, IntPtr flags, StringBuilder filesystem, uint filesystemSize);
        [DllImport("advapi32.dll", SetLastError=true)]
        static extern bool GetKernelObjectSecurity(SafeFileHandle file, uint information, [Out] byte[] descriptor, uint size, out uint needed);
        [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
        struct StreamData { public long size; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=296)] public string name; }
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern IntPtr FindFirstStreamW(string path, int level, out StreamData data, uint flags);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool FindNextStreamW(IntPtr find, out StreamData data);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool FindClose(IntPtr find);

        ImageMaintenanceLease(SafeFileHandle value, string expectedPath, string expectedHash, string expectedSddl, bool write) {
            handle=value; path=expectedPath; writable=write;
            try {
                identity=ReadIdentity();
                var descriptor=ReadSecurity();
                if (ComparableSecurity(descriptor) != ComparableSecurity(new RawSecurityDescriptor(expectedSddl)))
                    throw new InvalidOperationException("Installed executable security differs from the reviewed descriptor.");
                security=descriptor.GetSddlForm(AccessControlSections.All);
                stream=new FileStream(handle, write ? FileAccess.ReadWrite : FileAccess.Read, 65536, false);
                original=ReadBytes(); originalHash=Hash(original);
                if (!String.Equals(originalHash, expectedHash, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Installed executable hash mismatch: " + path);
            } catch { if (stream != null) stream.Dispose(); handle.Dispose(); throw; }
        }
        static string ComparableSecurity(RawSecurityDescriptor value) {
            // Match the installer's explicit-ACE comparison: AI is bookkeeping,
            // not an inherited ACE. Retain every actual flag in security below.
            var copy=new RawSecurityDescriptor(value.GetSddlForm(AccessControlSections.All));
            copy.SetFlags(copy.ControlFlags & ~ControlFlags.DiscretionaryAclAutoInherited);
            return copy.GetSddlForm(AccessControlSections.Owner | AccessControlSections.Access);
        }
        public static ImageMaintenanceLease Open(string file, string expectedHash, string expectedSddl, bool write) {
            return OpenFixed(file, expectedHash, expectedSddl, write, false);
        }
        public static ImageMaintenanceLease OpenClientReplacement(string file, string expectedHash, string expectedSddl) {
            if (System.IO.Path.GetFileName(file) != "GoatCitadelRemoteWorkerProvisionerClient.exe")
                throw new InvalidOperationException("Explicit client maintenance requires the fixed client image.");
            return OpenFixed(file, expectedHash, expectedSddl, true, true);
        }
        static ImageMaintenanceLease OpenFixed(string file, string expectedHash, string expectedSddl, bool write, bool clientReplacement) {
            string expected=System.IO.Path.GetFullPath(file);
            string leaf=System.IO.Path.GetFileName(expected);
            if (expected.Length < 4 || expected[1] != ':' || expected[2] != '\\' || expected.IndexOf(':', 2) >= 0 ||
                (leaf != "GoatCitadelRemoteWorkerProvisioner.exe" && leaf != "GoatCitadelRemoteWorkerProvisionerAvailability.exe" &&
                 ((write && !clientReplacement) || leaf != "GoatCitadelRemoteWorkerProvisionerClient.exe")))
                throw new InvalidOperationException("Only fixed broker/signer images can be updated.");
            // OPEN_EXISTING never creates/truncates. With backup/restore enabled
            // only in the maintenance process, no installed DACL must be changed.
            // Exclusive write handles exclude new image loaders and other writers.
            var handle=CreateFileW(expected, write ? 0xc0020000U : 0x80020000U,
                write ? 0U : 1U, IntPtr.Zero, 3U, 0x02200000U, IntPtr.Zero);
            if (handle.IsInvalid) { int error=Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
            return new ImageMaintenanceLease(handle, expected, expectedHash, expectedSddl, write);
        }
        string ReadIdentity() {
            var information=new byte[52];
            if (!GetFileInformationByHandle(handle, information)) throw new Win32Exception(Marshal.GetLastWin32Error());
            uint attributes=BitConverter.ToUInt32(information, 0);
            if ((attributes & ~0x2020U) != 0 || BitConverter.ToUInt32(information, 40) != 1)
                throw new InvalidOperationException("Executable is not an ordinary single-link file.");
            var finalPath=new StringBuilder(32768);
            uint length=GetFinalPathNameByHandleW(handle, finalPath, (uint)finalPath.Capacity, 0);
            if (length == 0 || length >= finalPath.Capacity ||
                !String.Equals(finalPath.ToString(), @"\\?\" + path, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Executable path is aliased or unavailable.");
            var filesystem=new StringBuilder(32);
            if (!GetVolumeInformationByHandleW(handle, IntPtr.Zero, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, filesystem, 32) || filesystem.ToString() != "NTFS")
                throw new InvalidOperationException("Executable must be on NTFS.");
            StreamData data;
            IntPtr find=FindFirstStreamW(path, 0, out data, 0);
            if (find == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                if (data.name != "::$DATA" || FindNextStreamW(find, out data) || Marshal.GetLastWin32Error() != 38)
                    throw new InvalidOperationException("Unexpected executable stream inventory.");
            } finally { FindClose(find); }
            return BitConverter.ToUInt32(information,28).ToString("x8") + ":" +
                BitConverter.ToUInt32(information,44).ToString("x8") + BitConverter.ToUInt32(information,48).ToString("x8");
        }
        RawSecurityDescriptor ReadSecurity() {
            var bytes=new byte[8192]; uint needed;
            if (!GetKernelObjectSecurity(handle, 7, bytes, (uint)bytes.Length, out needed)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (needed < 20 || needed > bytes.Length) throw new InvalidDataException("Executable security exceeds bounds.");
            return new RawSecurityDescriptor(bytes, 0);
        }
        void VerifyIdentity() {
            if (identity != ReadIdentity() || security != ReadSecurity().GetSddlForm(AccessControlSections.All))
                throw new InvalidOperationException("Executable identity or security changed during maintenance.");
        }
        byte[] ReadBytes() {
            if (stream.Length <= 0 || stream.Length > MaximumBytes) throw new InvalidDataException("Executable size exceeds bounds.");
            stream.Position=0; var bytes=new byte[(int)stream.Length]; int total=0;
            while (total < bytes.Length) { int count=stream.Read(bytes,total,bytes.Length-total); if (count == 0) throw new EndOfStreamException(); total+=count; }
            return bytes;
        }
        static string Hash(byte[] bytes) { using (var sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
        public string Path { get { return path; } }
        public string Identity { get { return identity; } }
        public string OriginalSha256 { get { return originalHash; } }
        public string SecuritySddl { get { return security; } }
        public string CurrentSha256 { get { VerifyIdentity(); return Hash(ReadBytes()); } }
        public void SaveOriginal(string backup) {
            VerifyIdentity();
            using (var file=new FileStream(backup, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) {
                file.Write(original,0,original.Length); file.Flush(true);
            }
        }
        public void Replace(byte[] bytes, string expectedHash) {
            if (!writable) throw new InvalidOperationException("Read-only preflight cannot update an image.");
            if (bytes == null || bytes.Length == 0 || bytes.Length > MaximumBytes ||
                !String.Equals(Hash(bytes),expectedHash,StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Replacement executable hash/size mismatch.");
            VerifyIdentity();
            stream.Position=0; stream.Write(bytes,0,bytes.Length); stream.SetLength(bytes.Length); stream.Flush(true);
            if (CurrentSha256 != expectedHash.ToLowerInvariant()) throw new IOException("Replacement executable read-back failed.");
        }
        public void RestoreOriginal() { Replace(original,originalHash); }
        public void Dispose() { if (stream != null) stream.Dispose(); handle.Dispose(); }
    }
}
