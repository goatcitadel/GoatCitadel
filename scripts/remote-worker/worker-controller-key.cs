using System;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;

namespace GoatCitadel.RemoteWorker.Install
{
    // Installer-only. Merely loading this type performs no key operation.
    public static class ControllerKey
    {
        public const string Name = "GoatCitadel.CellController.Attestation.v1";
        private const string ControllerSid = "S-1-5-80-1810587747-2867442932-4204439414-1143594691-3479143721";
        private const string Provider = "Microsoft Software Key Storage Provider";
        [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)]
        private static extern int NCryptOpenStorageProvider(out IntPtr provider, string name, uint flags);
        [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)]
        private static extern int NCryptCreatePersistedKey(IntPtr provider, out IntPtr key, string algorithm, string name, uint legacy, uint flags);
        [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)]
        private static extern int NCryptSetProperty(IntPtr key, string name, byte[] value, uint size, uint flags);
        [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)]
        private static extern int NCryptGetProperty(IntPtr key, string name, byte[] value, uint size, out uint written, uint flags);
        [DllImport("ncrypt.dll")]
        private static extern int NCryptFinalizeKey(IntPtr key, uint flags);
        [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)]
        private static extern int NCryptExportKey(IntPtr key, IntPtr wrapping, string format, IntPtr parameters, byte[] value, uint size, out uint written, uint flags);
        [DllImport("ncrypt.dll")]
        private static extern int NCryptFreeObject(IntPtr handle);
        private static void Check(int status)
        {
            if (status != 0) throw new InvalidOperationException("Controller key operation refused (0x" + unchecked((uint)status).ToString("x8") + "). Preserve any created key for operator recovery.");
        }
        private static byte[] Get(IntPtr key, string property, uint flags)
        {
            byte[] bytes = new byte[4096]; uint count;
            Check(NCryptGetProperty(key, property, bytes, (uint)bytes.Length, out count, flags));
            if (count == 0 || count > bytes.Length) throw new InvalidOperationException("Invalid controller key property length.");
            Array.Resize(ref bytes, (int)count); return bytes;
        }
        private static void AssertDword(IntPtr key, string property, uint expected)
        {
            byte[] bytes = Get(key, property, 0);
            if (bytes.Length != 4 || BitConverter.ToUInt32(bytes, 0) != expected) throw new InvalidOperationException("Controller key policy differs.");
        }
        // Exposed for non-mutating descriptor tests; no key creation occurs.
        public static void ValidateSecurity(byte[] bytes)
        {
            RawSecurityDescriptor sd = new RawSecurityDescriptor(bytes, 0);
            if (sd.Owner == null || sd.Owner.Value != "S-1-5-18" ||
                (sd.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0 || sd.DiscretionaryAcl == null || sd.DiscretionaryAcl.Count != 2)
                throw new InvalidOperationException("Controller signing key security differs.");
            bool system = false, controller = false;
            foreach (GenericAce item in sd.DiscretionaryAcl)
            {
                CommonAce ace = item as CommonAce;
                if (ace == null || ace.IsCallback || ace.AceQualifier != AceQualifier.AccessAllowed || ace.AceFlags != AceFlags.None ||
                    (ace.AccessMask != 0x10000000 && ace.AccessMask != 0x1f01ff)) throw new InvalidOperationException("Controller signing key grants differ.");
                if (ace.SecurityIdentifier.Value == "S-1-5-18" && !system) system = true;
                else if (ace.SecurityIdentifier.Value == ControllerSid && !controller) controller = true;
                else throw new InvalidOperationException("Unexpected controller key principal.");
            }
            if (!system || !controller) throw new InvalidOperationException("Controller key principals are incomplete.");
        }
        public static string CreateMachineKey()
        {
            IntPtr provider = IntPtr.Zero, key = IntPtr.Zero;
            try
            {
                Check(NCryptOpenStorageProvider(out provider, Provider, 0));
                // No overwrite/reuse flag. An existing key must be reviewed by
                // an operator, never silently adopted by a fresh installation.
                Check(NCryptCreatePersistedKey(provider, out key, "ECDSA_P256", Name, 0, 0x20 | 0x40));
                Check(NCryptSetProperty(key, "Export Policy", BitConverter.GetBytes((uint)0), 4, 0));
                Check(NCryptSetProperty(key, "Key Usage", BitConverter.GetBytes((uint)2), 4, 0));
                Check(NCryptFinalizeKey(key, 0x40));
                RawSecurityDescriptor descriptor = new RawSecurityDescriptor("O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;" + ControllerSid + ")");
                byte[] security = new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(security, 0);
                Check(NCryptSetProperty(key, "Security Descr", security, (uint)security.Length, 0x7));
                ValidateSecurity(Get(key, "Security Descr", 0x5));
                AssertDword(key, "Export Policy", 0); AssertDword(key, "Key Usage", 2); AssertDword(key, "Key Type", 0x20);
                byte[] publicBlob = new byte[72]; uint count;
                Check(NCryptExportKey(key, IntPtr.Zero, "ECCPUBLICBLOB", IntPtr.Zero, publicBlob, 72, out count, 0));
                if (count != 72 || BitConverter.ToUInt32(publicBlob, 0) != 0x31534345 || BitConverter.ToUInt32(publicBlob, 4) != 32)
                    throw new InvalidOperationException("Controller key is not ECDSA P-256.");
                return "04" + BitConverter.ToString(publicBlob, 8, 64).Replace("-", "").ToLowerInvariant();
            }
            finally
            {
                if (key != IntPtr.Zero) NCryptFreeObject(key);
                if (provider != IntPtr.Zero) NCryptFreeObject(provider);
            }
        }
    }
}
