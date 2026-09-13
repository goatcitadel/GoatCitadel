#Requires -Version 5.1
<#
.SYNOPSIS
  Frozen M2 availability-broker coordinator recipe constants and helpers.

.DESCRIPTION
  This file freezes the administrator-owned installer recipe for the
  production-dark GoatCitadel remote-worker availability broker
  (HX-501 / MASTER_COMPLETION_PROGRAM.md M2). Every security-critical value in
  this file is DERIVED FROM and pinned against the broker's own validation
  code; the contract test scripts/remote-worker/install-broker-coordinator.test.mjs
  cross-checks these constants against the native sources on every
  verify:repo:hygiene run. Do not edit a value here without editing the native
  source it mirrors, and vice versa.

  Source of law:
    apps/remote-worker-provisioner-windows-native/src/availability_broker.hpp
    apps/remote-worker-provisioner-windows-native/src/availability_broker.cpp
    apps/remote-worker-provisioner-windows-native/src/availability_broker_runtime.cpp
    apps/remote-worker-provisioner-windows-native/src/service_runtime.cpp

  The distinct shipped coordinator principal is the broker's virtual service
  account "NT SERVICE\GoatCitadelRemoteWorkerProvisionerAvailability"
  (S-1-5-80-938203738-3606080319-1885328063-149464327-2394007130). It is
  materialized by the Service Control Manager when the broker service is
  created with SERVICE_SID_TYPE_UNRESTRICTED; it has no password and no
  account object, and the broker refuses to run unless its own token carries
  exactly this SID enabled and owner
  (availability_broker_runtime.cpp kBrokerServiceSidParts +
  ValidateServiceProcessToken).

  This library performs NO Service Control Manager mutation by itself; every
  mutating entry point lives in install-broker-coordinator.ps1 and
  uninstall-broker-coordinator.ps1 and is administrator-gated there. Nothing
  in this recipe ever wires the untrusted helper/client to start a service:
  the recipe contains no service-start call of any kind. Installing the pinned
  client image grants the dedicated worker only signer query access, never
  service start, stop, or configuration authority.
#>

Set-StrictMode -Version Latest

# --- Frozen identity constants -----------------------------------------------
# availability_broker.hpp kAvailabilityBrokerServiceName /
# kAvailabilityBrokerExecutableName.
$script:BrokerServiceName = "GoatCitadelRemoteWorkerProvisionerAvailability"
$script:BrokerExecutableName = "GoatCitadelRemoteWorkerProvisionerAvailability.exe"
$script:BrokerDisplayName = "GoatCitadel Remote Worker Provisioner Availability Broker"
# availability_broker_runtime.cpp kTargetServiceName / kTargetExecutableName.
$script:SignerServiceName = "GoatCitadelRemoteWorkerProvisioner"
$script:SignerExecutableName = "GoatCitadelRemoteWorkerProvisioner.exe"
$script:SignerDisplayName = "GoatCitadel Remote Worker Provisioner"
# The untrusted helper is installed with read/execute access only. Its worker
# caller receives only signer query access (also enforced by the PE import
# closure in scripts/packaging/build-remote-worker-provisioner-windows-native.mjs).
$script:ClientExecutableName = "GoatCitadelRemoteWorkerProvisionerClient.exe"

# availability_broker_runtime.cpp kProgramDataSuffix. The broker composes this
# literal onto the SystemRoot volume drive; it does NOT read %ProgramData%.
$script:ProgramDataSuffix = "\ProgramData\GoatCitadel\RemoteWorkerProvisioner\bin\"

# --- Frozen coordinator principal --------------------------------------------
# availability_broker_runtime.cpp kBrokerServiceSidParts. Derived by the SCM as
# S-1-5-80-{SHA-1(uppercase UTF-16LE service name)} when the service is
# installed with SERVICE_SID_TYPE_UNRESTRICTED.
$script:CoordinatorPrincipalName = "NT SERVICE\GoatCitadelRemoteWorkerProvisionerAvailability"
$script:BrokerServiceSid = "S-1-5-80-938203738-3606080319-1885328063-149464327-2394007130"
# availability_broker_runtime.cpp kTargetServiceSidParts (the signer's own
# virtual service account, validated by both the broker and the signer).
$script:SignerServiceSid = "S-1-5-80-1765223994-2719708455-3112291649-2938929260-976374647"
# local_transport.hpp kRuntimeWorkerSidParts: the dedicated runtime worker.
$script:RuntimeWorkerServiceSid = "S-1-5-80-1804173726-3601835665-1843708740-3959121232-3866049905"

# --- Frozen service configuration --------------------------------------------
# availability_broker.cpp ValidateCommonServiceConfiguration: the broker
# refuses to run unless BOTH the broker and the signer services carry exactly
# this configuration.
$script:ExpectedServiceType = 16          # SERVICE_WIN32_OWN_PROCESS (0x10)
$script:ExpectedStartType = 3             # SERVICE_DEMAND_START
$script:ExpectedErrorControl = 1          # SERVICE_ERROR_NORMAL
$script:ExpectedServiceAccount = "LocalSystem"  # exact literal, case-sensitive
$script:ExpectedServiceSidType = 1        # SERVICE_SID_TYPE_UNRESTRICTED (winsvc.h)
# availability_broker.cpp kRequiredPrivileges: exactly one required privilege.
$script:ExpectedRequiredPrivilege = "SeChangeNotifyPrivilege"
$script:ServiceStoppedState = 1           # SERVICE_STOPPED
# QueryServiceStatusEx dwWin32ExitCode observed on a service that has never
# been started since boot. The broker accepts 1077 only for an exact stopped
# signer with no process, checkpoint, wait hint or service-specific error.
# Active states and broker startup still require NO_ERROR (0).
$script:ServiceNeverStartedExitCode = 1077

# --- Frozen broker SCM DACL --------------------------------------------------
# availability_broker.cpp: owner SYSTEM; protected, non-inheriting DACL with
# exactly two ACEs in this order:
#   1. LocalSystem (SY)             -> SERVICE_ALL_ACCESS               0x000F01FF
#   2. BUILTIN\Administrators (BA)  -> SERVICE_START | SERVICE_STOP |
#      SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS | READ_CONTROL |
#      SYNCHRONIZE                                                     0x00120035
# The worker receives no ACE on the broker. Start authority over the broker is
# SYSTEM plus elevated Administrators only; the shipped coordinator principal
# (the broker's own unrestricted service SID, running from the LocalSystem
# account) is the only shipped identity that starts the signer.
$script:ServiceObjectSddl = "O:SYD:P(A;;0x000f01ff;;;SY)(A;;0x00120035;;;BA)"
# The signer adds one non-inherited worker ACE: SERVICE_QUERY_CONFIG |
# SERVICE_QUERY_STATUS | READ_CONTROL (0x00020005). It grants no service
# start/stop/change rights; service_runtime and the broker validate it exactly.
$script:SignerServiceObjectSddl = "O:SYD:P(A;;0x000f01ff;;;SY)(A;;0x00120035;;;BA)(A;;0x00020005;;;S-1-5-80-1804173726-3601835665-1843708740-3959121232-3866049905)"

# --- Frozen protected image and directory ACLs -------------------------------
# availability_broker_runtime.cpp ValidateExactProtectedDacl: the signer image
# must carry owner SYSTEM and a protected DACL with exactly four ACEs in this
# order: SYSTEM full control (0x001F01FF), the signer service SID read +
# execute (0x001200A9), Administrators read + execute (0x001200A9), and
# the dedicated runtime worker read + execute (0x001200A9).
$script:SignerImageSddl = "O:SYD:P(A;;0x001f01ff;;;SY)(A;;0x001200a9;;;S-1-5-80-1765223994-2719708455-3112291649-2938929260-976374647)(A;;0x001200a9;;;BA)(A;;0x001200a9;;;S-1-5-80-1804173726-3601835665-1843708740-3959121232-3866049905)"
# local_transport.cpp ValidateExactProtectedDacl applies the same exact
# descriptor to the client image, provisioner root and bin directory.
$script:ClientImageSddl = "O:SYD:P(A;;0x001f01ff;;;SY)(A;;0x001200a9;;;S-1-5-80-1765223994-2719708455-3112291649-2938929260-976374647)(A;;0x001200a9;;;BA)(A;;0x001200a9;;;S-1-5-80-1804173726-3601835665-1843708740-3959121232-3866049905)"
# The broker validates only path identity for its own image; the recipe
# freezes the symmetric posture with the coordinator (broker) service SID as
# the middle ACE.
$script:BrokerImageSddl = "O:SYD:P(A;;0x001f01ff;;;SY)(A;;0x001200a9;;;S-1-5-80-938203738-3606080319-1885328063-149464327-2394007130)(A;;0x001200a9;;;BA)"
# bin\ and RemoteWorkerProvisioner\ must satisfy the authenticated transport's
# exact four-ACE descriptor, including the signer and worker SIDs. GoatCitadel\
# (when created by this recipe) stays admin-operable for sibling components.
$script:ProtectedDirectorySddl = "O:SYD:P(A;;0x001f01ff;;;SY)(A;;0x001200a9;;;S-1-5-80-1765223994-2719708455-3112291649-2938929260-976374647)(A;;0x001200a9;;;BA)(A;;0x001200a9;;;S-1-5-80-1804173726-3601835665-1843708740-3959121232-3866049905)"
$script:SharedRootSddl = "O:SYD:P(A;;0x001f01ff;;;SY)(A;;0x001f01ff;;;BA)"
# Uninstall restores an admin-writable descriptor before deletion.
$script:UninstallRestoreSddl = "O:BAD:P(A;;0x001f01ff;;;SY)(A;;0x001f01ff;;;BA)"

# availability_broker_runtime.cpp kMaximumProtectedExecutableBytes (64 MiB).
$script:MaximumImageBytes = 67108864

# --- Evidence schemas ---------------------------------------------------------
$script:InstallEvidenceSchema = "goatcitadel.remote-worker.broker-coordinator-install/1"
$script:UninstallEvidenceSchema = "goatcitadel.remote-worker.broker-coordinator-uninstall/1"

# --- Native recipe type -------------------------------------------------------
# Exact Win32 composition. sc.exe is intentionally not used for any
# security-critical write: CreateServiceW receives the exact quoted binary
# path, ChangeServiceConfig2W receives the exact unrestricted SID type and the
# exact single-entry privilege multi-string, and SetServiceObjectSecurity /
# SetNamedSecurityInfoW receive descriptors converted from the frozen SDDL
# above. The C# below is intentionally written without pipeline-chain,
# null-conditional, null-coalescing, or string-interpolation syntax so it
# compiles under both the Windows PowerShell 5.1 CodeDom compiler and the
# PowerShell 7 Roslyn compiler, and so the paired contract test can assert
# PowerShell-5.1-only syntax over this whole file.
$script:BrokerCoordinatorNativeSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace GoatCitadel.RemoteWorker.BrokerCoordinator
{
    public static class NativeRecipe
    {
        private const uint ScManagerConnect = 0x0001u;
        private const uint ScManagerCreateService = 0x0002u;
        private const uint ServiceAllAccess = 0x000F01FFu;
        private const uint ServiceQueryConfigAccess = 0x0001u;
        private const uint ServiceChangeConfigAccess = 0x0002u;
        private const uint ServiceQueryStatusAccess = 0x0004u;
        private const uint ServiceStopAccess = 0x0020u;
        private const uint StandardDelete = 0x00010000u;
        private const uint StandardReadControl = 0x00020000u;
        private const uint StandardWriteDac = 0x00040000u;
        private const uint StandardWriteOwner = 0x00080000u;
        private const uint ServiceWin32OwnProcess = 0x00000010u;
        private const uint ServiceDemandStart = 0x00000003u;
        private const uint ServiceErrorNormal = 0x00000001u;
        private const uint ServiceConfigServiceSidInfo = 5u;
        private const uint ServiceConfigRequiredPrivilegesInfo = 6u;
        private const uint ServiceSidTypeUnrestricted = 1u;
        private const uint OwnerSecurityInformation = 0x00000001u;
        private const uint DaclSecurityInformation = 0x00000004u;
        private const uint ProtectedDaclSecurityInformation = 0x80000000u;
        private const uint OwnerAndDacl = OwnerSecurityInformation | DaclSecurityInformation;
        private const uint SeFileObject = 1u;
        private const uint ScStatusProcessInfo = 0u;
        private const uint ServiceControlStop = 0x00000001u;
        private const uint SePrivilegeEnabled = 0x00000002u;
        private const uint TokenAdjustPrivileges = 0x0020u;
        private const uint TokenQuery = 0x0008u;
        private const uint FileReadAttributes = 0x0080u;
        private const uint FileShareAll = 0x0007u;
        private const uint OpenExisting = 3u;
        private const uint SddlRevision1 = 1u;
        private const int ErrorInsufficientBuffer = 122;
        private const int ErrorServiceDoesNotExist = 1060;
        private const int ErrorServiceNotActive = 1062;
        private const int ErrorServiceMarkedForDelete = 1072;
        private const int ErrorAccessDenied = 5;
        private const int MaximumMultiSzBytes = 65536;

        [StructLayout(LayoutKind.Sequential)]
        private struct SecurityAttributesValue
        {
            public int Length;
            public IntPtr SecurityDescriptor;
            public int InheritHandle;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct LuidValue
        {
            public uint LowPart;
            public int HighPart;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TokenPrivilegesValue
        {
            public uint PrivilegeCount;
            public LuidValue Luid;
            public uint Attributes;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ServiceStatusPlain
        {
            public uint ServiceType;
            public uint CurrentState;
            public uint ControlsAccepted;
            public uint Win32ExitCode;
            public uint ServiceSpecificExitCode;
            public uint CheckPoint;
            public uint WaitHint;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ServiceSidInfoValue
        {
            public uint ServiceSidType;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct QueryServiceConfigValue
        {
            public uint ServiceType;
            public uint StartType;
            public uint ErrorControl;
            public IntPtr BinaryPathName;
            public IntPtr LoadOrderGroup;
            public uint TagId;
            public IntPtr Dependencies;
            public IntPtr ServiceStartName;
            public IntPtr DisplayName;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ByHandleFileInformationValue
        {
            public uint FileAttributes;
            public uint CreationTimeLow;
            public uint CreationTimeHigh;
            public uint LastAccessTimeLow;
            public uint LastAccessTimeHigh;
            public uint LastWriteTimeLow;
            public uint LastWriteTimeHigh;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern IntPtr OpenSCManagerW(string machineName, string databaseName, uint desiredAccess);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern IntPtr OpenServiceW(IntPtr manager, string serviceName, uint desiredAccess);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern IntPtr CreateServiceW(
            IntPtr manager,
            string serviceName,
            string displayName,
            uint desiredAccess,
            uint serviceType,
            uint startType,
            uint errorControl,
            string binaryPathName,
            string loadOrderGroup,
            IntPtr tagId,
            string dependencies,
            string serviceStartName,
            string password);

        [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseServiceHandle(IntPtr handle);

        [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DeleteService(IntPtr service);

        [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ControlService(IntPtr service, uint control, ref ServiceStatusPlain status);

        [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryServiceStatusEx(
            IntPtr service,
            uint infoLevel,
            IntPtr buffer,
            uint bufferSize,
            out uint bytesNeeded);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryServiceConfigW(
            IntPtr service,
            IntPtr buffer,
            uint bufferSize,
            out uint bytesNeeded);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryServiceConfig2W(
            IntPtr service,
            uint infoLevel,
            IntPtr buffer,
            uint bufferSize,
            out uint bytesNeeded);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ChangeServiceConfig2W(IntPtr service, uint infoLevel, IntPtr info);

        [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetServiceObjectSecurity(
            IntPtr service,
            uint securityInformation,
            IntPtr securityDescriptor);

        [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryServiceObjectSecurity(
            IntPtr service,
            uint securityInformation,
            IntPtr buffer,
            uint bufferSize,
            out uint bytesNeeded);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
            string sddl,
            uint revision,
            out IntPtr securityDescriptor,
            out uint size);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
            IntPtr securityDescriptor,
            uint revision,
            uint securityInformation,
            out IntPtr sddl,
            out uint length);

        [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetSecurityDescriptorOwner(
            IntPtr securityDescriptor,
            out IntPtr owner,
            out int ownerDefaulted);

        [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetSecurityDescriptorDacl(
            IntPtr securityDescriptor,
            out int daclPresent,
            out IntPtr dacl,
            out int daclDefaulted);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern uint SetNamedSecurityInfoW(
            string objectName,
            uint objectType,
            uint securityInformation,
            IntPtr owner,
            IntPtr group,
            IntPtr dacl,
            IntPtr sacl);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern uint GetNamedSecurityInfoW(
            string objectName,
            uint objectType,
            uint securityInformation,
            out IntPtr owner,
            out IntPtr group,
            out IntPtr dacl,
            out IntPtr sacl,
            out IntPtr securityDescriptor);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool LookupPrivilegeValueW(string systemName, string name, out LuidValue luid);

        [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);

        [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AdjustTokenPrivileges(
            IntPtr token,
            [MarshalAs(UnmanagedType.Bool)] bool disableAllPrivileges,
            ref TokenPrivilegesValue newState,
            uint bufferLength,
            IntPtr previousState,
            IntPtr returnLength);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        private static extern IntPtr LocalFree(IntPtr memory);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern IntPtr CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateDirectoryW(string path, ref SecurityAttributesValue attributes);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(
            IntPtr file, System.Text.StringBuilder path, uint capacity, uint flags);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(
            IntPtr file,
            out ByHandleFileInformationValue information);

        private static IntPtr OpenManager(uint desiredAccess)
        {
            IntPtr manager = OpenSCManagerW(null, null, desiredAccess);
            if (manager == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return manager;
        }

        private static IntPtr OpenServiceHandle(IntPtr manager, string serviceName, uint desiredAccess)
        {
            IntPtr service = OpenServiceW(manager, serviceName, desiredAccess);
            if (service == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return service;
        }

        private static string PointerToString(IntPtr pointer)
        {
            if (pointer == IntPtr.Zero)
            {
                return "";
            }
            string value = Marshal.PtrToStringUni(pointer);
            if (value == null)
            {
                return "";
            }
            return value;
        }

        private static string ReadMultiSz(IntPtr pointer)
        {
            if (pointer == IntPtr.Zero)
            {
                return "";
            }
            System.Text.StringBuilder builder = new System.Text.StringBuilder();
            int offset = 0;
            int previous = -1;
            while (true)
            {
                if (offset > MaximumMultiSzBytes)
                {
                    throw new InvalidOperationException("The service multi-string is unbounded.");
                }
                short character = Marshal.ReadInt16(pointer, offset);
                if (character == 0)
                {
                    if (previous <= 0)
                    {
                        break;
                    }
                    builder.Append('\n');
                }
                else
                {
                    builder.Append((char)character);
                }
                previous = character;
                offset = offset + 2;
            }
            return builder.ToString().TrimEnd('\n');
        }

        private static string DescriptorToSddl(IntPtr descriptor)
        {
            IntPtr text;
            uint length;
            bool converted = ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor, SddlRevision1, OwnerAndDacl, out text, out length);
            if (!converted)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            try
            {
                return PointerToString(text);
            }
            finally
            {
                LocalFree(text);
            }
        }

        public static string CanonicalizeSddl(string sddl)
        {
            IntPtr descriptor;
            uint size;
            bool converted = ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl, SddlRevision1, out descriptor, out size);
            if (!converted)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            try
            {
                return DescriptorToSddl(descriptor);
            }
            finally
            {
                LocalFree(descriptor);
            }
        }

        public static bool ServiceExists(string serviceName)
        {
            IntPtr manager = OpenManager(ScManagerConnect);
            try
            {
                IntPtr service = OpenServiceW(manager, serviceName, ServiceQueryStatusAccess);
                if (service != IntPtr.Zero)
                {
                    CloseServiceHandle(service);
                    return true;
                }
                int error = Marshal.GetLastWin32Error();
                if (error == ErrorServiceDoesNotExist)
                {
                    return false;
                }
                if (error == ErrorAccessDenied)
                {
                    return true;
                }
                throw new Win32Exception(error);
            }
            finally
            {
                CloseServiceHandle(manager);
            }
        }

        public static void CreateCoordinatorService(string serviceName, string displayName, string quotedBinaryPath)
        {
            IntPtr manager = OpenManager(ScManagerConnect | ScManagerCreateService);
            try
            {
                IntPtr service = CreateServiceW(
                    manager,
                    serviceName,
                    displayName,
                    ServiceAllAccess,
                    ServiceWin32OwnProcess,
                    ServiceDemandStart,
                    ServiceErrorNormal,
                    quotedBinaryPath,
                    null,
                    IntPtr.Zero,
                    null,
                    "LocalSystem",
                    null);
                if (service == IntPtr.Zero)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                CloseServiceHandle(service);
            }
            finally
            {
                CloseServiceHandle(manager);
            }
        }

        public static void SetServiceSidTypeUnrestricted(string serviceName)
        {
            IntPtr manager = OpenManager(ScManagerConnect);
            try
            {
                IntPtr service = OpenServiceHandle(manager, serviceName, ServiceChangeConfigAccess);
                try
                {
                    ServiceSidInfoValue info;
                    info.ServiceSidType = ServiceSidTypeUnrestricted;
                    IntPtr buffer = Marshal.AllocHGlobal(4);
                    try
                    {
                        Marshal.StructureToPtr(info, buffer, false);
                        bool changed = ChangeServiceConfig2W(service, ServiceConfigServiceSidInfo, buffer);
                        if (!changed)
                        {
                            throw new Win32Exception(Marshal.GetLastWin32Error());
                        }
                    }
                    finally
                    {
                        Marshal.FreeHGlobal(buffer);
                    }
                }
                finally
                {
                    CloseServiceHandle(service);
                }
            }
            finally
            {
                CloseServiceHandle(manager);
            }
        }

        public static void SetServiceRequiredPrivilegesChangeNotify(string serviceName)
        {
            IntPtr manager = OpenManager(ScManagerConnect);
            try
            {
                IntPtr service = OpenServiceHandle(manager, serviceName, ServiceChangeConfigAccess);
                try
                {
                    // Exactly "SeChangeNotifyPrivilege\0" plus the marshaller's
                    // terminator: the double-NUL multi-string the broker pins.
                    string multiSz = "SeChangeNotifyPrivilege\0";
                    IntPtr text = Marshal.StringToHGlobalUni(multiSz);
                    IntPtr info = Marshal.AllocHGlobal(IntPtr.Size);
                    try
                    {
                        Marshal.WriteIntPtr(info, text);
                        bool changed = ChangeServiceConfig2W(service, ServiceConfigRequiredPrivilegesInfo, info);
                        if (!changed)
                        {
                            throw new Win32Exception(Marshal.GetLastWin32Error());
                        }
                    }
                    finally
                    {
                        Marshal.FreeHGlobal(info);
                        Marshal.FreeHGlobal(text);
                    }
                }
                finally
                {
                    CloseServiceHandle(service);
                }
            }
            finally
            {
                CloseServiceHandle(manager);
            }
        }

        public static void SetServiceSddl(string serviceName, string sddl)
        {
            IntPtr descriptor;
            uint size;
            bool converted = ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl, SddlRevision1, out descriptor, out size);
            if (!converted)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            try
            {
                IntPtr manager = OpenManager(ScManagerConnect);
                try
                {
                    IntPtr service = OpenServiceHandle(
                        manager,
                        serviceName,
                        StandardReadControl | StandardWriteDac | StandardWriteOwner);
                    try
                    {
                        bool applied = SetServiceObjectSecurity(service, OwnerAndDacl, descriptor);
                        if (!applied)
                        {
                            throw new Win32Exception(Marshal.GetLastWin32Error());
                        }
                    }
                    finally
                    {
                        CloseServiceHandle(service);
                    }
                }
                finally
                {
                    CloseServiceHandle(manager);
                }
            }
            finally
            {
                LocalFree(descriptor);
            }
        }

        public static string GetServiceSddl(string serviceName)
        {
            IntPtr manager = OpenManager(ScManagerConnect);
            try
            {
                IntPtr service = OpenServiceHandle(manager, serviceName, StandardReadControl);
                try
                {
                    uint needed;
                    QueryServiceObjectSecurity(service, OwnerAndDacl, IntPtr.Zero, 0u, out needed);
                    int error = Marshal.GetLastWin32Error();
                    if (error != ErrorInsufficientBuffer)
                    {
                        throw new Win32Exception(error);
                    }
                    IntPtr buffer = Marshal.AllocHGlobal((int)needed);
                    try
                    {
                        uint written;
                        bool queried = QueryServiceObjectSecurity(service, OwnerAndDacl, buffer, needed, out written);
                        if (!queried)
                        {
                            throw new Win32Exception(Marshal.GetLastWin32Error());
                        }
                        return DescriptorToSddl(buffer);
                    }
                    finally
                    {
                        Marshal.FreeHGlobal(buffer);
                    }
                }
                finally
                {
                    CloseServiceHandle(service);
                }
            }
            finally
            {
                CloseServiceHandle(manager);
            }
        }

        public static string GetServiceConfigLine(string serviceName)
        {
            IntPtr manager = OpenManager(ScManagerConnect);
            try
            {
                IntPtr service = OpenServiceHandle(manager, serviceName, ServiceQueryConfigAccess);
                try
                {
                    uint needed;
                    QueryServiceConfigW(service, IntPtr.Zero, 0u, out needed);
                    int error = Marshal.GetLastWin32Error();
                    if (error != ErrorInsufficientBuffer)
                    {
                        throw new Win32Exception(error);
                    }
                    IntPtr buffer = Marshal.AllocHGlobal((int)needed);
                    try
                    {
                        uint written;
                        bool queried = QueryServiceConfigW(service, buffer, needed, out written);
                        if (!queried)
                        {
                            throw new Win32Exception(Marshal.GetLastWin32Error());
                        }
                        QueryServiceConfigValue config = (QueryServiceConfigValue)Marshal.PtrToStructure(
                            buffer, typeof(QueryServiceConfigValue));
                        string dependenciesEmpty = "1";
                        if (config.Dependencies != IntPtr.Zero)
                        {
                            if (Marshal.ReadInt16(config.Dependencies, 0) != 0)
                            {
                                dependenciesEmpty = "0";
                            }
                        }
                        System.Globalization.CultureInfo invariant =
                            System.Globalization.CultureInfo.InvariantCulture;
                        return string.Join("|", new string[]
                        {
                            config.ServiceType.ToString(invariant),
                            config.StartType.ToString(invariant),
                            config.ErrorControl.ToString(invariant),
                            PointerToString(config.BinaryPathName),
                            PointerToString(config.ServiceStartName),
                            PointerToString(config.LoadOrderGroup),
                            dependenciesEmpty
                        });
                    }
                    finally
                    {
                        Marshal.FreeHGlobal(buffer);
                    }
                }
                finally
                {
                    CloseServiceHandle(service);
                }
            }
            finally
            {
                CloseServiceHandle(manager);
            }
        }

        private static IntPtr QueryConfig2Buffer(IntPtr service, uint infoLevel, out uint size)
        {
            uint needed;
            QueryServiceConfig2W(service, infoLevel, IntPtr.Zero, 0u, out needed);
            int error = Marshal.GetLastWin32Error();
            if (error != ErrorInsufficientBuffer)
            {
                throw new Win32Exception(error);
            }
            IntPtr buffer = Marshal.AllocHGlobal((int)needed);
            uint written;
            bool queried = QueryServiceConfig2W(service, infoLevel, buffer, needed, out written);
            if (!queried)
            {
                int queryError = Marshal.GetLastWin32Error();
                Marshal.FreeHGlobal(buffer);
                throw new Win32Exception(queryError);
            }
            size = written;
            return buffer;
        }

        public static uint GetServiceSidType(string serviceName)
        {
            IntPtr manager = OpenManager(ScManagerConnect);
            try
            {
                IntPtr service = OpenServiceHandle(manager, serviceName, ServiceQueryConfigAccess);
                try
                {
                    uint size;
                    IntPtr buffer = QueryConfig2Buffer(service, ServiceConfigServiceSidInfo, out size);
                    try
                    {
                        return (uint)Marshal.ReadInt32(buffer, 0);
                    }
                    finally
                    {
                        Marshal.FreeHGlobal(buffer);
                    }
                }
                finally
                {
                    CloseServiceHandle(service);
                }
            }
            finally
            {
                CloseServiceHandle(manager);
            }
        }

        public static string GetServiceRequiredPrivileges(string serviceName)
        {
            IntPtr manager = OpenManager(ScManagerConnect);
            try
            {
                IntPtr service = OpenServiceHandle(manager, serviceName, ServiceQueryConfigAccess);
                try
                {
                    uint size;
                    IntPtr buffer = QueryConfig2Buffer(service, ServiceConfigRequiredPrivilegesInfo, out size);
                    try
                    {
                        IntPtr multiSz = Marshal.ReadIntPtr(buffer, 0);
                        return ReadMultiSz(multiSz);
                    }
                    finally
                    {
                        Marshal.FreeHGlobal(buffer);
                    }
                }
                finally
                {
                    CloseServiceHandle(service);
                }
            }
            finally
            {
                CloseServiceHandle(manager);
            }
        }

        public static string GetServiceStatusLine(string serviceName)
        {
            IntPtr manager = OpenManager(ScManagerConnect);
            try
            {
                IntPtr service = OpenServiceHandle(manager, serviceName, ServiceQueryStatusAccess);
                try
                {
                    IntPtr buffer = Marshal.AllocHGlobal(64);
                    try
                    {
                        uint needed;
                        bool queried = QueryServiceStatusEx(service, ScStatusProcessInfo, buffer, 64u, out needed);
                        if (!queried)
                        {
                            throw new Win32Exception(Marshal.GetLastWin32Error());
                        }
                        System.Globalization.CultureInfo invariant =
                            System.Globalization.CultureInfo.InvariantCulture;
                        uint serviceType = (uint)Marshal.ReadInt32(buffer, 0);
                        uint currentState = (uint)Marshal.ReadInt32(buffer, 4);
                        uint win32ExitCode = (uint)Marshal.ReadInt32(buffer, 12);
                        uint specificExitCode = (uint)Marshal.ReadInt32(buffer, 16);
                        uint checkPoint = (uint)Marshal.ReadInt32(buffer, 20);
                        uint waitHint = (uint)Marshal.ReadInt32(buffer, 24);
                        uint processId = (uint)Marshal.ReadInt32(buffer, 28);
                        uint serviceFlags = (uint)Marshal.ReadInt32(buffer, 32);
                        return string.Join("|", new string[]
                        {
                            currentState.ToString(invariant),
                            processId.ToString(invariant),
                            serviceFlags.ToString(invariant),
                            serviceType.ToString(invariant),
                            win32ExitCode.ToString(invariant),
                            specificExitCode.ToString(invariant),
                            checkPoint.ToString(invariant),
                            waitHint.ToString(invariant)
                        });
                    }
                    finally
                    {
                        Marshal.FreeHGlobal(buffer);
                    }
                }
                finally
                {
                    CloseServiceHandle(service);
                }
            }
            finally
            {
                CloseServiceHandle(manager);
            }
        }

        public static void StopServiceOnce(string serviceName)
        {
            IntPtr manager = OpenManager(ScManagerConnect);
            try
            {
                IntPtr service = OpenServiceHandle(
                    manager, serviceName, ServiceStopAccess | ServiceQueryStatusAccess);
                try
                {
                    ServiceStatusPlain status = new ServiceStatusPlain();
                    bool controlled = ControlService(service, ServiceControlStop, ref status);
                    if (!controlled)
                    {
                        int error = Marshal.GetLastWin32Error();
                        if (error != ErrorServiceNotActive)
                        {
                            throw new Win32Exception(error);
                        }
                    }
                }
                finally
                {
                    CloseServiceHandle(service);
                }
            }
            finally
            {
                CloseServiceHandle(manager);
            }
        }

        public static void RemoveService(string serviceName)
        {
            IntPtr manager = OpenManager(ScManagerConnect);
            try
            {
                IntPtr service = OpenServiceHandle(manager, serviceName, StandardDelete);
                try
                {
                    bool deleted = DeleteService(service);
                    if (!deleted)
                    {
                        int error = Marshal.GetLastWin32Error();
                        if (error != ErrorServiceMarkedForDelete)
                        {
                            throw new Win32Exception(error);
                        }
                    }
                }
                finally
                {
                    CloseServiceHandle(service);
                }
            }
            finally
            {
                CloseServiceHandle(manager);
            }
        }

        public static void EnablePrivilege(string privilegeName)
        {
            IntPtr token;
            bool opened = OpenProcessToken(GetCurrentProcess(), TokenAdjustPrivileges | TokenQuery, out token);
            if (!opened)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            try
            {
                LuidValue luid;
                bool located = LookupPrivilegeValueW(null, privilegeName, out luid);
                if (!located)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                TokenPrivilegesValue state = new TokenPrivilegesValue();
                state.PrivilegeCount = 1u;
                state.Luid = luid;
                state.Attributes = SePrivilegeEnabled;
                bool adjusted = AdjustTokenPrivileges(token, false, ref state, 0u, IntPtr.Zero, IntPtr.Zero);
                if (!adjusted)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                int adjustError = Marshal.GetLastWin32Error();
                if (adjustError != 0)
                {
                    throw new Win32Exception(adjustError);
                }
            }
            finally
            {
                CloseHandle(token);
            }
        }

        public static void SetFileSddl(string path, string sddl)
        {
            IntPtr descriptor;
            uint size;
            bool converted = ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl, SddlRevision1, out descriptor, out size);
            if (!converted)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            try
            {
                IntPtr owner;
                int ownerDefaulted;
                bool ownerRead = GetSecurityDescriptorOwner(descriptor, out owner, out ownerDefaulted);
                if (!ownerRead)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                if (owner == IntPtr.Zero)
                {
                    throw new InvalidOperationException("The SDDL must carry an explicit owner.");
                }
                int daclPresent;
                IntPtr dacl;
                int daclDefaulted;
                bool daclRead = GetSecurityDescriptorDacl(descriptor, out daclPresent, out dacl, out daclDefaulted);
                if (!daclRead)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                if (daclPresent == 0)
                {
                    throw new InvalidOperationException("The SDDL must carry an explicit DACL.");
                }
                uint result = SetNamedSecurityInfoW(
                    path,
                    SeFileObject,
                    OwnerAndDacl | ProtectedDaclSecurityInformation,
                    owner,
                    IntPtr.Zero,
                    dacl,
                    IntPtr.Zero);
                if (result != 0u)
                {
                    throw new Win32Exception((int)result);
                }
            }
            finally
            {
                LocalFree(descriptor);
            }
        }

        public static string GetFileSddl(string path)
        {
            IntPtr owner;
            IntPtr group;
            IntPtr dacl;
            IntPtr sacl;
            IntPtr descriptor;
            uint result = GetNamedSecurityInfoW(
                path, SeFileObject, OwnerAndDacl, out owner, out group, out dacl, out sacl, out descriptor);
            if (result != 0u)
            {
                throw new Win32Exception((int)result);
            }
            try
            {
                return DescriptorToSddl(descriptor);
            }
            finally
            {
                LocalFree(descriptor);
            }
        }

        public static void CreateProtectedDirectory(string path, string sddl)
        {
            IntPtr descriptor;
            uint size;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl, SddlRevision1, out descriptor, out size))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            try
            {
                SecurityAttributesValue attributes = new SecurityAttributesValue();
                attributes.Length = Marshal.SizeOf(typeof(SecurityAttributesValue));
                attributes.SecurityDescriptor = descriptor;
                attributes.InheritHandle = 0;
                // Exclusive creation with an explicit DACL prevents inheriting
                // writable ProgramData permissions before protection is applied.
                if (!CreateDirectoryW(path, ref attributes))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
            }
            finally
            {
                LocalFree(descriptor);
            }
        }

        public static IDisposable PinDirectory(string path)
        {
            string expected = System.IO.Path.GetFullPath(path);
            if (expected.Length > 3) { expected = expected.TrimEnd('\\'); }
            // FILE_LIST_DIRECTORY participates in share-access checks; a
            // metadata-only handle does not fence directory replacement.
            IntPtr raw = CreateFileW(
                expected, 1u | FileReadAttributes | StandardReadControl, 3u, IntPtr.Zero,
                OpenExisting, 0x02200000u, IntPtr.Zero);
            Microsoft.Win32.SafeHandles.SafeFileHandle handle =
                new Microsoft.Win32.SafeHandles.SafeFileHandle(raw, true);
            try
            {
                if (handle.IsInvalid) { throw new Win32Exception(Marshal.GetLastWin32Error()); }
                ByHandleFileInformationValue information;
                if (!GetFileInformationByHandle(raw, out information))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                if ((information.FileAttributes & 0x00000410u) != 0x00000010u)
                {
                    throw new InvalidOperationException("REFUSED: a directory is a reparse point or is not a directory.");
                }
                System.Text.StringBuilder finalPath = new System.Text.StringBuilder(512);
                uint length = GetFinalPathNameByHandleW(raw, finalPath, 512u, 0u);
                if (length == 0u) { throw new Win32Exception(Marshal.GetLastWin32Error()); }
                if (length >= 512u) { throw new InvalidOperationException("REFUSED: directory path is too long."); }
                if (!string.Equals(finalPath.ToString(), @"\\?\" + expected, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException("REFUSED: a directory resolves through an alias or reparse ancestor.");
                }
                // FILE_SHARE_DELETE is intentionally absent for the lease lifetime.
                return handle;
            }
            catch
            {
                handle.Dispose();
                throw;
            }
        }

        public static int GetFileHardLinkCount(string path)
        {
            IntPtr invalidHandle = new IntPtr(-1);
            IntPtr handle = CreateFileW(
                path, FileReadAttributes, FileShareAll, IntPtr.Zero, OpenExisting, 0u, IntPtr.Zero);
            if (handle == invalidHandle)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            if (handle == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            try
            {
                ByHandleFileInformationValue information;
                bool queried = GetFileInformationByHandle(handle, out information);
                if (!queried)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                return (int)information.NumberOfLinks;
            }
            finally
            {
                CloseHandle(handle);
            }
        }
    }
}
'@

function Initialize-BrokerCoordinatorNativeType {
  if ("GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe" -as [type]) {
    return
  }
  Add-Type -TypeDefinition $script:BrokerCoordinatorNativeSource -Language CSharp
}

function Get-VirtualServiceAccountSid {
  <#
    Deterministic NT SERVICE virtual-account derivation:
    S-1-5-80-{SHA-1(uppercase UTF-16LE service name) as five little-endian
     32-bit sub-authorities}. Must reproduce the compiled
    kBrokerServiceSidParts / kTargetServiceSidParts pins exactly.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$ServiceName
  )
  $sha1 = [System.Security.Cryptography.SHA1]::Create()
  try {
    $nameBytes = [System.Text.Encoding]::Unicode.GetBytes($ServiceName.ToUpperInvariant())
    $digest = $sha1.ComputeHash($nameBytes)
  }
  finally {
    $sha1.Dispose()
  }
  $parts = New-Object System.Collections.Generic.List[string]
  for ($index = 0; $index -lt 5; $index++) {
    $value = [System.BitConverter]::ToUInt32($digest, $index * 4)
    $parts.Add($value.ToString([System.Globalization.CultureInfo]::InvariantCulture))
  }
  return "S-1-5-80-" + ($parts -join "-")
}

function Get-BrokerCoordinatorPaths {
  <#
    Composes the exact installed paths the broker validates. The broker
    resolves the SystemRoot volume drive and appends kProgramDataSuffix with
    an UPPERCASE drive letter, then compares the configured service binary
    path against the QUOTED DOS path character-for-character
    (availability_broker.cpp EqualPath is case-sensitive).
  #>
  param(
    [Parameter(Mandatory = $true)][string]$SystemDrive
  )
  if ($SystemDrive -notmatch "^[A-Za-z]:$") {
    throw ("REFUSED: the system drive '{0}' is not a single-letter DOS drive; the broker path law cannot be composed." -f $SystemDrive)
  }
  $drive = $SystemDrive.Substring(0, 1).ToUpperInvariant() + ":"
  $binDirectory = $drive + $script:ProgramDataSuffix.TrimEnd("\")
  $provisionerDirectory = Split-Path -Path $binDirectory -Parent
  $goatCitadelDirectory = Split-Path -Path $provisionerDirectory -Parent
  $brokerImagePath = $drive + $script:ProgramDataSuffix + $script:BrokerExecutableName
  $signerImagePath = $drive + $script:ProgramDataSuffix + $script:SignerExecutableName
  $clientImagePath = $drive + $script:ProgramDataSuffix + $script:ClientExecutableName
  return [pscustomobject]@{
    Drive = $drive
    GoatCitadelDirectory = $goatCitadelDirectory
    ProvisionerDirectory = $provisionerDirectory
    BinDirectory = $binDirectory
    BrokerImagePath = $brokerImagePath
    SignerImagePath = $signerImagePath
    ClientImagePath = $clientImagePath
    BrokerQuotedBinaryPath = '"' + $brokerImagePath + '"'
    SignerQuotedBinaryPath = '"' + $signerImagePath + '"'
  }
}

function Assert-BrokerCoordinatorAncestorSddl {
  param(
    [Parameter(Mandatory = $true)][string]$Sddl,
    [switch]$GoatCitadelLevel
  )
  $descriptor = New-Object System.Security.AccessControl.RawSecurityDescriptor($Sddl)
  $trustedInstaller = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
  if ($descriptor.Owner.Value -notin @("S-1-5-18", $trustedInstaller)) {
    throw "REFUSED: an install ancestor owner is not SYSTEM or TrustedInstaller."
  }
  if ($null -eq $descriptor.DiscretionaryAcl) {
    throw "REFUSED: an install ancestor has no DACL."
  }
  # Mirrors local_transport.cpp ValidateAncestorDacl. Inherit-only ACEs do not
  # grant authority on this ancestor; unknown effective ACE kinds are refused.
  $forbidden = 0x500C0040
  if ($GoatCitadelLevel) { $forbidden = $forbidden -bor 0x00010116 }
  foreach ($ace in $descriptor.DiscretionaryAcl) {
    if (([int]$ace.AceFlags -band [int][System.Security.AccessControl.AceFlags]::InheritOnly) -ne 0) { continue }
    if ($ace.AceType -eq [System.Security.AccessControl.AceType]::AccessDenied) { continue }
    if ($ace.AceType -ne [System.Security.AccessControl.AceType]::AccessAllowed) {
      throw "REFUSED: an install ancestor has an unsupported effective ACE."
    }
    $trusted = @("S-1-5-18", $trustedInstaller, "S-1-5-32-544", $script:SignerServiceSid)
    if ($ace.SecurityIdentifier.Value -notin $trusted -and ($ace.AccessMask -band $forbidden) -ne 0) {
      throw "REFUSED: an install ancestor permits untrusted mutation."
    }
  }
}

function Get-BrokerCoordinatorDirectoryLease {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$GoatCitadelLevel
  )
  $native = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
  $lease = $native::PinDirectory($Path)
  try {
    Assert-BrokerCoordinatorAncestorSddl -Sddl ($native::GetFileSddl($Path)) -GoatCitadelLevel:$GoatCitadelLevel
    return $lease
  }
  catch {
    $lease.Dispose()
    throw
  }
}

function Test-BrokerCoordinatorElevation {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-BrokerCoordinatorFileSha256 {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )
  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  $hasher = $null
  try {
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    return [System.BitConverter]::ToString($hasher.ComputeHash($stream)).Replace("-", "").ToLowerInvariant()
  }
  finally {
    if ($null -ne $hasher) { $hasher.Dispose() }
    $stream.Dispose()
  }
}

function Get-BrokerCoordinatorStreamNames {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )
  return ,@(Get-Item -LiteralPath $Path -Stream * | ForEach-Object { $_.Stream })
}

function ConvertTo-CanonicalSddl {
  param(
    [Parameter(Mandatory = $true)][string]$Sddl
  )
  Initialize-BrokerCoordinatorNativeType
  return [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]::CanonicalizeSddl($Sddl)
}

function ConvertTo-CanonicalFileSddl {
  param([Parameter(Mandatory = $true)][string]$Sddl)
  $descriptor = New-Object System.Security.AccessControl.RawSecurityDescriptor($Sddl)
  # SetNamedSecurityInfoW may retain the AI bookkeeping flag after replacing
  # every inherited ACE with an explicit protected DACL. Native transport
  # validates owner, protected state and exact ACEs, not this historical flag.
  $flags = [int]$descriptor.ControlFlags -band (-bnot [int][System.Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited)
  $descriptor.SetFlags([System.Security.AccessControl.ControlFlags]$flags)
  return $descriptor.GetSddlForm([System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access)
}

function Write-BrokerCoordinatorEvidenceBundle {
  <#
    Machine-readable evidence bundle. The bundle is always written, including
    on refusal and failure, and is never deleted by this recipe.
  #>
  param(
    [Parameter(Mandatory = $true)]$Payload,
    [Parameter(Mandatory = $true)][string]$Path
  )
  $parent = Split-Path -Path $Path -Parent
  if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $json = ConvertTo-Json -InputObject $Payload -Depth 8
  Set-Content -LiteralPath $Path -Value $json -Encoding UTF8
}
