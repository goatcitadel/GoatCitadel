using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace GoatCitadel.RemoteWorker.BrokerCoordinator
{
    // Installer-only directory operations. No file payload, key, service or disk APIs.
    public sealed class StateDirectoryLease : IDisposable
    {
        private readonly SafeFileHandle handle;
        private readonly string path;
        private readonly bool created;
        private readonly string identity;

        [StructLayout(LayoutKind.Sequential)]
        private struct UnicodeString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
        [StructLayout(LayoutKind.Sequential)]
        private struct ObjectAttributes
        {
            public uint Length; public IntPtr RootDirectory; public IntPtr ObjectName;
            public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct IoStatusBlock { public IntPtr Status; public UIntPtr Information; }

        [DllImport("ntdll.dll", ExactSpelling = true)]
        private static extern int NtCreateFile(out IntPtr file, uint access, ref ObjectAttributes attributes,
            out IoStatusBlock io, IntPtr allocation, uint fileAttributes, uint share, uint disposition,
            uint options, IntPtr ea, uint eaLength);
        [DllImport("ntdll.dll", ExactSpelling = true)]
        private static extern uint RtlNtStatusToDosError(int status);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
            IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle file, [Out] byte[] information);
        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        private static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, [Out] byte[] data, uint size);
        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        private static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, byte[] data, uint size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder name, uint size, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern bool GetVolumeInformationByHandleW(SafeFileHandle file, IntPtr name, uint nameSize,
            IntPtr serial, IntPtr maximumComponent, IntPtr flags, StringBuilder filesystem, uint filesystemSize);
        [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
        private static extern bool GetKernelObjectSecurity(SafeFileHandle file, uint information,
            [Out] byte[] descriptor, uint size, out uint needed);
        [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
        private static extern bool SetKernelObjectSecurity(SafeFileHandle file, uint information, byte[] descriptor);

        private StateDirectoryLease(SafeFileHandle value, string expectedPath, bool owned)
        {
            handle = value; path = expectedPath; created = owned;
            identity = ReadIdentity(false);
        }

        public string Path { get { return path; } }
        public string Identity { get { return identity; } }

        public static StateDirectoryLease OpenParent(string directory)
        {
            string expected = System.IO.Path.GetFullPath(directory).TrimEnd('\\');
            // List + attributes + READ_CONTROL; deny delete sharing throughout creation.
            SafeFileHandle file = CreateFileW(expected, 0x00020081u, 3u, IntPtr.Zero, 3u, 0x02200000u, IntPtr.Zero);
            if (file.IsInvalid) { int error = Marshal.GetLastWin32Error(); file.Dispose(); throw new Win32Exception(error); }
            try { return new StateDirectoryLease(file, expected, false); }
            catch { file.Dispose(); throw; }
        }

        public static StateDirectoryLease CreateChild(StateDirectoryLease parent, string name, string sddl)
        {
            if (parent == null || (name != "state-v1" && name != "journal" && name != "keysets" &&
                name != "controls" && name != "quarantine")) throw new InvalidOperationException("Unknown state component.");
            if (parent.identity != parent.ReadIdentity(false)) throw new InvalidOperationException("Parent identity changed.");
            RawSecurityDescriptor security = new RawSecurityDescriptor(sddl);
            byte[] securityBytes = new byte[security.BinaryLength]; security.GetBinaryForm(securityBytes, 0);
            GCHandle securityPin = GCHandle.Alloc(securityBytes, GCHandleType.Pinned);
            IntPtr text = Marshal.StringToHGlobalUni(name);
            IntPtr unicode = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
            bool retained = false;
            try
            {
                UnicodeString component = new UnicodeString();
                component.Length = checked((ushort)(name.Length * 2));
                component.MaximumLength = checked((ushort)(component.Length + 2)); component.Buffer = text;
                Marshal.StructureToPtr(component, unicode, false);
                parent.handle.DangerousAddRef(ref retained);
                ObjectAttributes attributes = new ObjectAttributes();
                attributes.Length = (uint)Marshal.SizeOf(typeof(ObjectAttributes));
                attributes.RootDirectory = parent.handle.DangerousGetHandle(); attributes.ObjectName = unicode;
                attributes.Attributes = 0x40u; attributes.SecurityDescriptor = securityPin.AddrOfPinnedObject();
                IntPtr raw; IoStatusBlock io;
                // FILE_CREATE exclusively, relative to the held parent. Backup intent
                // lets the elevated installer use SeRestorePrivilege without granting
                // Administrators access to the protected state or changing parent ACLs.
                int status = NtCreateFile(out raw, 0x001f0181u, ref attributes, out io, IntPtr.Zero,
                    0x10u, 3u, 2u, 0x00204021u, IntPtr.Zero, 0u);
                if (status < 0) throw new Win32Exception((int)RtlNtStatusToDosError(status));
                SafeFileHandle file = new SafeFileHandle(raw, true);
                StateDirectoryLease result = null;
                try
                {
                    if (io.Information.ToUInt64() != 2u) throw new InvalidOperationException("State directory was not newly created.");
                    result = new StateDirectoryLease(file, System.IO.Path.Combine(parent.path, name), true);
                    if (result.ReadEntries().Length != 0) throw new InvalidOperationException("New state directory is not empty.");
                    // Normalize only this newly created empty directory. ProgramData
                    // commonly propagates NOT_CONTENT_INDEXED, which the signer refuses
                    // in its fixed-child inventory. Preserve all timestamps.
                    uint initialAttributes = result.ReadAttributes();
                    if ((initialAttributes & ~0x2010u) != 0u) throw new InvalidOperationException("Unexpected new directory attributes.");
                    byte[] basic = new byte[40]; BitConverter.GetBytes(0x10u).CopyTo(basic, 32);
                    if (!SetFileInformationByHandle(file, 0, basic, (uint)basic.Length)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    // Include explicit owner AND primary group; retain no inherited or
                    // auto-inheritance bookkeeping flags in the signer's exact state ACL.
                    if (!SetKernelObjectSecurity(file, 0x80000007u, securityBytes)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    result.Verify(sddl, new string[0]);
                    return result;
                }
                catch
                {
                    try { if (result != null) result.RemoveCreatedEmpty(); }
                    finally { file.Dispose(); }
                    throw;
                }
            }
            finally
            {
                if (retained) parent.handle.DangerousRelease();
                Marshal.FreeHGlobal(unicode); Marshal.FreeHGlobal(text); securityPin.Free();
            }
        }

        private uint ReadAttributes()
        {
            byte[] data = new byte[52];
            if (!GetFileInformationByHandle(handle, data)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return BitConverter.ToUInt32(data, 0);
        }

        private string ReadIdentity(bool exactAttributes)
        {
            byte[] data = new byte[52];
            if (!GetFileInformationByHandle(handle, data)) throw new Win32Exception(Marshal.GetLastWin32Error());
            uint attributes = BitConverter.ToUInt32(data, 0);
            if ((attributes & 0x410u) != 0x10u || (exactAttributes && attributes != 0x10u) ||
                BitConverter.ToUInt32(data, 40) != 1u) throw new InvalidOperationException("State directory type, attributes or links differ.");
            StringBuilder actual = new StringBuilder(512);
            uint length = GetFinalPathNameByHandleW(handle, actual, 512u, 0u);
            if (length == 0u) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (length >= 512u || !string.Equals(actual.ToString(), @"\\?\" + path, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("State directory resolves through an alias.");
            StringBuilder filesystem = new StringBuilder(16);
            if (!GetVolumeInformationByHandleW(handle, IntPtr.Zero, 0u, IntPtr.Zero, IntPtr.Zero,
                IntPtr.Zero, filesystem, 16u)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (filesystem.ToString() != "NTFS") throw new InvalidOperationException("State requires NTFS.");
            return BitConverter.ToUInt32(data, 28).ToString("x8") + ":" +
                BitConverter.ToUInt32(data, 44).ToString("x8") + BitConverter.ToUInt32(data, 48).ToString("x8");
        }

        private byte[] ReadSecurityDescriptor()
        {
            byte[] data = new byte[4096]; uint needed;
            if (!GetKernelObjectSecurity(handle, 7u, data, (uint)data.Length, out needed)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (needed == 0u || needed > (uint)data.Length) throw new InvalidOperationException("State security descriptor length is invalid.");
            return data;
        }

        public string ReadSecuritySddl()
        {
            return new RawSecurityDescriptor(ReadSecurityDescriptor(), 0).GetSddlForm(AccessControlSections.Owner | AccessControlSections.Group | AccessControlSections.Access);
        }

        public static void AssertSecurity(string actualSddl, string expectedSddl)
        {
            AssertSecurity(new RawSecurityDescriptor(actualSddl), expectedSddl);
        }

        public static void AssertSecurityBytes(byte[] actual, string expectedSddl)
        {
            AssertSecurity(new RawSecurityDescriptor(actual, 0), expectedSddl);
        }

        private static void AssertSecurity(RawSecurityDescriptor actual, string expectedSddl)
        {
            RawSecurityDescriptor expected = new RawSecurityDescriptor(expectedSddl);
            // RawSecurityDescriptor preserves ACE order; FileSecurity may reorder it.
            if (actual.Owner == null || actual.Group == null || actual.DiscretionaryAcl == null ||
                actual.Owner != expected.Owner || actual.Group != expected.Group ||
                actual.ControlFlags != expected.ControlFlags || actual.DiscretionaryAcl.Count != expected.DiscretionaryAcl.Count)
                throw new InvalidOperationException("State owner, group or DACL controls differ.");
            byte[] a = new byte[actual.DiscretionaryAcl.BinaryLength]; actual.DiscretionaryAcl.GetBinaryForm(a, 0);
            byte[] b = new byte[expected.DiscretionaryAcl.BinaryLength]; expected.DiscretionaryAcl.GetBinaryForm(b, 0);
            if (a.Length != b.Length) throw new InvalidOperationException("State ACL size differs.");
            for (int index = 0; index < a.Length; ++index)
                if (a[index] != b[index]) throw new InvalidOperationException("State ACL differs.");
        }

        public string[] ReadEntries()
        {
            List<string> entries = new List<string>(); byte[] data = new byte[65536]; int kind = 11;
            while (true)
            {
                if (!GetFileInformationByHandleEx(handle, kind, data, (uint)data.Length))
                {
                    int error = Marshal.GetLastWin32Error();
                    if (error == 18) break;
                    throw new Win32Exception(error);
                }
                kind = 10; int offset = 0;
                while (true)
                {
                    if (offset > data.Length - 104) throw new InvalidOperationException("Malformed directory entry.");
                    uint next = BitConverter.ToUInt32(data, offset); uint length = BitConverter.ToUInt32(data, offset + 60);
                    if (length == 0 || (length & 1u) != 0 || length > (uint)(data.Length - offset - 104))
                        throw new InvalidOperationException("Malformed directory name.");
                    string name = Encoding.Unicode.GetString(data, offset + 104, (int)length);
                    if (name != "." && name != "..") entries.Add(name);
                    if (entries.Count > 4) throw new InvalidOperationException("Unexpected state directory content; preserve it.");
                    if (next == 0) break;
                    if (next < 104 + length || next > (uint)(data.Length - offset - 104))
                        throw new InvalidOperationException("Malformed directory offset.");
                    offset += (int)next;
                }
            }
            entries.Sort(StringComparer.Ordinal); return entries.ToArray();
        }

        public void Verify(string sddl, string[] expectedChildren)
        {
            if (identity != ReadIdentity(true)) throw new InvalidOperationException("State directory identity changed.");
            AssertSecurityBytes(ReadSecurityDescriptor(), sddl);
            string[] actual = ReadEntries(); string[] expected = (string[])expectedChildren.Clone();
            Array.Sort(expected, StringComparer.Ordinal);
            if (actual.Length != expected.Length) throw new InvalidOperationException("State directory inventory differs; preserve it.");
            for (int index = 0; index < actual.Length; ++index)
                if (actual[index] != expected[index]) throw new InvalidOperationException("State directory inventory differs; preserve it.");
        }

        public void RemoveCreatedEmpty()
        {
            if (!created) throw new InvalidOperationException("Only a directory created by this lease can be removed.");
            if (ReadEntries().Length != 0) throw new InvalidOperationException("State directory is not empty; preserve it.");
            if (!SetFileInformationByHandle(handle, 4, new byte[] { 1 }, 1u)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        public void Dispose() { handle.Dispose(); }
    }
}
