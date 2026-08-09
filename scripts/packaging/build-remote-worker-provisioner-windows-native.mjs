#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  REMOTE_WORKER_WINDOWS_MSVC_VERSION,
  REMOTE_WORKER_WINDOWS_SDK_VERSION,
  assertNoRemoteWorkerBuildPathLeak,
  resolveExactWindowsToolchain,
} from "./lib/remote-worker-windows-toolchain.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "../..");
const nativeProjectRoot = path.join(repoRoot, "apps", "remote-worker-provisioner-windows-native");
const productionProjectPath = path.join(nativeProjectRoot, "GoatCitadel.RemoteWorker.Provisioner.vcxproj");
const clientProjectPath = path.join(nativeProjectRoot, "GoatCitadel.RemoteWorker.Provisioner.Client.vcxproj");
const availabilityProjectPath = path.join(
  nativeProjectRoot,
  "GoatCitadel.RemoteWorker.Provisioner.Availability.vcxproj",
);
const testProjectPath = path.join(nativeProjectRoot, "GoatCitadel.RemoteWorker.Provisioner.Tests.vcxproj");
const monocypherVendorRoot = path.join(repoRoot, "vendor", "monocypher", "4.0.3");

export const REMOTE_WORKER_WINDOWS_PROVISIONER_NAME = "GoatCitadelRemoteWorkerProvisioner.exe";
export const REMOTE_WORKER_WINDOWS_PROVISIONER_CLIENT_NAME = "GoatCitadelRemoteWorkerProvisionerClient.exe";
export const REMOTE_WORKER_WINDOWS_PROVISIONER_AVAILABILITY_NAME =
  "GoatCitadelRemoteWorkerProvisionerAvailability.exe";
export const REMOTE_WORKER_WINDOWS_PROVISIONER_TEST_NAME = "GoatCitadelRemoteWorkerProvisionerTests.exe";
export const REMOTE_WORKER_WINDOWS_PROVISIONER_PREFLIGHT_NAME = "GoatCitadelRemoteWorkerProvisionerVendorPreflight.exe";

export const REMOTE_WORKER_WINDOWS_PROVISIONER_W1B1A_SOURCE_PATHS = Object.freeze([
  "apps/remote-worker-provisioner-windows-native/GoatCitadel.RemoteWorker.Provisioner.Availability.vcxproj",
  "apps/remote-worker-provisioner-windows-native/GoatCitadel.RemoteWorker.Provisioner.Client.vcxproj",
  "apps/remote-worker-provisioner-windows-native/GoatCitadel.RemoteWorker.Provisioner.Tests.vcxproj",
  "apps/remote-worker-provisioner-windows-native/GoatCitadel.RemoteWorker.Provisioner.vcxproj",
  "apps/remote-worker-provisioner-windows-native/src/availability_broker.cpp",
  "apps/remote-worker-provisioner-windows-native/src/availability_broker.hpp",
  "apps/remote-worker-provisioner-windows-native/src/availability_broker.test.cpp",
  "apps/remote-worker-provisioner-windows-native/src/availability_broker_main.cpp",
  "apps/remote-worker-provisioner-windows-native/src/availability_broker_runtime.cpp",
  "apps/remote-worker-provisioner-windows-native/src/client_main.cpp",
  "apps/remote-worker-provisioner-windows-native/src/ed25519_runtime.cpp",
  "apps/remote-worker-provisioner-windows-native/src/ed25519_runtime.hpp",
  "apps/remote-worker-provisioner-windows-native/src/ed25519_runtime.test.cpp",
  "apps/remote-worker-provisioner-windows-native/src/key_custody.cpp",
  "apps/remote-worker-provisioner-windows-native/src/key_custody.hpp",
  "apps/remote-worker-provisioner-windows-native/src/key_custody.test.cpp",
  "apps/remote-worker-provisioner-windows-native/src/local_transport.cpp",
  "apps/remote-worker-provisioner-windows-native/src/local_transport.hpp",
  "apps/remote-worker-provisioner-windows-native/src/local_transport.test.cpp",
  "apps/remote-worker-provisioner-windows-native/src/operation_journal.cpp",
  "apps/remote-worker-provisioner-windows-native/src/operation_journal.hpp",
  "apps/remote-worker-provisioner-windows-native/src/operation_journal.test.cpp",
  "apps/remote-worker-provisioner-windows-native/src/protected_filesystem.cpp",
  "apps/remote-worker-provisioner-windows-native/src/protected_filesystem.hpp",
  "apps/remote-worker-provisioner-windows-native/src/protected_filesystem.test.cpp",
  "apps/remote-worker-provisioner-windows-native/src/protected_operations.cpp",
  "apps/remote-worker-provisioner-windows-native/src/protected_operations.hpp",
  "apps/remote-worker-provisioner-windows-native/src/protected_operations.test.cpp",
  "apps/remote-worker-provisioner-windows-native/src/protocol.cpp",
  "apps/remote-worker-provisioner-windows-native/src/protocol.hpp",
  "apps/remote-worker-provisioner-windows-native/src/protocol.test.cpp",
  "apps/remote-worker-provisioner-windows-native/src/service_runtime.cpp",
  "apps/remote-worker-provisioner-windows-native/src/service_runtime.hpp",
  "apps/remote-worker-provisioner-windows-native/src/service_runtime.test.cpp",
  "apps/remote-worker-provisioner/src/protected-admission-evidence.test.ts",
  "apps/remote-worker-provisioner/src/protected-admission-evidence.ts",
  "apps/remote-worker-provisioner/src/protected-runtime-pop-v2.test.ts",
  "apps/remote-worker-provisioner/src/protected-runtime-pop-v2.ts",
  "apps/remote-worker-provisioner/src/windows-helper-protocol.test.ts",
  "apps/remote-worker-provisioner/src/windows-helper-protocol.ts",
  "apps/remote-worker-provisioner/src/windows-service-client.test.ts",
  "apps/remote-worker-provisioner/src/windows-service-client.ts",
  "packages/contracts/src/remote-worker-protocol.test.ts",
  "packages/contracts/src/remote-worker-protocol.ts",
  "scripts/packaging/build-remote-worker-provisioner-windows-native.mjs",
  "scripts/packaging/build-remote-worker-provisioner-windows-native.test.mjs",
  "scripts/packaging/lib/remote-worker-windows-toolchain.mjs",
]);

export const REMOTE_WORKER_WINDOWS_PROVISIONER_W1B1B_P0_SOURCE_PATHS = Object.freeze([
  "apps/remote-worker-provisioner-windows-native/GoatCitadel.RemoteWorker.Provisioner.Tests.vcxproj",
  "apps/remote-worker-provisioner-windows-native/GoatCitadel.RemoteWorker.Provisioner.vcxproj",
  "apps/remote-worker-provisioner-windows-native/src/ed25519_runtime.cpp",
  "apps/remote-worker-provisioner-windows-native/src/ed25519_runtime.hpp",
  "apps/remote-worker-provisioner-windows-native/src/ed25519_runtime.test.cpp",
  "apps/remote-worker-provisioner-windows-native/src/key_custody.cpp",
  "apps/remote-worker-provisioner-windows-native/src/key_custody.hpp",
  "apps/remote-worker-provisioner-windows-native/src/key_custody.test.cpp",
  "apps/remote-worker-provisioner-windows-native/src/protected_artifact_signing.cpp",
  "apps/remote-worker-provisioner-windows-native/src/protected_artifact_signing.hpp",
  "apps/remote-worker-provisioner-windows-native/src/protected_artifact_signing.test.cpp",
  "apps/remote-worker-provisioner-windows-native/src/protected_filesystem.cpp",
  "apps/remote-worker-provisioner-windows-native/src/protected_filesystem.hpp",
  "apps/remote-worker-provisioner-windows-native/src/protected_filesystem.test.cpp",
  "scripts/packaging/build-remote-worker-provisioner-windows-native.mjs",
  "scripts/packaging/build-remote-worker-provisioner-windows-native.test.mjs",
  "scripts/packaging/lib/remote-worker-windows-toolchain.mjs",
]);

const targetMachines = Object.freeze({
  "windows-x64": 0x8664,
  "windows-arm64": 0xaa64,
});

const allowedImportDlls = Object.freeze({
  service: Object.freeze(["ADVAPI32.dll", "KERNEL32.dll", "Secur32.dll", "bcrypt.dll"]),
  client: Object.freeze(["ADVAPI32.dll", "KERNEL32.dll", "bcrypt.dll"]),
  availability: Object.freeze(["ADVAPI32.dll", "KERNEL32.dll", "bcrypt.dll"]),
});

// These closures are intentionally literal. They are updated only when the reviewed
// W1A implementation changes and both deterministic production PEs are re-proven.
export const REMOTE_WORKER_WINDOWS_PROVISIONER_IMPORTS = Object.freeze({
  service: Object.freeze({
    "windows-x64": Object.freeze([
      Object.freeze({
        dll: "ADVAPI32.dll",
        functions: Object.freeze([
          "AddAccessAllowedAceEx",
          "CloseServiceHandle",
          "EqualSid",
          "GetAce",
          "GetLengthSid",
          "GetSecurityDescriptorControl",
          "GetSecurityDescriptorDacl",
          "GetSecurityDescriptorGroup",
          "GetSecurityDescriptorOwner",
          "GetSecurityInfo",
          "GetSidSubAuthority",
          "GetSidSubAuthorityCount",
          "GetTokenInformation",
          "ImpersonateNamedPipeClient",
          "InitializeAcl",
          "InitializeSecurityDescriptor",
          "IsTokenRestricted",
          "IsValidAcl",
          "IsValidSecurityDescriptor",
          "IsValidSid",
          "LookupPrivilegeValueW",
          "OpenProcessToken",
          "OpenSCManagerW",
          "OpenServiceW",
          "OpenThreadToken",
          "QueryServiceConfig2W",
          "QueryServiceConfigW",
          "QueryServiceObjectSecurity",
          "QueryServiceStatusEx",
          "RegisterServiceCtrlHandlerExW",
          "RevertToSelf",
          "SetSecurityDescriptorControl",
          "SetSecurityDescriptorDacl",
          "SetSecurityDescriptorGroup",
          "SetSecurityDescriptorOwner",
          "SetServiceStatus",
          "StartServiceCtrlDispatcherW",
        ]),
      }),
      Object.freeze({
        dll: "KERNEL32.dll",
        functions: Object.freeze([
          "CancelIoEx",
          "CloseHandle",
          "CompareStringOrdinal",
          "ConnectNamedPipe",
          "CreateDirectoryW",
          "CreateEventW",
          "CreateFileW",
          "CreateNamedPipeW",
          "CreateThread",
          "DisconnectNamedPipe",
          "DuplicateHandle",
          "ExitProcess",
          "FindClose",
          "FindFirstStreamW",
          "FindNextStreamW",
          "FlushFileBuffers",
          "GetCommandLineW",
          "GetCurrentProcess",
          "GetCurrentProcessId",
          "GetCurrentThread",
          "GetCurrentThreadId",
          "GetFileInformationByHandleEx",
          "GetFileType",
          "GetFinalPathNameByHandleW",
          "GetLastError",
          "GetNamedPipeClientProcessId",
          "GetOverlappedResult",
          "GetProcessTimes",
          "GetStdHandle",
          "GetSystemTimeAsFileTime",
          "GetTickCount",
          "GetTickCount64",
          "GetVolumeInformationByHandleW",
          "LocalFree",
          "OpenProcess",
          "QueryFullProcessImageNameW",
          "QueryPerformanceCounter",
          "ReadFile",
          "RtlCaptureContext",
          "RtlLookupFunctionEntry",
          "RtlVirtualUnwind",
          "SetEvent",
          "SetFileInformationByHandle",
          "SetFilePointerEx",
          "SetLastError",
          "SetUnhandledExceptionFilter",
          "Sleep",
          "TerminateProcess",
          "UnhandledExceptionFilter",
          "WaitForMultipleObjects",
          "WaitForSingleObject",
          "WriteFile",
          "WTSGetActiveConsoleSessionId",
        ]),
      }),
      Object.freeze({
        dll: "Secur32.dll",
        functions: Object.freeze(["LsaFreeReturnBuffer", "LsaGetLogonSessionData"]),
      }),
      Object.freeze({
        dll: "bcrypt.dll",
        functions: Object.freeze([
          "BCryptCloseAlgorithmProvider",
          "BCryptCreateHash",
          "BCryptDestroyHash",
          "BCryptFinishHash",
          "BCryptGenRandom",
          "BCryptGetProperty",
          "BCryptHashData",
          "BCryptOpenAlgorithmProvider",
        ]),
      }),
    ]),
    "windows-arm64": Object.freeze([
      Object.freeze({
        dll: "ADVAPI32.dll",
        functions: Object.freeze([
          "AddAccessAllowedAceEx",
          "CloseServiceHandle",
          "EqualSid",
          "GetAce",
          "GetLengthSid",
          "GetSecurityDescriptorControl",
          "GetSecurityDescriptorDacl",
          "GetSecurityDescriptorGroup",
          "GetSecurityDescriptorOwner",
          "GetSecurityInfo",
          "GetSidSubAuthority",
          "GetSidSubAuthorityCount",
          "GetTokenInformation",
          "ImpersonateNamedPipeClient",
          "InitializeAcl",
          "InitializeSecurityDescriptor",
          "IsTokenRestricted",
          "IsValidAcl",
          "IsValidSecurityDescriptor",
          "IsValidSid",
          "LookupPrivilegeValueW",
          "OpenProcessToken",
          "OpenSCManagerW",
          "OpenServiceW",
          "OpenThreadToken",
          "QueryServiceConfig2W",
          "QueryServiceConfigW",
          "QueryServiceObjectSecurity",
          "QueryServiceStatusEx",
          "RegisterServiceCtrlHandlerExW",
          "RevertToSelf",
          "SetSecurityDescriptorControl",
          "SetSecurityDescriptorDacl",
          "SetSecurityDescriptorGroup",
          "SetSecurityDescriptorOwner",
          "SetServiceStatus",
          "StartServiceCtrlDispatcherW",
        ]),
      }),
      Object.freeze({
        dll: "KERNEL32.dll",
        functions: Object.freeze([
          "CancelIoEx",
          "CloseHandle",
          "CompareStringOrdinal",
          "ConnectNamedPipe",
          "CreateDirectoryW",
          "CreateEventW",
          "CreateFileW",
          "CreateNamedPipeW",
          "CreateThread",
          "DisconnectNamedPipe",
          "DuplicateHandle",
          "ExitProcess",
          "FindClose",
          "FindFirstStreamW",
          "FindNextStreamW",
          "FlushFileBuffers",
          "GetCommandLineW",
          "GetCurrentProcess",
          "GetCurrentProcessId",
          "GetCurrentThread",
          "GetFileInformationByHandleEx",
          "GetFileType",
          "GetFinalPathNameByHandleW",
          "GetLastError",
          "GetNamedPipeClientProcessId",
          "GetOverlappedResult",
          "GetProcessTimes",
          "GetStdHandle",
          "GetSystemTimeAsFileTime",
          "GetTickCount64",
          "GetVolumeInformationByHandleW",
          "LocalFree",
          "OpenProcess",
          "QueryFullProcessImageNameW",
          "ReadFile",
          "RtlCaptureContext",
          "SetEvent",
          "SetFileInformationByHandle",
          "SetFilePointerEx",
          "SetLastError",
          "SetUnhandledExceptionFilter",
          "Sleep",
          "TerminateProcess",
          "UnhandledExceptionFilter",
          "WaitForMultipleObjects",
          "WaitForSingleObject",
          "WriteFile",
          "WTSGetActiveConsoleSessionId",
        ]),
      }),
      Object.freeze({
        dll: "Secur32.dll",
        functions: Object.freeze(["LsaFreeReturnBuffer", "LsaGetLogonSessionData"]),
      }),
      Object.freeze({
        dll: "bcrypt.dll",
        functions: Object.freeze([
          "BCryptCloseAlgorithmProvider",
          "BCryptCreateHash",
          "BCryptDestroyHash",
          "BCryptFinishHash",
          "BCryptGenRandom",
          "BCryptGetProperty",
          "BCryptHashData",
          "BCryptOpenAlgorithmProvider",
        ]),
      }),
    ]),
  }),
  client: Object.freeze({
    "windows-x64": Object.freeze([
      Object.freeze({
        dll: "ADVAPI32.dll",
        functions: Object.freeze([
          "CloseServiceHandle",
          "EqualSid",
          "GetAce",
          "GetLengthSid",
          "GetSecurityDescriptorControl",
          "GetSecurityDescriptorDacl",
          "GetSecurityInfo",
          "GetSidSubAuthority",
          "GetSidSubAuthorityCount",
          "GetTokenInformation",
          "IsTokenRestricted",
          "IsValidAcl",
          "IsValidSecurityDescriptor",
          "IsValidSid",
          "OpenProcessToken",
          "OpenSCManagerW",
          "OpenServiceW",
          "OpenThreadToken",
          "QueryServiceConfigW",
          "QueryServiceStatusEx",
        ]),
      }),
      Object.freeze({
        dll: "KERNEL32.dll",
        functions: Object.freeze([
          "CancelIoEx",
          "CloseHandle",
          "CompareStringOrdinal",
          "CreateEventW",
          "CreateFileW",
          "ExitProcess",
          "FindClose",
          "FindFirstStreamW",
          "FindNextStreamW",
          "GetCommandLineW",
          "GetCurrentProcess",
          "GetCurrentProcessId",
          "GetCurrentThread",
          "GetCurrentThreadId",
          "GetFileInformationByHandleEx",
          "GetFileType",
          "GetFinalPathNameByHandleW",
          "GetLastError",
          "GetNamedPipeServerProcessId",
          "GetOverlappedResult",
          "GetProcessTimes",
          "GetStdHandle",
          "GetSystemTimeAsFileTime",
          "GetTickCount",
          "GetTickCount64",
          "LocalFree",
          "OpenProcess",
          "PeekNamedPipe",
          "QueryFullProcessImageNameW",
          "QueryPerformanceCounter",
          "ReadFile",
          "RtlCaptureContext",
          "RtlLookupFunctionEntry",
          "RtlVirtualUnwind",
          "SetFilePointerEx",
          "SetLastError",
          "SetUnhandledExceptionFilter",
          "Sleep",
          "TerminateProcess",
          "UnhandledExceptionFilter",
          "WaitForMultipleObjects",
          "WaitForSingleObject",
          "WaitNamedPipeW",
          "WriteFile",
        ]),
      }),
      Object.freeze({
        dll: "bcrypt.dll",
        functions: Object.freeze([
          "BCryptCloseAlgorithmProvider",
          "BCryptCreateHash",
          "BCryptDestroyHash",
          "BCryptFinishHash",
          "BCryptGenRandom",
          "BCryptGetProperty",
          "BCryptHashData",
          "BCryptOpenAlgorithmProvider",
        ]),
      }),
    ]),
    "windows-arm64": Object.freeze([
      Object.freeze({
        dll: "ADVAPI32.dll",
        functions: Object.freeze([
          "CloseServiceHandle",
          "EqualSid",
          "GetAce",
          "GetLengthSid",
          "GetSecurityDescriptorControl",
          "GetSecurityDescriptorDacl",
          "GetSecurityInfo",
          "GetSidSubAuthority",
          "GetSidSubAuthorityCount",
          "GetTokenInformation",
          "IsTokenRestricted",
          "IsValidAcl",
          "IsValidSecurityDescriptor",
          "IsValidSid",
          "OpenProcessToken",
          "OpenSCManagerW",
          "OpenServiceW",
          "OpenThreadToken",
          "QueryServiceConfigW",
          "QueryServiceStatusEx",
        ]),
      }),
      Object.freeze({
        dll: "KERNEL32.dll",
        functions: Object.freeze([
          "CancelIoEx",
          "CloseHandle",
          "CompareStringOrdinal",
          "CreateEventW",
          "CreateFileW",
          "ExitProcess",
          "FindClose",
          "FindFirstStreamW",
          "FindNextStreamW",
          "GetCommandLineW",
          "GetCurrentProcess",
          "GetCurrentProcessId",
          "GetCurrentThread",
          "GetFileInformationByHandleEx",
          "GetFileType",
          "GetFinalPathNameByHandleW",
          "GetLastError",
          "GetNamedPipeServerProcessId",
          "GetOverlappedResult",
          "GetProcessTimes",
          "GetStdHandle",
          "GetTickCount64",
          "LocalFree",
          "OpenProcess",
          "PeekNamedPipe",
          "QueryFullProcessImageNameW",
          "ReadFile",
          "RtlCaptureContext",
          "SetFilePointerEx",
          "SetLastError",
          "SetUnhandledExceptionFilter",
          "Sleep",
          "TerminateProcess",
          "UnhandledExceptionFilter",
          "WaitForMultipleObjects",
          "WaitForSingleObject",
          "WaitNamedPipeW",
          "WriteFile",
        ]),
      }),
      Object.freeze({
        dll: "bcrypt.dll",
        functions: Object.freeze([
          "BCryptCloseAlgorithmProvider",
          "BCryptCreateHash",
          "BCryptDestroyHash",
          "BCryptFinishHash",
          "BCryptGenRandom",
          "BCryptGetProperty",
          "BCryptHashData",
          "BCryptOpenAlgorithmProvider",
        ]),
      }),
    ]),
  }),
  availability: Object.freeze({
    "windows-x64": Object.freeze([
      Object.freeze({
        dll: "ADVAPI32.dll",
        functions: Object.freeze([
          "CloseServiceHandle",
          "EqualSid",
          "GetAce",
          "GetLengthSid",
          "GetSecurityDescriptorControl",
          "GetSecurityDescriptorDacl",
          "GetSecurityDescriptorOwner",
          "GetSecurityInfo",
          "GetTokenInformation",
          "IsTokenRestricted",
          "IsValidAcl",
          "IsValidSecurityDescriptor",
          "IsValidSid",
          "LookupPrivilegeValueW",
          "OpenProcessToken",
          "OpenSCManagerW",
          "OpenServiceW",
          "OpenThreadToken",
          "QueryServiceConfig2W",
          "QueryServiceConfigW",
          "QueryServiceObjectSecurity",
          "QueryServiceStatusEx",
          "RegisterServiceCtrlHandlerExW",
          "SetServiceStatus",
          "StartServiceCtrlDispatcherW",
          "StartServiceW",
        ]),
      }),
      Object.freeze({
        dll: "KERNEL32.dll",
        functions: Object.freeze([
          "CloseHandle",
          "CompareStringOrdinal",
          "CreateEventW",
          "CreateFileW",
          "ExitProcess",
          "FindClose",
          "FindFirstStreamW",
          "FindNextStreamW",
          "GetCurrentProcess",
          "GetCurrentProcessId",
          "GetCurrentThread",
          "GetCurrentThreadId",
          "GetFileInformationByHandleEx",
          "GetFinalPathNameByHandleW",
          "GetLastError",
          "GetProcessTimes",
          "GetSystemTimeAsFileTime",
          "GetTickCount",
          "GetTickCount64",
          "LocalFree",
          "OpenProcess",
          "QueryFullProcessImageNameW",
          "QueryPerformanceCounter",
          "ReadFile",
          "RtlCaptureContext",
          "RtlLookupFunctionEntry",
          "RtlVirtualUnwind",
          "SetEvent",
          "SetFilePointerEx",
          "SetLastError",
          "SetUnhandledExceptionFilter",
          "TerminateProcess",
          "UnhandledExceptionFilter",
          "WaitForSingleObject",
        ]),
      }),
      Object.freeze({
        dll: "bcrypt.dll",
        functions: Object.freeze([
          "BCryptCloseAlgorithmProvider",
          "BCryptCreateHash",
          "BCryptDestroyHash",
          "BCryptFinishHash",
          "BCryptGetProperty",
          "BCryptHashData",
          "BCryptOpenAlgorithmProvider",
        ]),
      }),
    ]),
    "windows-arm64": Object.freeze([
      Object.freeze({
        dll: "ADVAPI32.dll",
        functions: Object.freeze([
          "CloseServiceHandle",
          "EqualSid",
          "GetAce",
          "GetLengthSid",
          "GetSecurityDescriptorControl",
          "GetSecurityDescriptorDacl",
          "GetSecurityDescriptorOwner",
          "GetSecurityInfo",
          "GetTokenInformation",
          "IsTokenRestricted",
          "IsValidAcl",
          "IsValidSecurityDescriptor",
          "IsValidSid",
          "LookupPrivilegeValueW",
          "OpenProcessToken",
          "OpenSCManagerW",
          "OpenServiceW",
          "OpenThreadToken",
          "QueryServiceConfig2W",
          "QueryServiceConfigW",
          "QueryServiceObjectSecurity",
          "QueryServiceStatusEx",
          "RegisterServiceCtrlHandlerExW",
          "SetServiceStatus",
          "StartServiceCtrlDispatcherW",
          "StartServiceW",
        ]),
      }),
      Object.freeze({
        dll: "KERNEL32.dll",
        functions: Object.freeze([
          "CloseHandle",
          "CompareStringOrdinal",
          "CreateEventW",
          "CreateFileW",
          "ExitProcess",
          "FindClose",
          "FindFirstStreamW",
          "FindNextStreamW",
          "GetCurrentProcess",
          "GetCurrentProcessId",
          "GetCurrentThread",
          "GetFileInformationByHandleEx",
          "GetFinalPathNameByHandleW",
          "GetLastError",
          "GetProcessTimes",
          "GetTickCount64",
          "LocalFree",
          "OpenProcess",
          "QueryFullProcessImageNameW",
          "ReadFile",
          "RtlCaptureContext",
          "SetEvent",
          "SetFilePointerEx",
          "SetLastError",
          "SetUnhandledExceptionFilter",
          "TerminateProcess",
          "UnhandledExceptionFilter",
          "WaitForSingleObject",
        ]),
      }),
      Object.freeze({
        dll: "bcrypt.dll",
        functions: Object.freeze([
          "BCryptCloseAlgorithmProvider",
          "BCryptCreateHash",
          "BCryptDestroyHash",
          "BCryptFinishHash",
          "BCryptGetProperty",
          "BCryptHashData",
          "BCryptOpenAlgorithmProvider",
        ]),
      }),
    ]),
  }),
});

const maximumPeBytes = 4 * 1024 * 1024;
const maximumSections = 96;
const maximumImportFunctions = 256;
const forbiddenProvisionerImportPatterns = Object.freeze([
  /^(?:CreateDirectory|RemoveDirectory|DeleteFile|MoveFile|ReplaceFile|SetFile(?:Attributes|InformationByHandle|ShortName|Time|ValidData)|SetEndOfFile|FlushFileBuffers)/u,
  /^(?:SetSecurityInfo|SetNamedSecurityInfo|SetKernelObjectSecurity|SetFileSecurity|SetServiceObjectSecurity)/u,
  /^(?:GetEnvironment|SetEnvironment|ExpandEnvironment)/u,
  /^(?:LoadLibrary|GetProcAddress|FreeLibrary|GetModuleHandle|GetModuleFileName)/u,
  /^(?:CreateProcess|CreateJobObject|AssignProcessToJobObject)/u,
  /^(?:CreateService(?:A|W)|StartService(?:A|W)|ControlService|ControlServiceEx(?:A|W)|ChangeServiceConfig(?:A|W)|ChangeServiceConfig2(?:A|W)|DeleteService)$/u,
  /^(?:AdjustToken|DuplicateToken|SetToken|SetThreadToken|CreateRestrictedToken)/u,
  /^(?:LogonUser|ImpersonateLoggedOnUser|SetNamedPipeHandleState)/u,
  /^(?:BCryptGenerateKeyPair|BCryptFinalizeKeyPair|BCryptSignHash|BCryptExportKey|BCryptImportKey|NCrypt|CryptAcquire|CryptGenKey|CryptExportKey|CryptSign)/u,
  /^Reg[A-Z]/u,
  /^(?:ShellExecute|WinExec)/u,
  /^(?:CoInitialize|CoCreate|CoGet|CLSIDFrom|WMI|Wbem)/u,
  /^(?:WinHttp|Internet|Http|Ftp|WSA|Socket|AcceptEx|ConnectEx|TransmitFile|GetAddrInfo|GetNameInfo|FreeAddrInfo|Dns)/u,
  /^(?:socket|connect|bind|listen|accept|send|recv|getaddrinfo|freeaddrinfo|closesocket|setsockopt|getsockopt|select|ioctlsocket)$/u,
]);
const w1b1aServiceAuthorityImports = Object.freeze([
  "CreateDirectoryW",
  "DuplicateHandle",
  "FlushFileBuffers",
  "GetSecurityDescriptorGroup",
  "GetVolumeInformationByHandleW",
  "SetFileInformationByHandle",
  "SetSecurityDescriptorGroup",
]);
const availabilityAuthorityImports = Object.freeze(["StartServiceW"]);
const nativeTestSeed = "0x47504357";
const nativeTestCases = 65_536;
const expectedNativeTestReceipt = `GCPW_NATIVE_TESTS seed=${nativeTestSeed} cases=${nativeTestCases}\n`;
const ed25519InteropMagic = Buffer.from("GCEI", "ascii");
const rfc8032TestOneSeedHex = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const rfc8032TestOnePublicKeyHex = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const rfc8032TestOneSignatureHex =
  "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
const expectedEd25519InteropReceipt =
  `GCPW_ED25519_INTEROP public=${rfc8032TestOnePublicKeyHex} ` + `signature=${rfc8032TestOneSignatureHex}\n`;
const protectedSigningInteropSchema = "goatcitadel.remote-worker.protected-signing-interop.v1";
const protectedSigningInteropPatternSeed = 49;
const protectedSigningInteropCases = Object.freeze([
  Object.freeze({ purpose: "runtime-manifest", length: 0 }),
  Object.freeze({ purpose: "runtime-manifest", length: 1 }),
  Object.freeze({ purpose: "runtime-manifest", length: 65_535 }),
  Object.freeze({ purpose: "runtime-manifest", length: 65_536 }),
  Object.freeze({ purpose: "runtime-manifest", length: 65_537 }),
  Object.freeze({ purpose: "runtime-manifest", length: 524_288 }),
  Object.freeze({ purpose: "admission-evidence", length: 8_388_608 }),
]);
const protectedSigningInteropReceiptPattern =
  /^GCPW_PROTECTED_SIGNING_INTEROP schema=goatcitadel\.remote-worker\.protected-signing-interop\.v1 purpose=(runtime-manifest|admission-evidence) length=(0|[1-9][0-9]*) pattern_seed=([0-9]+) public_key=([a-f0-9]{64}) signature=([a-f0-9]{128})$/u;
const vendorPreflightReceiptPattern =
  /^GCPW_VENDOR_PREFLIGHT schema=goatcitadel\.monocypher-preflight\.v1 files=6 identity_sha256=([a-f0-9]{64})\n$/u;
const monocypherArchive = Object.freeze({
  url: "https://monocypher.org/download/monocypher-4.0.3.tar.gz",
  bytes: 940_390,
  sha256: "8cc9bc341a66249016db9bd70e9142d8d0aef9945973744b1ac05dbc55d8ee66",
  sha512:
    "40904ada5c7ee4f7741733e38b69a30a4b0561cbffba5ffe7c2dce16136d540251ec0d9056ff606510d3b5b708fb8a40db7e0870d4a0b2dc17ba2bfb880f8965",
  blake2b:
    "5c586019e8e78ce6fb70f73f4ded10c852335138394b22fb704d0b4379edfc1adaea342f0e4c4b8c52fcf053df401d1fe47812ee5cb5062813de19fc51f8ae93",
  sha512SidecarUrl: "https://monocypher.org/download/monocypher-4.0.3.tar.gz.sha512",
  blake2bSidecarUrl: "https://monocypher.org/download/monocypher-4.0.3.tar.gz.blake2b",
});
const monocypherFiles = Object.freeze([
  Object.freeze({
    path: "src/monocypher.c",
    bytes: 102_580,
    sha256: "57eb914fc88136119bd41655cccb8c250048bf54d470540625186f8ab16f64be",
  }),
  Object.freeze({
    path: "src/monocypher.h",
    bytes: 12_175,
    sha256: "c494da712122da7ff679fdcf318a5317e84972b6c950fe9d896212947797facd",
  }),
  Object.freeze({
    path: "src/optional/monocypher-ed25519.c",
    bytes: 16_524,
    sha256: "60fce3578fb00b00da96490653d993c4cb427b1e1be38183285c66e04d22cc18",
  }),
  Object.freeze({
    path: "src/optional/monocypher-ed25519.h",
    bytes: 5_449,
    sha256: "abc4fad381879f5c29176ebe014b9189956b3dfe0a3e36459b6990bc57212380",
  }),
  Object.freeze({
    path: "LICENCE.md",
    bytes: 9_085,
    sha256: "5f8360e4c06ddcc584bdb4b210c6af824c4bb301e6a9a521869b6d90795ca4b3",
  }),
]);
const monocypherSourceReceipt = Object.freeze({
  schema: "goatcitadel.vendor-source-receipt.v1",
  archive: monocypherArchive,
  repository: Object.freeze({
    url: "https://github.com/LoupVaillant/Monocypher.git",
    tag: "4.0.3",
    correlationCommit: "ab2b16dd619ad5f6979a4fbe69cfa324a6fcc35f",
  }),
  licenseExpression: "BSD-2-Clause OR CC0-1.0",
  files: monocypherFiles,
});
const expectedMonocypherReceiptBytes = Buffer.from(`${JSON.stringify(monocypherSourceReceipt, null, 2)}\n`, "utf8");
const expectedMonocypherDirectoryClosure = Object.freeze([
  Object.freeze({ path: ".", entries: Object.freeze(["GOATCITADEL_SOURCE_RECEIPT.json", "LICENCE.md", "src"]) }),
  Object.freeze({ path: "src", entries: Object.freeze(["monocypher.c", "monocypher.h", "optional"]) }),
  Object.freeze({
    path: "src/optional",
    entries: Object.freeze(["monocypher-ed25519.c", "monocypher-ed25519.h"]),
  }),
]);

export function validateMonocypherSourceSnapshot(sourceRoot) {
  if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)) {
    throw new TypeError("The Monocypher source snapshot root must be an absolute path.");
  }
  const unresolvedRoot = path.resolve(sourceRoot);
  const unresolvedRootStat = fs.lstatSync(unresolvedRoot);
  if (!unresolvedRootStat.isDirectory() || unresolvedRootStat.isSymbolicLink()) {
    throw new Error("The original Monocypher source snapshot root is not a private regular directory.");
  }
  const resolvedRoot = fs.realpathSync.native(sourceRoot);
  if (process.platform === "win32") {
    if (resolvedRoot.toLowerCase() !== unresolvedRoot.toLowerCase()) {
      throw new Error("The Monocypher source snapshot root resolves through a junction or alternate path.");
    }
  } else if (resolvedRoot !== unresolvedRoot) {
    throw new Error("The Monocypher source snapshot root resolves through a symbolic or alternate path.");
  }
  const rootStat = fs.lstatSync(resolvedRoot);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    !sameFileIdentity(unresolvedRootStat, rootStat) ||
    unresolvedRootStat.size !== rootStat.size
  ) {
    throw new Error("The Monocypher source snapshot root is not a private regular directory.");
  }

  for (const closure of expectedMonocypherDirectoryClosure) {
    const directory = closure.path === "." ? resolvedRoot : path.join(resolvedRoot, ...closure.path.split("/"));
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error(`The Monocypher snapshot directory ${closure.path} is not regular.`);
    }
    const entries = fs.readdirSync(directory).sort(asciiCompare);
    if (entries.length !== closure.entries.length || entries.some((entry, index) => entry !== closure.entries[index])) {
      throw new Error(`The Monocypher snapshot directory closure differs at ${closure.path}.`);
    }
  }

  for (const expected of monocypherFiles) {
    const filePath = path.join(resolvedRoot, ...expected.path.split("/"));
    const bytes = readStableRegularFile(filePath, expected.bytes, `Monocypher snapshot entry ${expected.path}`);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== expected.sha256) {
      throw new Error(`The Monocypher snapshot entry ${expected.path} differs from the official release tuple.`);
    }
  }

  const receiptPath = path.join(resolvedRoot, "GOATCITADEL_SOURCE_RECEIPT.json");
  const receiptBytes = readStableRegularFile(
    receiptPath,
    expectedMonocypherReceiptBytes.length,
    "Monocypher source receipt",
  );
  if (!receiptBytes.equals(expectedMonocypherReceiptBytes)) {
    throw new Error("The Monocypher source receipt differs from the frozen canonical bytes.");
  }
  const parsedReceipt = JSON.parse(receiptBytes.toString("utf8"));
  if (JSON.stringify(parsedReceipt) !== JSON.stringify(monocypherSourceReceipt)) {
    throw new Error("The Monocypher source receipt schema or ordered literals are invalid.");
  }

  return Object.freeze({
    version: "4.0.3",
    archive: monocypherArchive,
    receiptSha256: crypto.createHash("sha256").update(receiptBytes).digest("hex"),
    receiptBytes: receiptBytes.length,
    files: monocypherFiles,
  });
}

function readStableRegularFile(filePath, expectedBytes, description) {
  const before = fs.lstatSync(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(expectedBytes)) {
    throw new Error(`The ${description} is not a regular file with the exact bounded size.`);
  }
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened) || opened.size !== before.size) {
      throw new Error(`The ${description} identity changed before its bounded read.`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      bytes.length !== expectedBytes ||
      !sameFileIdentity(opened, after) ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    ) {
      throw new Error(`The ${description} identity or size changed during its bounded read.`);
    }
    const finalPath = fs.lstatSync(filePath, { bigint: true });
    if (!sameFileIdentity(after, finalPath) || finalPath.size !== after.size) {
      throw new Error(`The ${description} path identity changed after its bounded read.`);
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function computeW1B1aCanonicalSourceManifest(sourceRoot = repoRoot) {
  if (REMOTE_WORKER_WINDOWS_PROVISIONER_W1B1A_SOURCE_PATHS.length !== 47) {
    throw new Error("The W1B1A canonical source fence must contain exactly 47 paths.");
  }
  const sortedPaths = [...REMOTE_WORKER_WINDOWS_PROVISIONER_W1B1A_SOURCE_PATHS].sort();
  if (!sortedPaths.every((value, index) => value === REMOTE_WORKER_WINDOWS_PROVISIONER_W1B1A_SOURCE_PATHS[index])) {
    throw new Error("The W1B1A canonical source fence is not ordinally sorted.");
  }
  if (new Set(sortedPaths).size !== sortedPaths.length) {
    throw new Error("The W1B1A canonical source fence contains a duplicate path.");
  }
  const entries = sortedPaths.map((relativePath) => {
    if (relativePath.includes("\\") || path.isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
      throw new Error("The W1B1A canonical source fence contains a non-canonical path.");
    }
    const sourcePath = path.join(sourceRoot, ...relativePath.split("/"));
    const sourceStat = fs.lstatSync(sourcePath, { bigint: true });
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > 4n * 1024n * 1024n) {
      throw new Error(`The W1B1A source ${relativePath} is not a bounded regular file.`);
    }
    const bytes = readStableRegularFile(sourcePath, Number(sourceStat.size), `W1B1A source ${relativePath}`);
    return Object.freeze({
      path: relativePath,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    });
  });
  const bytes = Buffer.from(entries.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n"), "utf8");
  return Object.freeze({
    schema: "goatcitadel.remote-worker.provisioner.w1b1a-source-manifest.v2",
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
    fileCount: entries.length,
    entries: Object.freeze(entries),
    bytes,
  });
}

export function computeW1B1bP0CanonicalSourceManifest(sourceRoot = repoRoot) {
  if (REMOTE_WORKER_WINDOWS_PROVISIONER_W1B1B_P0_SOURCE_PATHS.length !== 17) {
    throw new Error("The W1B1B-P0 canonical source fence must contain exactly 17 paths.");
  }
  const sortedPaths = [...REMOTE_WORKER_WINDOWS_PROVISIONER_W1B1B_P0_SOURCE_PATHS].sort();
  if (!sortedPaths.every((value, index) => value === REMOTE_WORKER_WINDOWS_PROVISIONER_W1B1B_P0_SOURCE_PATHS[index])) {
    throw new Error("The W1B1B-P0 canonical source fence is not ordinally sorted.");
  }
  if (new Set(sortedPaths).size !== sortedPaths.length) {
    throw new Error("The W1B1B-P0 canonical source fence contains a duplicate path.");
  }
  const entries = sortedPaths.map((relativePath) => {
    if (relativePath.includes("\\") || path.isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
      throw new Error("The W1B1B-P0 canonical source fence contains a non-canonical path.");
    }
    const sourcePath = path.join(sourceRoot, ...relativePath.split("/"));
    const sourceStat = fs.lstatSync(sourcePath, { bigint: true });
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > 4n * 1024n * 1024n) {
      throw new Error(`The W1B1B-P0 source ${relativePath} is not a bounded regular file.`);
    }
    const bytes = readStableRegularFile(sourcePath, Number(sourceStat.size), `W1B1B-P0 source ${relativePath}`);
    return Object.freeze({
      path: relativePath,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    });
  });
  const bytes = Buffer.from(entries.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n"), "utf8");
  return Object.freeze({
    schema: "goatcitadel.remote-worker.provisioner.w1b1b-p0-source-manifest.v2",
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
    fileCount: entries.length,
    entries: Object.freeze(entries),
    bytes,
  });
}

export function createFixedEd25519InteropFrame() {
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(rfc8032TestOneSeedHex, "hex"),
  ]);
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(rfc8032TestOnePublicKeyHex, "hex"),
  ]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const publicKey = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  const derivedSpki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(derivedSpki) || !derivedSpki.equals(spki)) {
    throw new Error("Node did not derive the exact RFC 8032 test-one public key.");
  }
  const signature = crypto.sign(null, Buffer.alloc(0), privateKey);
  const expectedSignature = Buffer.from(rfc8032TestOneSignatureHex, "hex");
  if (!signature.equals(expectedSignature) || !crypto.verify(null, Buffer.alloc(0), publicKey, signature)) {
    throw new Error("Node did not reproduce and verify the exact RFC 8032 test-one signature.");
  }
  const frame = Buffer.alloc(8 + signature.length);
  ed25519InteropMagic.copy(frame, 0);
  frame.writeUInt8(1, 4);
  frame.writeUInt8(0, 5);
  frame.writeUInt16LE(signature.length, 6);
  signature.copy(frame, 8);
  return frame;
}

function createProtectedSigningInteropArtifact(length) {
  const artifact = Buffer.alloc(length);
  for (let offset = 0; offset < artifact.length; ++offset) {
    artifact[offset] = (offset * 131 + Math.floor(offset / 8) + protectedSigningInteropPatternSeed) & 0xff;
  }
  return artifact;
}

export function verifyProtectedSigningInteropReceipts(stdout) {
  if (
    typeof stdout !== "string" ||
    !stdout.startsWith(expectedEd25519InteropReceipt) ||
    !stdout.endsWith(expectedNativeTestReceipt)
  ) {
    throw new Error("The native test output did not preserve the fixed RFC and native receipt boundaries.");
  }
  const receiptBytes = stdout.slice(expectedEd25519InteropReceipt.length, -expectedNativeTestReceipt.length);
  const receiptLines = receiptBytes.split("\n");
  if (receiptLines.at(-1) !== "") {
    throw new Error("The protected-signing interoperability receipt was not newline terminated.");
  }
  receiptLines.pop();
  if (receiptLines.length !== protectedSigningInteropCases.length) {
    throw new Error("The protected-signing interoperability receipt did not contain exactly seven cases.");
  }

  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(rfc8032TestOnePublicKeyHex, "hex"),
  ]);
  const publicKey = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  const verifiedCases = receiptLines.map((line, index) => {
    const match = protectedSigningInteropReceiptPattern.exec(line);
    if (match === null) {
      throw new Error(`The protected-signing interoperability receipt case ${index} was not canonical.`);
    }
    const [, purpose, lengthText, patternSeedText, publicKeyHex, signatureHex] = match;
    const expected = protectedSigningInteropCases[index];
    const length = Number.parseInt(lengthText, 10);
    const patternSeed = Number.parseInt(patternSeedText, 10);
    if (
      purpose !== expected.purpose ||
      length !== expected.length ||
      patternSeed !== protectedSigningInteropPatternSeed ||
      publicKeyHex !== rfc8032TestOnePublicKeyHex
    ) {
      throw new Error(`The protected-signing interoperability receipt case ${index} changed its fixed authority.`);
    }
    const artifact = createProtectedSigningInteropArtifact(length);
    const message =
      purpose === "admission-evidence"
        ? Buffer.concat([
            Buffer.from("goatcitadel.remote-worker.provisioning-evidence.signature.v1\0", "utf8"),
            artifact,
          ])
        : artifact;
    const signature = Buffer.from(signatureHex, "hex");
    if (!crypto.verify(null, message, publicKey, signature)) {
      throw new Error(`Node rejected protected-signing interoperability receipt case ${index}.`);
    }
    return Object.freeze({ purpose, length, patternSeed, signature: signatureHex, verified: true });
  });
  return Object.freeze({
    schema: protectedSigningInteropSchema,
    publicKey: rfc8032TestOnePublicKeyHex,
    cases: Object.freeze(verifiedCases),
  });
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.target) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  const result = buildRemoteWorkerWindowsProvisioner(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function parseArguments(arguments_) {
  const parsed = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--target") {
      parsed.target = arguments_[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--out-dir") {
      parsed.outDir = arguments_[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return parsed;
}

function printUsage() {
  process.stderr.write(
    "Usage: node scripts/packaging/build-remote-worker-provisioner-windows-native.mjs --target <windows-x64|windows-arm64> --out-dir <directory>\n",
  );
}

export function buildRemoteWorkerWindowsProvisioner({ target, outDir }) {
  const expectedMachine = targetMachines[target];
  if (expectedMachine === undefined) {
    throw new Error(`Unsupported remote-worker Windows provisioner target: ${String(target)}`);
  }
  if (typeof outDir !== "string" || outDir.length === 0) {
    throw new Error("--out-dir is required.");
  }
  const sourceManifest = computeW1B1aCanonicalSourceManifest();
  const w1b1bP0SourceManifest = computeW1B1bP0CanonicalSourceManifest();

  const productionToolchain = resolveExactWindowsToolchain(target);
  const hostTestToolchain = resolveExactWindowsToolchain("windows-x64");
  const targetTestToolchain = target === "windows-x64" ? hostTestToolchain : resolveExactWindowsToolchain(target);
  const destinationRoot = path.resolve(outDir);
  fs.mkdirSync(destinationRoot, { recursive: true });
  const serviceDestination = path.join(destinationRoot, REMOTE_WORKER_WINDOWS_PROVISIONER_NAME);
  const clientDestination = path.join(destinationRoot, REMOTE_WORKER_WINDOWS_PROVISIONER_CLIENT_NAME);
  const availabilityDestination = path.join(
    destinationRoot,
    REMOTE_WORKER_WINDOWS_PROVISIONER_AVAILABILITY_NAME,
  );
  assertNoProvisionerPublicationResidue(destinationRoot, [
    serviceDestination,
    clientDestination,
    availabilityDestination,
  ]);
  const forbiddenTestDestination = path.join(destinationRoot, REMOTE_WORKER_WINDOWS_PROVISIONER_TEST_NAME);
  const serviceExists = fs.existsSync(serviceDestination);
  const clientExists = fs.existsSync(clientDestination);
  const availabilityExists = fs.existsSync(availabilityDestination);
  if (serviceExists !== clientExists || serviceExists !== availabilityExists) {
    throw new Error("The provisioner output contains a partial service/client/availability trio; preserve it and HOLD.");
  }
  if (fs.existsSync(forbiddenTestDestination)) {
    throw new Error("The output directory contains the forbidden native-test executable.");
  }

  const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-rw-provisioner-proof-"));
  let operationResult;
  let operationError;
  try {
    const buildRootA = path.join(temporaryParent, "clean-pair-a");
    const buildRootB = path.join(temporaryParent, "clean-pair-b-with-distinct-length");
    const hostTestRootA = path.join(temporaryParent, "native-test-host-clean-a");
    const hostTestRootB = path.join(temporaryParent, "native-test-host-clean-b-with-distinct-length");
    const targetTestRootA = path.join(temporaryParent, "native-test-target-clean-a");
    const targetTestRootB = path.join(temporaryParent, "native-test-target-clean-b-with-distinct-length");
    const preflightRoot = path.join(temporaryParent, "vendor-preflight-root");
    const monocypherSnapshotRoot = path.join(temporaryParent, "validated-monocypher-4.0.3-snapshot");
    fs.mkdirSync(buildRootA, { recursive: true });
    fs.mkdirSync(buildRootB, { recursive: true });
    fs.mkdirSync(hostTestRootA, { recursive: true });
    fs.mkdirSync(hostTestRootB, { recursive: true });
    fs.mkdirSync(targetTestRootA, { recursive: true });
    fs.mkdirSync(targetTestRootB, { recursive: true });
    fs.mkdirSync(preflightRoot, { recursive: true });

    const preflightBinary = runPinnedVendorPreflightBuild(hostTestToolchain, preflightRoot);
    const preflightReceipt = runVendorPreflight(preflightBinary, monocypherVendorRoot, monocypherSnapshotRoot);
    const monocypherSource = validateMonocypherSourceSnapshot(monocypherSnapshotRoot);
    const nativeRuntimeTest = runPinnedNativeTests({
      toolchain: hostTestToolchain,
      firstBuildRoot: hostTestRootA,
      secondBuildRoot: hostTestRootB,
      monocypherSourceRoot: monocypherSnapshotRoot,
      target: "windows-x64",
      execute: true,
    });
    const nativeTargetTest =
      target === "windows-x64"
        ? nativeRuntimeTest
        : runPinnedNativeTests({
            toolchain: targetTestToolchain,
            firstBuildRoot: targetTestRootA,
            secondBuildRoot: targetTestRootB,
            monocypherSourceRoot: monocypherSnapshotRoot,
            target,
            execute: false,
          });
    const clientBinaryA = runPinnedClientBuild(productionToolchain, path.join(buildRootA, "client"));
    const clientBinaryB = runPinnedClientBuild(productionToolchain, path.join(buildRootB, "client"));
    const clientBytesA = fs.readFileSync(clientBinaryA);
    const clientBytesB = fs.readFileSync(clientBinaryB);
    if (!clientBytesA.equals(clientBytesB)) {
      throw new Error("The two clean provisioner client builds were not byte-identical.");
    }
    const clientPe = inspectRemoteWorkerProvisionerPe(clientBytesA, {
      expectedMachine,
      binaryKind: "client",
    });
    const clientSha256 = crypto.createHash("sha256").update(clientBytesA).digest("hex");

    const serviceBuildA = runPinnedProductionBuild(
      productionToolchain,
      path.join(buildRootA, "service"),
      clientSha256,
      monocypherSnapshotRoot,
    );
    const serviceBuildB = runPinnedProductionBuild(
      productionToolchain,
      path.join(buildRootB, "service"),
      clientSha256,
      monocypherSnapshotRoot,
    );
    const serviceBinaryA = serviceBuildA.binaryPath;
    const serviceBinaryB = serviceBuildB.binaryPath;
    const serviceBytesA = fs.readFileSync(serviceBinaryA);
    const serviceBytesB = fs.readFileSync(serviceBinaryB);
    if (!serviceBytesA.equals(serviceBytesB)) {
      throw new Error("The two clean provisioner service builds were not byte-identical.");
    }
    const servicePe = inspectRemoteWorkerProvisionerPe(serviceBytesA, {
      expectedMachine,
      binaryKind: "service",
    });
    assertEmbeddedClientDigest(serviceBytesA, clientSha256);
    const serviceSha256 = crypto.createHash("sha256").update(serviceBytesA).digest("hex");

    const availabilityBinaryA = runPinnedAvailabilityBuild(
      productionToolchain,
      path.join(buildRootA, "availability"),
      serviceSha256,
    );
    const availabilityBinaryB = runPinnedAvailabilityBuild(
      productionToolchain,
      path.join(buildRootB, "availability"),
      serviceSha256,
    );
    const availabilityBytesA = fs.readFileSync(availabilityBinaryA);
    const availabilityBytesB = fs.readFileSync(availabilityBinaryB);
    if (!availabilityBytesA.equals(availabilityBytesB)) {
      throw new Error("The two clean provisioner availability-broker builds were not byte-identical.");
    }
    const availabilityPe = inspectRemoteWorkerProvisionerPe(availabilityBytesA, {
      expectedMachine,
      binaryKind: "availability",
    });
    assertEmbeddedProvisionerDigest(availabilityBytesA, serviceSha256);

    const pathLeakInputs = [
      repoRoot,
      process.cwd(),
      temporaryParent,
      buildRootA,
      buildRootB,
      hostTestRootA,
      hostTestRootB,
      targetTestRootA,
      targetTestRootB,
      preflightRoot,
      monocypherSnapshotRoot,
      os.tmpdir(),
      os.homedir(),
      process.env.USERNAME,
      process.env.RUNNER_NAME,
    ];
    assertNoRemoteWorkerBuildPathLeak(clientBytesA, pathLeakInputs);
    assertNoRemoteWorkerBuildPathLeak(serviceBytesA, pathLeakInputs);
    assertNoRemoteWorkerBuildPathLeak(availabilityBytesA, pathLeakInputs);
    const nativeCodeEvidence = inspectNativeCryptographyEvidence({
      toolchain: productionToolchain,
      first: serviceBuildA,
      second: serviceBuildB,
      target,
    });
    const finalMonocypherSource = validateMonocypherSourceSnapshot(monocypherSnapshotRoot);
    if (
      finalMonocypherSource.receiptSha256 !== monocypherSource.receiptSha256 ||
      finalMonocypherSource.receiptBytes !== monocypherSource.receiptBytes
    ) {
      throw new Error("The private Monocypher source snapshot changed during the proof builds.");
    }
    const postflight = runVendorPostflight(preflightBinary, monocypherVendorRoot, preflightReceipt);
    const finalSourceManifest = computeW1B1aCanonicalSourceManifest();
    if (
      finalSourceManifest.sha256 !== sourceManifest.sha256 ||
      !finalSourceManifest.bytes.equals(sourceManifest.bytes)
    ) {
      throw new Error("The exact W1B1A source fence changed during the proof builds.");
    }
    const finalW1b1bP0SourceManifest = computeW1B1bP0CanonicalSourceManifest();
    if (
      finalW1b1bP0SourceManifest.sha256 !== w1b1bP0SourceManifest.sha256 ||
      !finalW1b1bP0SourceManifest.bytes.equals(w1b1bP0SourceManifest.bytes)
    ) {
      throw new Error("The exact W1B1B-P0 source fence changed during the proof builds.");
    }

    const publishedTrio = publishProvenProvisionerTrioNoReplace({
      serviceSource: serviceBinaryA,
      serviceDestination,
      serviceExpectedBytes: serviceBytesA,
      clientSource: clientBinaryA,
      clientDestination,
      clientExpectedBytes: clientBytesA,
      availabilitySource: availabilityBinaryA,
      availabilityDestination,
      availabilityExpectedBytes: availabilityBytesA,
    });

    const finalServiceBytes = fs.readFileSync(serviceDestination);
    const finalClientBytes = fs.readFileSync(clientDestination);
    const finalAvailabilityBytes = fs.readFileSync(availabilityDestination);
    if (
      !finalServiceBytes.equals(serviceBytesA) ||
      !finalClientBytes.equals(clientBytesA) ||
      !finalAvailabilityBytes.equals(availabilityBytesA)
    ) {
      throw new Error("The published provisioner trio differs from the proven build bytes.");
    }
    if (fs.existsSync(forbiddenTestDestination)) {
      throw new Error("The native-test executable escaped the temporary proof root.");
    }
    assertNoProvisionerPublicationResidue(destinationRoot, [
      serviceDestination,
      clientDestination,
      availabilityDestination,
    ]);

    operationResult = Object.freeze({
      target,
      path: serviceDestination,
      sha256: serviceSha256,
      byteLength: serviceBytesA.length,
      machine: `0x${servicePe.machine.toString(16)}`,
      coffTimestamp: servicePe.coffTimestamp,
      imports: servicePe.imports,
      service: Object.freeze({
        path: serviceDestination,
        sha256: serviceSha256,
        byteLength: serviceBytesA.length,
        imports: servicePe.imports,
      }),
      client: Object.freeze({
        path: clientDestination,
        sha256: clientSha256,
        byteLength: clientBytesA.length,
        imports: clientPe.imports,
      }),
      availability: Object.freeze({
        path: availabilityDestination,
        sha256: crypto.createHash("sha256").update(availabilityBytesA).digest("hex"),
        byteLength: availabilityBytesA.length,
        imports: availabilityPe.imports,
        targetServiceSha256: serviceSha256,
      }),
      msvcVersion: REMOTE_WORKER_WINDOWS_MSVC_VERSION,
      windowsSdkVersion: REMOTE_WORKER_WINDOWS_SDK_VERSION,
      sourceManifest: Object.freeze({
        schema: sourceManifest.schema,
        sha256: sourceManifest.sha256,
        byteLength: sourceManifest.byteLength,
        fileCount: sourceManifest.fileCount,
        entries: sourceManifest.entries,
      }),
      w1b1bP0SourceManifest: Object.freeze({
        schema: w1b1bP0SourceManifest.schema,
        sha256: w1b1bP0SourceManifest.sha256,
        byteLength: w1b1bP0SourceManifest.byteLength,
        fileCount: w1b1bP0SourceManifest.fileCount,
        entries: w1b1bP0SourceManifest.entries,
      }),
      nativeTests: Object.freeze({
        target: "windows-x64",
        addressSanitizer: true,
        executable: REMOTE_WORKER_WINDOWS_PROVISIONER_TEST_NAME,
        seed: nativeTestSeed,
        cases: nativeTestCases,
        executed: nativeRuntimeTest.executed,
        passed: nativeRuntimeTest.passed,
        cleanBuildCount: nativeRuntimeTest.cleanBuildCount,
        cleanBuildsByteIdentical: nativeRuntimeTest.cleanBuildsByteIdentical,
        sha256: nativeRuntimeTest.sha256,
        byteLength: nativeRuntimeTest.byteLength,
        nodeInterop: nativeRuntimeTest.nodeInterop,
        protectedArtifactSigningInterop: nativeRuntimeTest.protectedArtifactSigningInterop,
      }),
      targetNativeTestBuild: Object.freeze({
        target: nativeTargetTest.target,
        machine: nativeTargetTest.machine,
        addressSanitizer: nativeTargetTest.addressSanitizer,
        executed: nativeTargetTest.executed,
        passed: nativeTargetTest.passed,
        cleanBuildCount: nativeTargetTest.cleanBuildCount,
        cleanBuildsByteIdentical: nativeTargetTest.cleanBuildsByteIdentical,
        sha256: nativeTargetTest.sha256,
        byteLength: nativeTargetTest.byteLength,
      }),
      monocypherSource: Object.freeze({
        version: monocypherSource.version,
        archive: monocypherSource.archive,
        receiptSha256: monocypherSource.receiptSha256,
        receiptBytes: monocypherSource.receiptBytes,
        files: monocypherSource.files,
        preflightIdentitySha256: preflightReceipt.identitySha256,
        postflightPassed: postflight.passed,
      }),
      nativeCodeEvidence,
      ed25519: Object.freeze({
        mode: "fixed-protected-kat-and-admission-evidence-signing",
        rfc8032TestOne: true,
        rfc8410CanonicalEncodings: true,
        realKey: true,
        signingLease: true,
        callableMutation: true,
      }),
      protectedArtifactSigning: Object.freeze({
        tranche: "M2-admission-evidence",
        compiledObject: true,
        finalServiceReachable: true,
        productionFactory: true,
        productionCaller: true,
        artifactProducer: true,
        signingRoute: true,
        testOnlyFactories: true,
        exactArtifactPasses: 2,
        postSignEquationValidation: true,
      }),
      cleanBuildsByteIdentical: true,
      publishedNativeTests: false,
      publishedTrio,
      entrypoints: Object.freeze({
        service: Object.freeze(["SCM-no-args", "--inspect-stdio"]),
        client: Object.freeze(["--service-stdio"]),
        availability: Object.freeze(["SCM-no-args"]),
      }),
      productionDark: true,
      protectedAdmissionEvidenceSigningCallable: true,
      externalProof: Object.freeze({
        elevatedScm: "HOLD",
        successfulProductionClientAuthentication: "HOLD",
        privilegedTransport: "HOLD",
        availabilityBrokerCallerAndInstallerOwner: "HOLD",
        installedAvailabilityBrokerScmContract: "HOLD",
        liveSignerRestart: "HOLD",
        twoMachineAvailabilityBroker: "HOLD",
        liveArm64Execution: "HOLD",
      }),
    });
  } catch (error) {
    operationError = error;
  }

  let cleanupError;
  try {
    fs.rmSync(temporaryParent, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
  }
  if (operationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [operationError, cleanupError],
      "Provisioner build failed and its temporary proof root could not be removed.",
      { cause: operationError },
    );
  }
  if (operationError !== undefined) {
    throw operationError;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
  return operationResult;
}

export function publishProvenProvisionerPairNoReplace({
  serviceSource,
  serviceDestination,
  serviceExpectedBytes,
  clientSource,
  clientDestination,
  clientExpectedBytes,
}) {
  const serviceRoot = path.dirname(serviceDestination);
  const clientRoot = path.dirname(clientDestination);
  if (serviceRoot !== clientRoot) {
    throw new Error("The provisioner service/client destinations must share one publication directory.");
  }
  assertNoProvisionerPublicationResidue(serviceRoot, [serviceDestination, clientDestination]);
  const serviceExists = fs.existsSync(serviceDestination);
  const clientExists = fs.existsSync(clientDestination);
  if (serviceExists !== clientExists) {
    throw new Error("The provisioner output contains a partial service/client pair; preserve it and HOLD.");
  }
  if (serviceExists) {
    const serviceBytes = fs.readFileSync(serviceDestination);
    const clientBytes = fs.readFileSync(clientDestination);
    if (!serviceBytes.equals(serviceExpectedBytes) || !clientBytes.equals(clientExpectedBytes)) {
      throw new Error("The preexisting provisioner pair differs from the newly proven pair; preserve it and HOLD.");
    }
    return false;
  }

  // Client-first publication ensures any crash residue cannot expose a service
  // whose embedded client digest has no matching client artifact.
  publishProvenProvisionerNoReplace({
    source: clientSource,
    destination: clientDestination,
    expectedBytes: clientExpectedBytes,
  });
  publishProvenProvisionerNoReplace({
    source: serviceSource,
    destination: serviceDestination,
    expectedBytes: serviceExpectedBytes,
  });
  assertNoProvisionerPublicationResidue(serviceRoot, [serviceDestination, clientDestination]);
  return true;
}

export function publishProvenProvisionerTrioNoReplace({
  serviceSource,
  serviceDestination,
  serviceExpectedBytes,
  clientSource,
  clientDestination,
  clientExpectedBytes,
  availabilitySource,
  availabilityDestination,
  availabilityExpectedBytes,
}) {
  const serviceRoot = path.dirname(serviceDestination);
  if (
    serviceRoot !== path.dirname(clientDestination) ||
    serviceRoot !== path.dirname(availabilityDestination)
  ) {
    throw new Error("The provisioner service/client/availability destinations must share one publication directory.");
  }
  const destinations = [serviceDestination, clientDestination, availabilityDestination];
  assertNoProvisionerPublicationResidue(serviceRoot, destinations);
  const existence = destinations.map((destination) => fs.existsSync(destination));
  if (existence.some(Boolean) && !existence.every(Boolean)) {
    throw new Error("The provisioner output contains a partial service/client/availability trio; preserve it and HOLD.");
  }
  if (existence.every(Boolean)) {
    const serviceBytes = fs.readFileSync(serviceDestination);
    const clientBytes = fs.readFileSync(clientDestination);
    const availabilityBytes = fs.readFileSync(availabilityDestination);
    if (
      !serviceBytes.equals(serviceExpectedBytes) ||
      !clientBytes.equals(clientExpectedBytes) ||
      !availabilityBytes.equals(availabilityExpectedBytes)
    ) {
      throw new Error("The preexisting provisioner trio differs from the newly proven trio; preserve it and HOLD.");
    }
    return false;
  }

  // Publish from least to most privileged authority. A crash can leave only a
  // preserved partial trio, which the next invocation rejects without cleanup.
  publishProvenProvisionerNoReplace({
    source: clientSource,
    destination: clientDestination,
    expectedBytes: clientExpectedBytes,
  });
  publishProvenProvisionerNoReplace({
    source: serviceSource,
    destination: serviceDestination,
    expectedBytes: serviceExpectedBytes,
  });
  publishProvenProvisionerNoReplace({
    source: availabilitySource,
    destination: availabilityDestination,
    expectedBytes: availabilityExpectedBytes,
  });
  assertNoProvisionerPublicationResidue(serviceRoot, destinations);
  return true;
}

function assertNoProvisionerPublicationResidue(destinationRoot, destinations) {
  const names = fs.readdirSync(destinationRoot);
  for (const destination of destinations) {
    const basename = path.basename(destination);
    const prefix = `.${basename}.`;
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
      const token = name.slice(prefix.length, -4);
      if (/^[a-f0-9]{32}$/u.test(token)) {
        throw new Error(`The provisioner output contains preserved publication residue ${name}; HOLD without cleanup.`);
      }
    }
  }
}

export function publishProvenProvisionerNoReplace({ source, destination, expectedBytes }) {
  if (!Buffer.isBuffer(expectedBytes)) {
    throw new TypeError("expectedBytes must be a Buffer.");
  }
  const destinationRoot = path.dirname(destination);
  const temporaryDestination = path.join(
    destinationRoot,
    "." + path.basename(destination) + "." + crypto.randomBytes(16).toString("hex") + ".tmp",
  );
  try {
    fs.copyFileSync(source, temporaryDestination, fs.constants.COPYFILE_EXCL);
    const copiedBytes = fs.readFileSync(temporaryDestination);
    if (!copiedBytes.equals(expectedBytes)) {
      throw new Error("The staged provisioner differs from the proven build bytes.");
    }
    fs.linkSync(temporaryDestination, destination);
  } finally {
    fs.rmSync(temporaryDestination, { force: true });
  }
}

export function assertEmbeddedClientDigest(serviceBytes, clientSha256) {
  assertEmbeddedDigest(serviceBytes, clientSha256, "service", "client");
}

export function assertEmbeddedProvisionerDigest(availabilityBytes, provisionerSha256) {
  assertEmbeddedDigest(availabilityBytes, provisionerSha256, "availability broker", "provisioner service");
}

function assertEmbeddedDigest(carrierBytes, digestSha256, carrierLabel, targetLabel) {
  if (!/^[a-f0-9]{64}$/u.test(digestSha256)) {
    throw new Error(`The embedded ${targetLabel} SHA-256 is not canonical lowercase hex.`);
  }
  const digest = Buffer.from(digestSha256, "hex");
  const first = carrierBytes.indexOf(digest);
  if (first < 0 || carrierBytes.indexOf(digest, first + 1) >= 0) {
    throw new Error(`The provisioner ${carrierLabel} must contain exactly one raw embedded ${targetLabel} SHA-256.`);
  }
  if (
    containsCaseInsensitiveHexText(carrierBytes, digestSha256, 1, false) ||
    containsCaseInsensitiveHexText(carrierBytes, digestSha256, 2, false) ||
    containsCaseInsensitiveHexText(carrierBytes, digestSha256, 2, true)
  ) {
    throw new Error(`The provisioner ${carrierLabel} retained a forbidden text ${targetLabel} SHA-256 projection.`);
  }

  if (carrierBytes.length < 512 || carrierBytes.readUInt16LE(0) !== 0x5a4d) {
    throw new Error(`The provisioner ${carrierLabel} digest carrier is not a bounded PE image.`);
  }
  const peOffset = carrierBytes.readUInt32LE(0x3c);
  requireRange(carrierBytes, peOffset, 24, `${carrierLabel} digest PE header`);
  if (carrierBytes.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error(`The provisioner ${carrierLabel} digest carrier has an invalid PE signature.`);
  }
  const coffOffset = peOffset + 4;
  const sectionCount = carrierBytes.readUInt16LE(coffOffset + 2);
  const optionalSize = carrierBytes.readUInt16LE(coffOffset + 16);
  if (sectionCount === 0 || sectionCount > maximumSections) {
    throw new Error(`The provisioner ${carrierLabel} digest carrier has an invalid section count.`);
  }
  const sectionTableOffset = coffOffset + 20 + optionalSize;
  requireRange(carrierBytes, sectionTableOffset, sectionCount * 40, `${carrierLabel} digest section table`);
  const carriers = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const sectionOffset = sectionTableOffset + index * 40;
    const rawSize = carrierBytes.readUInt32LE(sectionOffset + 16);
    const rawOffset = carrierBytes.readUInt32LE(sectionOffset + 20);
    const characteristics = carrierBytes.readUInt32LE(sectionOffset + 36);
    if (first >= rawOffset && first + digest.length <= rawOffset + rawSize) {
      carriers.push({ characteristics });
    }
  }
  if (carriers.length !== 1) {
    throw new Error(
      `The provisioner ${carrierLabel} raw ${targetLabel} digest is not contained by exactly one PE section.`,
    );
  }
  const characteristics = carriers[0].characteristics;
  const sectionIsReadable = (characteristics & 0x40000000) !== 0;
  const sectionIsWritable = (characteristics & 0x80000000) !== 0;
  const sectionIsExecutable = (characteristics & 0x20000000) !== 0;
  const sectionContainsCode = (characteristics & 0x00000020) !== 0;
  if (!sectionIsReadable || sectionIsWritable || sectionIsExecutable || sectionContainsCode) {
    throw new Error(`The provisioner ${carrierLabel} raw ${targetLabel} digest is not in a read-only non-code PE section.`);
  }
}

function containsCaseInsensitiveHexText(bytes, lowercaseHex, width, bigEndian) {
  const requiredBytes = lowercaseHex.length * width;
  for (let offset = 0; offset + requiredBytes <= bytes.length; offset += 1) {
    let matches = true;
    for (let index = 0; index < lowercaseHex.length; index += 1) {
      const characterOffset = offset + index * width;
      const valueOffset = width === 1 || !bigEndian ? characterOffset : characterOffset + 1;
      const zeroOffset = width === 1 ? -1 : bigEndian ? characterOffset : characterOffset + 1;
      let actual = bytes[valueOffset];
      if (zeroOffset >= 0 && bytes[zeroOffset] !== 0) {
        matches = false;
        break;
      }
      if (actual >= 0x41 && actual <= 0x46) actual += 0x20;
      if (actual !== lowercaseHex.charCodeAt(index)) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function runPinnedProductionBuild(toolchain, buildRoot, expectedClientSha256, monocypherSourceRoot) {
  const linkMapPath = path.join(buildRoot, "GoatCitadelRemoteWorkerProvisioner.map");
  const binaryPath = runPinnedMsbuild({
    toolchain,
    buildRoot,
    projectPath: productionProjectPath,
    expectedBinaryName: REMOTE_WORKER_WINDOWS_PROVISIONER_NAME,
    addressSanitizer: false,
    additionalProperties: [
      ["ExpectedClientSha256", expectedClientSha256],
      ["MonocypherSourceRoot", monocypherSourceRoot],
      ["ProvisionerLinkMapPath", linkMapPath],
    ],
  });
  const objects = Object.freeze({
    monocypher: path.join(buildRoot, "obj", "monocypher-core.obj"),
    ed25519: path.join(buildRoot, "obj", "monocypher-ed25519.obj"),
    adapter: path.join(buildRoot, "obj", "ed25519-runtime.obj"),
    protectedArtifactSigning: path.join(buildRoot, "obj", "protected-artifact-signing.obj"),
    recovery: path.join(buildRoot, "obj", "protected-operations.obj"),
  });
  for (const [name, objectPath] of Object.entries(objects)) {
    if (!fs.existsSync(objectPath)) {
      throw new Error(`Pinned production build did not emit the expected W1B0 ${name} object.`);
    }
  }
  if (!fs.existsSync(linkMapPath)) {
    throw new Error("Pinned production build did not emit the required W1B0 link map.");
  }
  const compileCommandLogPath = findUniqueFileByBasename(
    path.join(buildRoot, "obj"),
    "CL.command.1.tlog",
    "pinned production compiler command log",
  );
  return Object.freeze({ binaryPath, linkMapPath, compileCommandLogPath, objects, buildRoot });
}

function findUniqueFileByBasename(root, basename, description) {
  const pending = [root];
  const matches = [];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    visited += 1;
    if (visited > 256) {
      throw new Error(`The ${description} search exceeded its directory bound.`);
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`The ${description} search encountered a symbolic link.`);
      }
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && entry.name.toLowerCase() === basename.toLowerCase()) {
        matches.push(candidate);
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(`The ${description} search found ${matches.length} matches instead of one.`);
  }
  return matches[0];
}

function runPinnedClientBuild(toolchain, buildRoot) {
  return runPinnedMsbuild({
    toolchain,
    buildRoot,
    projectPath: clientProjectPath,
    expectedBinaryName: REMOTE_WORKER_WINDOWS_PROVISIONER_CLIENT_NAME,
    addressSanitizer: false,
  });
}

function runPinnedAvailabilityBuild(toolchain, buildRoot, expectedProvisionerSha256) {
  return runPinnedMsbuild({
    toolchain,
    buildRoot,
    projectPath: availabilityProjectPath,
    expectedBinaryName: REMOTE_WORKER_WINDOWS_PROVISIONER_AVAILABILITY_NAME,
    addressSanitizer: false,
    additionalProperties: [["ExpectedProvisionerSha256", expectedProvisionerSha256]],
  });
}

function runPinnedVendorPreflightBuild(toolchain, buildRoot) {
  return runPinnedMsbuild({
    toolchain,
    buildRoot,
    projectPath: testProjectPath,
    expectedBinaryName: REMOTE_WORKER_WINDOWS_PROVISIONER_PREFLIGHT_NAME,
    addressSanitizer: false,
    additionalProperties: [["VendorPreflight", "true"]],
  });
}

function runVendorPreflight(binaryPath, sourceRoot, snapshotRoot) {
  if (fs.existsSync(snapshotRoot)) {
    throw new Error("The private Monocypher snapshot root must not exist before native preflight.");
  }
  const result = spawnSync(binaryPath, ["--vendor-preflight", sourceRoot, snapshotRoot], {
    cwd: path.dirname(binaryPath),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.stderr !== "") {
    throw new Error(
      `Pinned Monocypher vendor preflight failed (${String(result.status)}).\n${boundedBuildOutput(result.stdout)}\n${boundedBuildOutput(result.stderr)}`,
    );
  }
  const match = vendorPreflightReceiptPattern.exec(result.stdout);
  if (match === null) {
    throw new Error(
      `Pinned Monocypher vendor preflight emitted an invalid receipt.\n${boundedBuildOutput(result.stdout)}`,
    );
  }
  return Object.freeze({ raw: result.stdout, identitySha256: match[1] });
}

function runVendorPostflight(binaryPath, sourceRoot, preflightReceipt) {
  const result = spawnSync(binaryPath, ["--vendor-postflight", sourceRoot], {
    cwd: path.dirname(binaryPath),
    input: preflightReceipt.raw,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  const expected =
    "GCPW_VENDOR_POSTFLIGHT schema=goatcitadel.monocypher-postflight.v1 files=6 " +
    `identity_sha256=${preflightReceipt.identitySha256}\n`;
  if (result.status !== 0 || result.stderr !== "" || result.stdout !== expected) {
    throw new Error(
      `Pinned Monocypher vendor postflight failed (${String(result.status)}).\n${boundedBuildOutput(result.stdout)}\n${boundedBuildOutput(result.stderr)}`,
    );
  }
  return Object.freeze({ passed: true });
}

function runPinnedNativeTests({ toolchain, firstBuildRoot, secondBuildRoot, monocypherSourceRoot, target, execute }) {
  if (targetMachines[target] === undefined || execute !== (target === "windows-x64")) {
    throw new Error("The native-test build proof requested an invalid target/execution posture.");
  }
  const addressSanitizer = target === "windows-x64";
  const build = (buildRoot) =>
    runPinnedMsbuild({
      toolchain,
      buildRoot,
      projectPath: testProjectPath,
      expectedBinaryName: REMOTE_WORKER_WINDOWS_PROVISIONER_TEST_NAME,
      addressSanitizer,
      additionalProperties: [["MonocypherSourceRoot", monocypherSourceRoot]],
    });
  const firstBinaryPath = build(firstBuildRoot);
  const secondBinaryPath = build(secondBuildRoot);
  const firstBytes = fs.readFileSync(firstBinaryPath);
  const secondBytes = fs.readFileSync(secondBinaryPath);
  if (!firstBytes.equals(secondBytes)) {
    let firstDifference = 0;
    const commonLength = Math.min(firstBytes.length, secondBytes.length);
    while (firstDifference < commonLength && firstBytes[firstDifference] === secondBytes[firstDifference]) {
      ++firstDifference;
    }
    throw new Error(
      `The two clean ${target} native-test builds were not byte-identical ` +
        `(first_difference=${firstDifference}, first_bytes=${firstBytes.length}, second_bytes=${secondBytes.length}, ` +
        `first_sha256=${crypto.createHash("sha256").update(firstBytes).digest("hex")}, ` +
        `second_sha256=${crypto.createHash("sha256").update(secondBytes).digest("hex")}).`,
    );
  }
  const machine = readPeMachine(firstBytes, `${target} native-test`);
  if (machine !== targetMachines[target]) {
    throw new Error(`The ${target} native-test PE machine does not match its requested architecture.`);
  }
  const commonProof = {
    target,
    machine: `0x${machine.toString(16).padStart(4, "0")}`,
    addressSanitizer,
    executed: execute,
    passed: true,
    cleanBuildCount: 2,
    cleanBuildsByteIdentical: true,
    sha256: crypto.createHash("sha256").update(firstBytes).digest("hex"),
    byteLength: firstBytes.length,
  };
  if (!execute) {
    return Object.freeze({
      ...commonProof,
      nodeInterop: null,
      protectedArtifactSigningInterop: null,
    });
  }

  assertAddressSanitizedNativeTest(firstBytes);
  const environment = buildSanitizedEnvironment(toolchain, firstBuildRoot);
  const interopFrame = createFixedEd25519InteropFrame();
  const result = spawnSync(firstBinaryPath, [], {
    cwd: path.dirname(firstBinaryPath),
    input: interopFrame,
    env: environment,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Pinned x64 ASan provisioner native tests failed (${result.status}).\n${boundedBuildOutput(result.stdout)}\n${boundedBuildOutput(result.stderr)}`,
    );
  }
  if (result.stderr !== "") {
    throw new Error(
      `Pinned x64 ASan provisioner native tests emitted an invalid proof receipt.\n${boundedBuildOutput(result.stdout)}\n${boundedBuildOutput(result.stderr)}`,
    );
  }
  const protectedArtifactSigningInterop = verifyProtectedSigningInteropReceipts(result.stdout);
  const nativeSignature = Buffer.from(rfc8032TestOneSignatureHex, "hex");
  const nativePublicKey = crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(rfc8032TestOnePublicKeyHex, "hex"),
    ]),
    format: "der",
    type: "spki",
  });
  if (!crypto.verify(null, Buffer.alloc(0), nativePublicKey, nativeSignature)) {
    throw new Error("Node rejected the exact native RFC 8032 interoperability receipt signature.");
  }
  return Object.freeze({
    ...commonProof,
    nodeInterop: Object.freeze({
      publicKey: rfc8032TestOnePublicKeyHex,
      signature: rfc8032TestOneSignatureHex,
      frameBytes: interopFrame.length,
      verified: true,
    }),
    protectedArtifactSigningInterop,
  });
}

function readPeMachine(bytes, description) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) {
    throw new Error(`The ${description} is not a bounded PE image.`);
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset > bytes.length - 6 || bytes.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error(`The ${description} has an invalid PE header.`);
  }
  return bytes.readUInt16LE(peOffset + 4);
}

function assertAddressSanitizedNativeTest(bytes) {
  const imports = readPeNamedImports(bytes, "provisioner native-test");
  const addressSanitizer = imports.find((entry) => entry.dll === "clang_rt.asan_dynamic-x86_64.dll");
  if (addressSanitizer === undefined || !addressSanitizer.functions.some((name) => name.startsWith("__asan_"))) {
    throw new Error(
      "The provisioner native-test PE does not import a named __asan_* function from clang_rt.asan_dynamic-x86_64.dll.",
    );
  }
}

function inspectNativeCryptographyEvidence({ toolchain, first, second, target }) {
  const dumpbinPath = checkedExistingDescendant(
    path.dirname(toolchain.linkerPath),
    path.join(path.dirname(toolchain.linkerPath), "dumpbin.exe"),
    "pinned MSVC dumpbin",
  );
  const objectRequirements = Object.freeze({
    monocypher: Object.freeze({
      source: "monocypher.c",
      object: "monocypher-core.obj",
      language: "c",
      symbols: Object.freeze(["fe_ccopy", "fe_cswap", "crypto_wipe"]),
    }),
    ed25519: Object.freeze({
      source: "monocypher-ed25519.c",
      object: "monocypher-ed25519.obj",
      language: "c",
      symbols: Object.freeze(["crypto_sha512_final"]),
    }),
    adapter: Object.freeze({
      source: "ed25519_runtime.cpp",
      object: "ed25519-runtime.obj",
      language: "c++",
      symbols: Object.freeze(["HashReduce", "PureEd25519Sign", "RunKnownAnswerSelfTest"]),
    }),
    protectedArtifactSigning: Object.freeze({
      source: "protected_artifact_signing.cpp",
      object: "protected-artifact-signing.obj",
      language: "c++",
      requiredOptions: Object.freeze(["/EHs-c-", "/GR-", "/Gw"]),
      symbols: Object.freeze(["SignProtectedArtifact", "ProtectedArtifactAuthority", "ProtectedSigningLease"]),
    }),
    recovery: Object.freeze({
      source: "protected_operations.cpp",
      object: "protected-operations.obj",
      language: "c++",
      symbols: Object.freeze([
        "ReplayRecoveryPublications",
        "ValidatePhaseACanonicalReplay",
        "InitializeProtectedOperationsOnce",
        "InitializeProtectedOperations",
      ]),
    }),
  });
  const firstCompiler = inspectCompilerCommandEvidence(first, objectRequirements, toolchain);
  const secondCompiler = inspectCompilerCommandEvidence(second, objectRequirements, toolchain);
  const objects = {};
  const protectedArtifactSigningRequiredBridgeSymbols = Object.freeze([
    "ExpandEd25519SeedForProtectedSigning",
    "ReduceEd25519ScalarForProtectedSigning",
    "Ed25519ScalarBaseForProtectedSigning",
    "Ed25519MulAddForProtectedSigning",
    "CheckEd25519EquationForProtectedSigning",
  ]);
  const protectedArtifactSigningForbiddenObjectResidue = Object.freeze([
    "CreateProtectedSigningLeaseForTest",
    "SetProtectedSigningFailureForTest",
    "SetProtectedSigningDivergenceForTest",
    "SetProtectedSigningRevokeBeforeFinalForTest",
    "SetProtectedSigningWipeObserverForTest",
    "ResetProtectedSigningStateForTest",
    "DriftProtectedSigningLeaseForTest",
    "SignalProtectedSigningStopForTest",
    "ProtectedSigningLeaseConsumedForTest",
    "ProtectedArtifactPatternByteForTest",
    "w1b1b-p0-artifact.bin",
    "w1b1b-p0-key.pk8",
    "g_failure_for_test",
    "g_divergence_for_test",
    "g_wipe_observer_for_test",
    "revoke_ordered_for_test_",
    "atexit",
    "_initterm",
  ]);
  for (const [name, requirement] of Object.entries(objectRequirements)) {
    const firstBytes = fs.readFileSync(first.objects[name]);
    const secondBytes = fs.readFileSync(second.objects[name]);
    const firstDump =
      name === "recovery"
        ? runPinnedRecoveryDumpbinEvidence(dumpbinPath, first.objects[name], name)
        : runPinnedDumpbinEvidence(dumpbinPath, first.objects[name], name);
    const secondDump =
      name === "recovery"
        ? runPinnedRecoveryDumpbinEvidence(dumpbinPath, second.objects[name], name)
        : runPinnedDumpbinEvidence(dumpbinPath, second.objects[name], name);
    const firstRelocationSemantics = normalizeDumpbinRelocationSemantics(firstDump.symbolsAndRelocations);
    const secondRelocationSemantics = normalizeDumpbinRelocationSemantics(secondDump.symbolsAndRelocations);
    if (firstDump.disassembly !== secondDump.disassembly || firstRelocationSemantics !== secondRelocationSemantics) {
      throw new Error(
        `The two clean ${target} W1B0 ${name} generated-code evidence records differ. ` +
          firstEvidenceDifference(
            { disassembly: firstDump.disassembly, symbolsAndRelocations: firstRelocationSemantics },
            { disassembly: secondDump.disassembly, symbolsAndRelocations: secondRelocationSemantics },
          ),
      );
    }
    for (const symbol of requirement.symbols) {
      if (!firstDump.disassembly.includes(symbol) && !firstDump.symbolsAndRelocations.includes(symbol)) {
        throw new Error(`Pinned ${target} ${name} disassembly did not retain the required ${symbol} boundary.`);
      }
    }
    if (name === "protectedArtifactSigning") {
      for (const required of protectedArtifactSigningRequiredBridgeSymbols) {
        if (!firstDump.symbolsAndRelocations.includes(required)) {
          throw new Error(
            `Pinned ${target} protected-artifact-signing object lost required Ed25519 bridge ${required}.`,
          );
        }
      }
      if (/\bcrypto_(?:ed25519|eddsa|x25519|sha512)/u.test(firstDump.symbolsAndRelocations)) {
        throw new Error(
          `Pinned ${target} protected-artifact-signing object bypassed the sole ed25519_runtime Monocypher owner.`,
        );
      }
      for (const forbidden of protectedArtifactSigningForbiddenObjectResidue) {
        const ascii = Buffer.from(forbidden, "utf8");
        const utf16 = Buffer.from(forbidden, "utf16le");
        if (
          firstBytes.includes(ascii) ||
          secondBytes.includes(ascii) ||
          firstBytes.includes(utf16) ||
          secondBytes.includes(utf16) ||
          firstDump.disassembly.includes(forbidden) ||
          firstDump.symbolsAndRelocations.includes(forbidden) ||
          secondDump.disassembly.includes(forbidden) ||
          secondDump.symbolsAndRelocations.includes(forbidden)
        ) {
          throw new Error(
            `Pinned ${target} protected-artifact-signing production object retained forbidden test/global residue ${forbidden}.`,
          );
        }
      }
    }
    objects[name] = Object.freeze({
      bytes: firstBytes.length,
      sha256: crypto.createHash("sha256").update(firstBytes).digest("hex"),
      secondBytes: secondBytes.length,
      secondSha256: crypto.createHash("sha256").update(secondBytes).digest("hex"),
      byteIdentical: firstBytes.equals(secondBytes),
      compilerCommand: firstCompiler.commands[name],
      disassemblySha256: crypto.createHash("sha256").update(firstDump.disassembly, "utf8").digest("hex"),
      disassembly: firstDump.disassembly,
      symbolsAndRelocationsSha256: crypto
        .createHash("sha256")
        .update(firstDump.symbolsAndRelocations, "utf8")
        .digest("hex"),
      symbolsAndRelocations: firstDump.symbolsAndRelocations,
      secondSymbolsAndRelocationsSha256: crypto
        .createHash("sha256")
        .update(secondDump.symbolsAndRelocations, "utf8")
        .digest("hex"),
      relocationSemanticsSha256: crypto.createHash("sha256").update(firstRelocationSemantics, "utf8").digest("hex"),
      relocationSemantics: firstRelocationSemantics,
      testOnlyResidueRemoved: name === "protectedArtifactSigning" ? true : undefined,
      requiredEd25519Bridges:
        name === "protectedArtifactSigning" ? protectedArtifactSigningRequiredBridgeSymbols : undefined,
      directMonocypherCallsRemoved: name === "protectedArtifactSigning" ? true : undefined,
    });
  }

  if (firstCompiler.normalizedLog !== secondCompiler.normalizedLog) {
    throw new Error(`The two clean ${target} W1B0 compiler command logs differ after path normalization.`);
  }
  const firstMap = normalizeLinkMapIcfConstantOwners(
    normalizeGeneratedEvidence(fs.readFileSync(first.linkMapPath, "utf8"), first, toolchain),
  );
  const secondMap = normalizeLinkMapIcfConstantOwners(
    normalizeGeneratedEvidence(fs.readFileSync(second.linkMapPath, "utf8"), second, toolchain),
  );
  if (firstMap !== secondMap) {
    throw new Error(
      `The two clean ${target} W1B0 production link maps differ after path normalization. ${firstTextDifference(firstMap, secondMap)}`,
    );
  }
  const forbiddenSymbols = Object.freeze([
    "crypto_ed25519_sign",
    "crypto_ed25519_ph_sign",
    "crypto_ed25519_ph_check",
    "crypto_x25519",
    "crypto_x25519_public_key",
    "crypto_x25519_to_eddsa",
    "crypto_x25519_inverse",
    "crypto_x25519_dirty_small",
    "crypto_x25519_dirty_fast",
    "crypto_eddsa_key_pair",
    "crypto_eddsa_sign",
    "crypto_eddsa_check",
    "crypto_eddsa_to_x25519",
    "SetEd25519WipeObserverForTest",
    "SetEd25519FailurePointForTest",
    "ResetEd25519TestState",
    "RunEd25519VectorForTest",
    "ParseCanonicalPkcs8ForTest",
    "RunFixedInteropForTest",
    "WasLastSha512ContextWipedForTest",
  ]);
  for (const forbidden of forbiddenSymbols) {
    if (mapContainsNamedSymbol(firstMap, forbidden) || mapContainsNamedSymbol(secondMap, forbidden)) {
      throw new Error(
        `The ${target} production link map retained forbidden W1B0 symbol ${forbidden}. ` +
          mapSymbolContext(firstMap, forbidden),
      );
    }
  }
  if (/(?:Ed25519[^\r\n]*Verify|Verify[^\r\n]*Ed25519)/u.test(firstMap)) {
    throw new Error(`The ${target} production link map retained a forbidden first-party generic Ed25519 verifier.`);
  }
  const requiredProductionSigningSymbols = Object.freeze([
    "CreateProtectedSigningLease",
    "SignProtectedArtifact",
    "ExpandEd25519SeedForProtectedSigning",
    "ReduceEd25519ScalarForProtectedSigning",
    "Ed25519ScalarBaseForProtectedSigning",
    "Ed25519MulAddForProtectedSigning",
    "CheckEd25519EquationForProtectedSigning",
  ]);
  for (const required of requiredProductionSigningSymbols) {
    if (!mapContainsNamedSymbol(firstMap, required) || !mapContainsNamedSymbol(secondMap, required)) {
      throw new Error(
        `The ${target} production link map lost required protected signing symbol ${required}. ` +
          mapSymbolContext(firstMap, required),
      );
    }
  }
  const requiredProductionSigningTypes = Object.freeze(["ProtectedArtifactAuthority", "ProtectedSigningLease"]);
  for (const requiredType of requiredProductionSigningTypes) {
    if (!firstMap.includes(requiredType) || !secondMap.includes(requiredType)) {
      throw new Error(`The ${target} production link map lost required protected signing type ${requiredType}.`);
    }
  }
  if (
    !mapContainsNamedSymbol(firstMap, "crypto_ed25519_check") ||
    !mapContainsNamedSymbol(secondMap, "crypto_ed25519_check")
  ) {
    throw new Error(`The ${target} production link map lost the fixed internal crypto_ed25519_check path.`);
  }
  for (const objectName of [
    "monocypher-core.obj",
    "monocypher-ed25519.obj",
    "ed25519-runtime.obj",
    "protected-operations.obj",
  ]) {
    if (!firstMap.toLowerCase().includes(objectName.toLowerCase())) {
      throw new Error(`The ${target} production link map does not correlate ${objectName} to the final service PE.`);
    }
  }
  const checkCallgraph = inspectAdapterCheckCallgraph(
    objects.adapter.disassembly,
    objects.adapter.symbolsAndRelocations,
    target,
  );
  const protectedArtifactSigningCallgraph = inspectProtectedArtifactSigningCallgraph(
    objects.protectedArtifactSigning.disassembly,
    objects.protectedArtifactSigning.symbolsAndRelocations,
    target,
  );
  const protectedEd25519BridgeCallgraph = inspectProtectedEd25519BridgeCallgraph(
    objects.adapter.disassembly,
    objects.adapter.symbolsAndRelocations,
    target,
  );
  const firstPeBytes = fs.readFileSync(first.binaryPath);
  const secondPeBytes = fs.readFileSync(second.binaryPath);
  if (!firstPeBytes.equals(secondPeBytes)) {
    throw new Error(`The two clean ${target} service PEs changed during W1B0 evidence correlation.`);
  }
  const evidenceDomainPrefix = Buffer.from("goatcitadel.remote-worker.provisioning-evidence.signature.v1\0", "utf8");
  if (evidenceDomainPrefix.length !== 61) {
    throw new Error("The fixed W1B1B-P0 evidence domain prefix contract changed.");
  }
  if (!firstPeBytes.includes(evidenceDomainPrefix) || !secondPeBytes.includes(evidenceDomainPrefix)) {
    throw new Error(`The ${target} production service PE lost the fixed admission-evidence signing domain.`);
  }
  const firstLinkedDisassembly = runPinnedDumpbin(
    dumpbinPath,
    ["/nologo", "/disasm", path.basename(first.binaryPath)],
    first.binaryPath,
    `${target} final service disassembly A`,
  );
  const secondLinkedDisassembly = runPinnedDumpbin(
    dumpbinPath,
    ["/nologo", "/disasm", path.basename(second.binaryPath)],
    second.binaryPath,
    `${target} final service disassembly B`,
  );
  if (firstLinkedDisassembly !== secondLinkedDisassembly) {
    throw new Error(`The two clean ${target} final service disassemblies differ.`);
  }
  const linkedCheckCallgraph = inspectLinkedCheckCallgraph(firstMap, firstLinkedDisassembly, target);

  return Object.freeze({
    target,
    msvcVersion: REMOTE_WORKER_WINDOWS_MSVC_VERSION,
    windowsSdkVersion: REMOTE_WORKER_WINDOWS_SDK_VERSION,
    compiler: Object.freeze({
      logSha256: crypto.createHash("sha256").update(firstCompiler.normalizedLog, "utf8").digest("hex"),
      normalizedLog: firstCompiler.normalizedLog,
      vendorCRequiredFlags: Object.freeze(["/TC", "/O2", "/Ob0", "/GL-", "/Gy", "/volatile:iso"]),
      adapterRequiredFlags: Object.freeze(["/O2", "/Ob0", "/GL-", "/Gy", "/volatile:iso"]),
      protectedArtifactSigningRequiredFlags: Object.freeze([
        "/O2",
        "/Ob0",
        "/GL-",
        "/Gy",
        "/Gw",
        "/volatile:iso",
        "/EHs-c-",
        "/GR-",
      ]),
    }),
    objects: Object.freeze(objects),
    protectedArtifactSigningCallgraph,
    protectedEd25519BridgeCallgraph,
    linkMap: Object.freeze({
      sha256: crypto.createHash("sha256").update(firstMap, "utf8").digest("hex"),
      normalizedMap: firstMap,
      servicePeBytes: firstPeBytes.length,
      servicePeSha256: crypto.createHash("sha256").update(firstPeBytes).digest("hex"),
      objectBasenames: Object.freeze([
        "monocypher-core.obj",
        "monocypher-ed25519.obj",
        "ed25519-runtime.obj",
        "protected-artifact-signing.obj",
      ]),
      cryptoEd25519CheckRetained: true,
      cryptoEd25519CheckCallgraph: checkCallgraph,
      linkedDisassemblySha256: crypto.createHash("sha256").update(firstLinkedDisassembly, "utf8").digest("hex"),
      linkedCryptoEd25519CheckCallgraph: linkedCheckCallgraph,
      forbiddenSymbolsRemoved: true,
      forbiddenSymbols,
      productionSigningSymbolsRetained: true,
      productionSigningSymbols: requiredProductionSigningSymbols,
      productionSigningTypesRetained: true,
      productionSigningTypes: requiredProductionSigningTypes,
      productionSigningDomainDataRetained: true,
      productionObjectTestOnlyResidueRemoved: true,
      productionObjectForbiddenResidue: protectedArtifactSigningForbiddenObjectResidue,
    }),
  });
}

const ed25519CallgraphTargetContracts = Object.freeze({
  "windows-x64": Object.freeze({ mnemonic: "call", relocation: "REL32" }),
  "windows-arm64": Object.freeze({ mnemonic: "bl", relocation: "BRANCH26" }),
});

const expectedEd25519CheckCallers = Object.freeze([
  Object.freeze({
    name: "PureEd25519Sign",
    symbol:
      "?PureEd25519Sign@?A0xfa045e67@remote_worker_provisioner@goatcitadel@@YA_NPEAV?$array@E$0EA@@std@@AEBV45@PEBE_K@Z",
    header:
      "?PureEd25519Sign@?A0xfa045e67@remote_worker_provisioner@goatcitadel@@YA_NPEAV?$array@E$0EA@@std@@AEBV45@PEBE_K@Z (bool __cdecl goatcitadel::remote_worker_provisioner::`anonymous namespace'::PureEd25519Sign(class std::array<unsigned char,64> *,class std::array<unsigned char,64> const &,unsigned char const *,unsigned __int64)):",
  }),
  Object.freeze({
    name: "RunKnownAnswerSelfTest",
    symbol: "?RunKnownAnswerSelfTest@remote_worker_provisioner@goatcitadel@@YA_NXZ",
    header:
      "?RunKnownAnswerSelfTest@remote_worker_provisioner@goatcitadel@@YA_NXZ (bool __cdecl goatcitadel::remote_worker_provisioner::RunKnownAnswerSelfTest(void)):",
  }),
]);

export function inspectAdapterCheckCallgraph(disassembly, symbolsAndRelocations, target) {
  if (typeof disassembly !== "string" || typeof symbolsAndRelocations !== "string") {
    throw new TypeError("The W1B0 adapter callgraph evidence must be text.");
  }
  const targetContract = ed25519CallgraphTargetContracts[target];
  if (targetContract === undefined) {
    throw new Error(`No W1B0 adapter callgraph contract exists for ${target}.`);
  }
  const functions = parseTopLevelDisassemblyFunctions(disassembly);
  const genericCallExpression = /\b(?:call|bl)\s+crypto_ed25519_check(?:\s|$)/giu;
  const targetCallExpression = new RegExp(`\\b${targetContract.mnemonic}\\s+crypto_ed25519_check(?:\\s|$)`, "giu");
  const genericCallCount = [...disassembly.matchAll(genericCallExpression)].length;
  const globalCallCount = [...disassembly.matchAll(targetCallExpression)].length;
  const callers = [];
  for (const entry of functions) {
    const calls = [...entry.text.matchAll(targetCallExpression)].length;
    if (calls > 0) callers.push(Object.freeze({ header: entry.header, calls, disassembly: entry.text }));
  }
  const classified = callers.map((caller) => {
    const symbol = /^([^\s]+)\s/u.exec(caller.header)?.[1] ?? "";
    return {
      caller,
      symbol,
      owner: expectedEd25519CheckCallers.find(
        (candidate) => candidate.symbol === symbol && candidate.header === caller.header,
      ),
    };
  });
  const partitionedCallCount = callers.reduce((total, caller) => total + caller.calls, 0);
  const referenceLines = symbolsAndRelocations
    .split(/\r?\n/u)
    .filter((line) => /\bcrypto_ed25519_check\s*$/u.test(line));
  const relocationExpression = new RegExp(
    `^\\s*[0-9a-f]{8}\\s+${targetContract.relocation}\\s+[0-9a-f]{8}\\s+[0-9a-f]+\\s+crypto_ed25519_check\\s*$`,
    "iu",
  );
  const declarationExpression =
    /^\s*[0-9a-f]+\s+[0-9a-f]{8}\s+UNDEF\s+notype\s+\(\)\s+External\s+\|\s+crypto_ed25519_check\s*$/iu;
  const relocationLines = referenceLines.filter((line) => relocationExpression.test(line));
  const declarationLines = referenceLines.filter((line) => declarationExpression.test(line));
  if (
    genericCallCount !== 2 ||
    globalCallCount !== 2 ||
    partitionedCallCount !== globalCallCount ||
    callers.length !== expectedEd25519CheckCallers.length ||
    callers.some((caller) => caller.calls !== 1) ||
    classified.some((entry) => entry.owner === undefined) ||
    new Set(classified.map((entry) => entry.owner?.name)).size !== expectedEd25519CheckCallers.length ||
    relocationLines.length !== 2 ||
    declarationLines.length !== 1 ||
    referenceLines.length !== relocationLines.length + declarationLines.length
  ) {
    throw new Error(
      `The ${target} adapter crypto_ed25519_check callgraph is not exactly the fixed post-sign/KAT pair: ` +
        `generic=${genericCallCount};target=${globalCallCount};partitioned=${partitionedCallCount};` +
        `relocations=${relocationLines.length};references=${referenceLines.length};` +
        callers.map((caller) => `${caller.header}=${caller.calls}`).join(";"),
    );
  }
  return Object.freeze({
    callCount: globalCallCount,
    mnemonic: targetContract.mnemonic,
    relocation: targetContract.relocation,
    relocationCount: relocationLines.length,
    addressTaken: false,
    callers: Object.freeze(
      classified.map(({ caller, owner, symbol }) =>
        Object.freeze({
          name: owner.name,
          symbol,
          header: caller.header,
          calls: caller.calls,
          disassemblySha256: crypto.createHash("sha256").update(caller.disassembly, "utf8").digest("hex"),
          disassembly: caller.disassembly,
        }),
      ),
    ),
  });
}

const protectedArtifactSigningCalls = Object.freeze([
  Object.freeze({ target: "ExpandEd25519SeedForProtectedSigning", count: 1 }),
  Object.freeze({ target: "ReduceEd25519ScalarForProtectedSigning", count: 3 }),
  Object.freeze({ target: "Ed25519ScalarBaseForProtectedSigning", count: 1 }),
  Object.freeze({ target: "Ed25519MulAddForProtectedSigning", count: 1 }),
  Object.freeze({ target: "CheckEd25519EquationForProtectedSigning", count: 1 }),
]);

const protectedEd25519BridgeOwners = Object.freeze([
  Object.freeze({
    owner: "ExpandEd25519SeedForProtectedSigning",
    calls: Object.freeze([
      Object.freeze({ target: "crypto_sha512", count: 1 }),
      Object.freeze({ target: "crypto_eddsa_trim_scalar", count: 1 }),
      Object.freeze({ target: "crypto_eddsa_scalarbase", count: 1 }),
    ]),
  }),
  Object.freeze({
    owner: "ReduceEd25519ScalarForProtectedSigning",
    calls: Object.freeze([Object.freeze({ target: "crypto_eddsa_reduce", count: 1 })]),
  }),
  Object.freeze({
    owner: "Ed25519ScalarBaseForProtectedSigning",
    calls: Object.freeze([Object.freeze({ target: "crypto_eddsa_scalarbase", count: 1 })]),
  }),
  Object.freeze({
    owner: "Ed25519MulAddForProtectedSigning",
    calls: Object.freeze([Object.freeze({ target: "crypto_eddsa_mul_add", count: 1 })]),
  }),
  Object.freeze({
    owner: "CheckEd25519EquationForProtectedSigning",
    calls: Object.freeze([Object.freeze({ target: "crypto_eddsa_check_equation", count: 1 })]),
  }),
]);

const protectedEd25519PrimitiveTotals = Object.freeze([
  Object.freeze({ target: "crypto_sha512", count: 2 }),
  Object.freeze({ target: "crypto_eddsa_trim_scalar", count: 2 }),
  Object.freeze({ target: "crypto_eddsa_scalarbase", count: 3 }),
  Object.freeze({ target: "crypto_eddsa_reduce", count: 2 }),
  Object.freeze({ target: "crypto_eddsa_mul_add", count: 2 }),
  Object.freeze({ target: "crypto_eddsa_check_equation", count: 1 }),
]);

export function inspectProtectedArtifactSigningCallgraph(disassembly, symbolsAndRelocations, target) {
  const result = inspectExactObjectCallgraph({
    description: "W1B1B-P0 protected-artifact signing",
    disassembly,
    symbolsAndRelocations,
    target,
    owners: Object.freeze([Object.freeze({ owner: "SignProtectedArtifact", calls: protectedArtifactSigningCalls })]),
    exactObjectTotals: protectedArtifactSigningCalls,
  });
  return Object.freeze({
    ...result,
    passkeyOwner: "SignProtectedArtifact",
    passkeyType: "ProtectedEd25519SigningBridgeKey",
  });
}

export function inspectProtectedEd25519BridgeCallgraph(disassembly, symbolsAndRelocations, target) {
  return inspectExactObjectCallgraph({
    description: "W1B1B-P0 protected Ed25519 bridge",
    disassembly,
    symbolsAndRelocations,
    target,
    owners: protectedEd25519BridgeOwners,
    exactObjectTotals: protectedEd25519PrimitiveTotals,
  });
}

function inspectExactObjectCallgraph({
  description,
  disassembly,
  symbolsAndRelocations,
  target,
  owners,
  exactObjectTotals,
}) {
  if (typeof disassembly !== "string" || typeof symbolsAndRelocations !== "string") {
    throw new TypeError(`The ${description} callgraph evidence must be text.`);
  }
  if (
    Buffer.byteLength(disassembly, "utf8") > 8 * 1024 * 1024 ||
    Buffer.byteLength(symbolsAndRelocations, "utf8") > 8 * 1024 * 1024
  ) {
    throw new Error(`The ${description} callgraph evidence exceeded its 8 MiB bound.`);
  }
  const targetContract = ed25519CallgraphTargetContracts[target];
  if (targetContract === undefined) {
    throw new Error(`No ${description} callgraph contract exists for ${target}.`);
  }
  const directMnemonics = target === "windows-x64" ? ["call", "jmp"] : ["bl", "b"];
  const functions = parseTopLevelDisassemblyFunctions(disassembly);
  const inspectedOwners = owners.map((owner) => {
    const matches = functions.filter(
      (entry) => entry.header.includes(`?${owner.owner}@`) || entry.header.includes(`::${owner.owner}(`),
    );
    if (matches.length !== 1) {
      throw new Error(`The ${target} ${description} object does not retain one exact ${owner.owner} body.`);
    }
    const body = matches[0];
    const calls = owner.calls.map((expected) => {
      const lines = body.text.split(/\r?\n/u).filter((line) => {
        if (!line.includes(expected.target)) return false;
        return directMnemonics.some((mnemonic) => new RegExp(`\\b${mnemonic}\\b`, "iu").test(line));
      });
      if (lines.length !== expected.count) {
        throw new Error(
          `The ${target} ${description} ${owner.owner} -> ${expected.target} count is ${lines.length}, expected ${expected.count}.`,
        );
      }
      return Object.freeze({ target: expected.target, count: lines.length, lines: Object.freeze(lines) });
    });
    return Object.freeze({
      owner: owner.owner,
      header: body.header,
      disassemblySha256: crypto.createHash("sha256").update(body.text, "utf8").digest("hex"),
      calls: Object.freeze(calls),
    });
  });

  const relocationEvidence = exactObjectTotals.map((expected) => {
    const exactCNameExpression = expected.target.startsWith("crypto_")
      ? new RegExp(`${escapeRegularExpression(expected.target)}\\s*$`, "u")
      : null;
    const references = symbolsAndRelocations
      .split(/\r?\n/u)
      .filter((line) =>
        exactCNameExpression === null ? line.includes(expected.target) : exactCNameExpression.test(line),
      );
    const relocations = references.filter((line) => new RegExp(`\\b${targetContract.relocation}\\b`, "iu").test(line));
    const declarations = references.filter((line) => /\bUNDEF\b/iu.test(line) && /\bExternal\b/iu.test(line));
    if (
      relocations.length !== expected.count ||
      declarations.length !== 1 ||
      references.length !== relocations.length + declarations.length
    ) {
      throw new Error(
        `The ${target} ${description} ${expected.target} relocation graph is not exact: ` +
          `relocations=${relocations.length};declarations=${declarations.length};references=${references.length}.`,
      );
    }
    return Object.freeze({
      target: expected.target,
      relocation: targetContract.relocation,
      relocationCount: relocations.length,
      declarationCount: declarations.length,
      addressTaken: false,
    });
  });
  return Object.freeze({
    target,
    directMnemonics: Object.freeze(directMnemonics),
    owners: Object.freeze(inspectedOwners),
    relocations: Object.freeze(relocationEvidence),
    addressTaken: false,
  });
}

export function inspectLinkedCheckCallgraph(linkMap, disassembly, target) {
  if (typeof linkMap !== "string" || typeof disassembly !== "string") {
    throw new TypeError("The W1B0 linked callgraph evidence must be text.");
  }
  const targetContract = ed25519CallgraphTargetContracts[target];
  if (targetContract === undefined) {
    throw new Error(`No W1B0 linked callgraph contract exists for ${target}.`);
  }
  if (Buffer.byteLength(disassembly, "utf8") > 8 * 1024 * 1024) {
    throw new Error(`The ${target} final service disassembly exceeded its 8 MiB evidence bound.`);
  }

  const mapFunctions = linkMap
    .split(/\r?\n/u)
    .map((line) => {
      const match = /^\s*0001:[0-9a-f]{8}\s+(\S+)\s+([0-9a-f]{16})\s+f\s+(\S+)\s*$/iu.exec(line);
      return match === null
        ? undefined
        : Object.freeze({
            symbol: match[1],
            address: BigInt(`0x${match[2]}`),
            addressHex: match[2].toUpperCase(),
            object: match[3],
            line,
          });
    })
    .filter((entry) => entry !== undefined);
  const exactMapFunction = (symbol, object) => {
    const matches = mapFunctions.filter((entry) => entry.symbol === symbol);
    if (matches.length !== 1 || matches[0].object.toLowerCase() !== object.toLowerCase()) {
      throw new Error(
        `The ${target} final link map does not retain one exact ${symbol} owner in ${object}: ` +
          matches.map((entry) => `${entry.object}@${entry.addressHex}`).join(";"),
      );
    }
    return matches[0];
  };
  const check = exactMapFunction("crypto_ed25519_check", "monocypher-ed25519.obj");
  const expectedFunctions = expectedEd25519CheckCallers.map((owner) => ({
    owner,
    map: exactMapFunction(owner.symbol, "ed25519-runtime.obj"),
  }));
  const strictlyGreaterAddresses = (start) =>
    mapFunctions.map((entry) => entry.address).filter((address) => address > start);
  const boundedFunctions = expectedFunctions.map(({ owner, map }) => {
    const greater = strictlyGreaterAddresses(map.address);
    if (greater.length === 0) {
      throw new Error(`The ${target} final map cannot bound ${owner.name}.`);
    }
    const end = greater.reduce((smallest, current) => (current < smallest ? current : smallest));
    if (end - map.address > 64n * 1024n) {
      throw new Error(`The ${target} final ${owner.name} body exceeded its 64 KiB address bound.`);
    }
    return { owner, map, end };
  });

  const lines = disassembly.split(/\r?\n/u);
  const instructionAddress = (line) => {
    const match = /^\s*([0-9a-f]{16}):/iu.exec(line);
    return match === null ? undefined : BigInt(`0x${match[1]}`);
  };
  const callExpression =
    target === "windows-x64"
      ? /^\s*([0-9a-f]{16}):\s+(?:[0-9a-f]{2}\s+)+call\s+([0-9a-f]{16})\s*$/iu
      : /^\s*([0-9a-f]{16}):\s+[0-9a-f]{8}\s+bl\s+([0-9a-f]{16})\s*$/iu;
  const directCalls = lines
    .map((line) => {
      const match = callExpression.exec(line);
      return match === null
        ? undefined
        : Object.freeze({
            address: BigInt(`0x${match[1]}`),
            addressHex: match[1].toUpperCase(),
            target: BigInt(`0x${match[2]}`),
            targetHex: match[2].toUpperCase(),
            line,
          });
    })
    .filter((entry) => entry !== undefined && entry.target === check.address);
  const referenceLines = lines.filter((line) => line.toUpperCase().includes(check.addressHex));
  const definitionLines = referenceLines.filter((line) => {
    const address = instructionAddress(line);
    return address === check.address;
  });
  const callers = boundedFunctions.map(({ owner, map, end }) => {
    const calls = directCalls.filter((call) => call.address >= map.address && call.address < end);
    const body = lines
      .filter((line) => {
        const address = instructionAddress(line);
        return address !== undefined && address >= map.address && address < end;
      })
      .join("\n");
    if (calls.length !== 1 || body.length === 0 || Buffer.byteLength(body, "utf8") > 512 * 1024) {
      throw new Error(
        `The ${target} final linked ${owner.name} body does not contain one bounded crypto_ed25519_check call.`,
      );
    }
    return Object.freeze({
      name: owner.name,
      symbol: owner.symbol,
      mapLine: map.line,
      startAddress: map.addressHex,
      endAddress: end.toString(16).toUpperCase().padStart(16, "0"),
      callAddress: calls[0].addressHex,
      disassemblySha256: crypto.createHash("sha256").update(body, "utf8").digest("hex"),
      disassembly: body,
    });
  });
  if (
    directCalls.length !== 2 ||
    referenceLines.length !== 3 ||
    definitionLines.length !== 1 ||
    new Set(callers.map((caller) => caller.callAddress)).size !== directCalls.length
  ) {
    throw new Error(
      `The ${target} final service does not retain exactly two direct crypto_ed25519_check calls in the fixed owners: ` +
        `calls=${directCalls.length};references=${referenceLines.length};definitions=${definitionLines.length}.`,
    );
  }
  return Object.freeze({
    callCount: directCalls.length,
    mnemonic: targetContract.mnemonic,
    targetAddress: check.addressHex,
    targetMapLine: check.line,
    addressTaken: false,
    callers: Object.freeze(callers),
  });
}

function parseTopLevelDisassemblyFunctions(disassembly) {
  const lines = disassembly.split("\n");
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\?[^\s]+\s+\(.+\):\s*$/u.test(lines[index]) || /^[A-Za-z_][A-Za-z0-9_@$?]*:\s*$/u.test(lines[index])) {
      starts.push(index);
    }
  }
  const functions = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1] ?? lines.length;
    const text = lines.slice(start, end).join("\n");
    if (Buffer.byteLength(text, "utf8") > 512 * 1024) {
      throw new Error(`A W1B0 function disassembly exceeded its 512 KiB evidence bound: ${lines[start]}`);
    }
    functions.push(Object.freeze({ header: lines[start], text }));
  }
  return functions;
}

function firstTextDifference(first, second) {
  const left = first.split(/\r?\n/u);
  const right = second.split(/\r?\n/u);
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    if (left[index] !== right[index]) {
      return `line ${index + 1}: A=${JSON.stringify(left[index] ?? "<missing>")} B=${JSON.stringify(right[index] ?? "<missing>")}`;
    }
  }
  return "unknown difference";
}

function mapSymbolContext(map, symbol) {
  const lines = map.split("\n");
  const index = lines.findIndex((line) => mapLineContainsNamedSymbol(line, symbol));
  if (index < 0) return "No bounded map context was found.";
  return lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 2)).join(" | ");
}

export function normalizeDumpbinRelocationSemantics(value) {
  if (typeof value !== "string") {
    throw new TypeError("The W1B0 symbols/relocations evidence must be a string.");
  }
  return value
    .replace(/\b[0-9A-F]{4,16}\b/giu, "<HEX>")
    .replace(/(Section length)[ \t]+(?:<HEX>|[0-9A-F]+)/giu, "$1 <HEX>")
    .replace(/(checksum)[ \t]+<HEX>/giu, "$1 <HEX>");
}

function firstEvidenceDifference(first, second) {
  for (const key of ["disassembly", "symbolsAndRelocations"]) {
    const left = first[key].split(/\r?\n/u);
    const right = second[key].split(/\r?\n/u);
    const count = Math.max(left.length, right.length);
    for (let index = 0; index < count; index += 1) {
      if (left[index] !== right[index]) {
        return `${key} line ${index + 1}: A=${JSON.stringify(left[index] ?? "<missing>")} B=${JSON.stringify(right[index] ?? "<missing>")}`;
      }
    }
  }
  return "unknown difference";
}

function mapContainsNamedSymbol(map, symbol) {
  return map.split("\n").some((line) => mapLineContainsNamedSymbol(line, symbol));
}

function mapLineContainsNamedSymbol(line, symbol) {
  const match = /^\s+[0-9A-F]{4}:[0-9A-F]{8}\s+(\S+)/iu.exec(line);
  if (match === null) return false;
  const token = match[1];
  return token === symbol || token === `_${symbol}` || token.startsWith(`?${symbol}@`);
}

function inspectCompilerCommandEvidence(build, requirements, toolchain) {
  const raw = decodeMsbuildText(fs.readFileSync(build.compileCommandLogPath));
  const normalizedLog = normalizeGeneratedEvidence(raw, build, toolchain);
  const commands = {};
  for (const [name, requirement] of Object.entries(requirements)) {
    const command = extractCompilerCommand(normalizedLog, requirement.source, requirement.object);
    assertEffectiveCompilerOptions(command, name, requirement.language, requirement.requiredOptions ?? []);
    commands[name] = command;
  }
  return Object.freeze({ normalizedLog, commands: Object.freeze(commands) });
}

function assertEffectiveCompilerOptions(command, name, language, requiredOptions) {
  const categories = Object.freeze([
    Object.freeze({ label: "optimization", expression: /(?:^|\s)(\/O(?:1|2|d|x))(?=\s|$)/giu, expected: "/o2" }),
    Object.freeze({ label: "inline", expression: /(?:^|\s)(\/Ob[0-3])(?=\s|$)/giu, expected: "/ob0" }),
    Object.freeze({ label: "whole-program", expression: /(?:^|\s)(\/GL-?)(?=\s|$)/giu, expected: "/gl-" }),
    Object.freeze({ label: "function-linking", expression: /(?:^|\s)(\/Gy-?)(?=\s|$)/giu, expected: "/gy" }),
    Object.freeze({
      label: "volatile",
      expression: /(?:^|\s)(\/volatile:(?:iso|ms))(?=\s|$)/giu,
      expected: "/volatile:iso",
    }),
  ]);
  for (const category of categories) {
    const values = [...command.matchAll(category.expression)].map((match) => match[1].toLowerCase());
    if (values.length === 0 || values.at(-1) !== category.expected) {
      throw new Error(
        `The measured ${name} compiler command has invalid effective ${category.label} options: ${values.join(",")}.`,
      );
    }
  }
  const languages = [...command.matchAll(/(?:^|\s)(\/T[CP])(?=\s|$)/giu)].map((match) => match[1].toLowerCase());
  if (language === "c") {
    if (languages.length === 0 || languages.at(-1) !== "/tc") {
      throw new Error(`The measured ${name} compiler command does not end with effective /TC C compilation.`);
    }
  } else if (languages.includes("/tc")) {
    throw new Error("The measured adapter compiler command contains forbidden /TC C compilation.");
  }
  const lowercaseCommand = command.toLowerCase();
  for (const option of requiredOptions) {
    if (!lowercaseCommand.includes(option.toLowerCase())) {
      throw new Error(`The measured ${name} compiler command is missing required ${option}.`);
    }
  }
}

function decodeMsbuildText(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString("utf16le");
  }
  const oddZeroes = [...bytes.subarray(1, Math.min(bytes.length, 512))].filter(
    (value, index) => index % 2 === 0 && value === 0,
  ).length;
  return oddZeroes > 32 ? bytes.toString("utf16le") : bytes.toString("utf8");
}

function extractCompilerCommand(log, sourceBasename, objectBasename) {
  const lines = log.split(/\r?\n/u);
  const source = sourceBasename.toLowerCase();
  const object = objectBasename.toLowerCase();
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].toLowerCase().includes(source)) continue;
    let start = index;
    while (start > 0 && !lines[start].startsWith("^")) start -= 1;
    let end = index + 1;
    while (end < lines.length && !lines[end].startsWith("^")) end += 1;
    const block = lines.slice(start, end).join("\n");
    if (block.toLowerCase().includes(object) && /\/O2/iu.test(block)) return block;
  }
  throw new Error(`The pinned compiler command log lacks a bounded command for ${sourceBasename}.`);
}

function normalizeGeneratedEvidence(value, build, toolchain) {
  let normalized = value.replaceAll("\r\n", "\n");
  const replacements = [
    [build.buildRoot, "/_/goatcitadel/w1b0-build"],
    [path.dirname(path.dirname(build.buildRoot)), "/_/goatcitadel/w1b0-proof-root"],
    [repoRoot, "/_/goatcitadel/repo"],
    [toolchain.vcToolsRoot, `/_/goatcitadel/msvc-${REMOTE_WORKER_WINDOWS_MSVC_VERSION}`],
    [toolchain.vcTargetsRoot, "/_/goatcitadel/msbuild-vc-targets"],
    [toolchain.sdkRoot, `/_/goatcitadel/windows-sdk-${REMOTE_WORKER_WINDOWS_SDK_VERSION}`],
    [path.dirname(toolchain.msbuildPath), "/_/goatcitadel/msbuild-bin"],
    [process.env.SystemRoot, "/_/goatcitadel/windows"],
    [os.tmpdir(), "/_/goatcitadel/tmp"],
    [os.homedir(), "/_/goatcitadel/home"],
  ].filter(([source]) => typeof source === "string" && source.length > 0);
  for (const [source, replacement] of replacements) {
    for (const variant of [source, source.replaceAll("\\", "/")]) {
      normalized = normalized.replace(new RegExp(escapeRegularExpression(variant), "giu"), replacement);
    }
  }
  if (normalized.includes("goatcitadel-rw-provisioner-proof-")) {
    throw new Error("W1B0 generated evidence retained its random proof-root token.");
  }
  const absolutePath = /(?:^|[\s="'(])([A-Za-z]:[\\/][^\r\n"]{0,260})/u.exec(normalized);
  if (absolutePath !== null) {
    throw new Error(`W1B0 generated evidence retained an ephemeral absolute Windows path: ${absolutePath[1]}`);
  }
  return normalized;
}

export function normalizeLinkMapIcfConstantOwners(value) {
  if (typeof value !== "string") {
    throw new TypeError("The W1B0 link map must be a string.");
  }
  return value.replace(
    /^(\s*[0-9a-f]{4}:[0-9a-f]{8}\s+__(?:real|xmm|ymm|zmm)@[0-9a-f]+\s+[0-9a-f]{16}\s+)[^\s]+\.obj\s*$/gimu,
    "$1<ICF-MERGED-CONSTANT-OWNER>",
  );
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function runPinnedDumpbinEvidence(dumpbinPath, objectPath, description) {
  const disassembly = runPinnedDumpbin(
    dumpbinPath,
    ["/nologo", "/disasm", path.basename(objectPath)],
    objectPath,
    `${description} disassembly`,
  );
  const symbolsAndRelocations = runPinnedDumpbin(
    dumpbinPath,
    ["/nologo", "/symbols", "/relocations", path.basename(objectPath)],
    objectPath,
    `${description} symbols/relocations`,
  );
  return Object.freeze({ disassembly, symbolsAndRelocations });
}

function runPinnedRecoveryDumpbinEvidence(dumpbinPath, objectPath, description) {
  const disassembly = runPinnedDumpbin(
    dumpbinPath,
    ["/nologo", "/disasm", path.basename(objectPath)],
    objectPath,
    `${description} disassembly`,
  );
  const symbolsAndRelocations = runPinnedDumpbin(
    dumpbinPath,
    ["/nologo", "/symbols", path.basename(objectPath)],
    objectPath,
    `${description} symbols`,
  );
  return Object.freeze({ disassembly, symbolsAndRelocations });
}

function runPinnedDumpbin(dumpbinPath, arguments_, objectPath, description) {
  const result = spawnSync(dumpbinPath, arguments_, {
    cwd: path.dirname(objectPath),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.stderr !== "" || result.stdout.length === 0) {
    throw new Error(
      `Pinned dumpbin failed for W1B0 ${description} (${String(result.status)}).\n${boundedBuildOutput(result.stdout)}\n${boundedBuildOutput(result.stderr)}`,
    );
  }
  let evidence = result.stdout.replaceAll("\r\n", "\n");
  const summaryOffset = evidence.search(/\n\s+Summary\s*\n/u);
  if (summaryOffset >= 0) evidence = `${evidence.slice(0, summaryOffset)}\n`;
  if (Buffer.byteLength(evidence, "utf8") > 8 * 1024 * 1024) {
    throw new Error(`Pinned W1B0 ${description} exceeded the 8 MiB evidence bound.`);
  }
  if (/[A-Za-z]:[\\/]/u.test(evidence)) {
    throw new Error(`Pinned W1B0 ${description} retained an absolute path.`);
  }
  return evidence;
}

function readPeNamedImports(bytes, description) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 512 || bytes.length > 16 * 1024 * 1024) {
    throw new Error(`The ${description} PE size is outside the bounded proof range.`);
  }
  if (bytes.readUInt16LE(0) !== 0x5a4d) {
    throw new Error(`The ${description} output is not a Windows PE.`);
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  requireRange(bytes, peOffset, 24, `${description} PE header`);
  if (bytes.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error(`The ${description} PE signature is invalid.`);
  }
  const coffOffset = peOffset + 4;
  const sectionCount = bytes.readUInt16LE(coffOffset + 2);
  const optionalSize = bytes.readUInt16LE(coffOffset + 16);
  const optionalOffset = coffOffset + 20;
  if (sectionCount === 0 || sectionCount > maximumSections) {
    throw new Error(`The ${description} PE section count is invalid.`);
  }
  requireRange(bytes, optionalOffset, optionalSize, `${description} optional header`);
  if (optionalSize < 112 + 2 * 8 || bytes.readUInt16LE(optionalOffset) !== 0x20b) {
    throw new Error(`The ${description} must be a PE32+ image with an import directory.`);
  }
  const sectionsOffset = optionalOffset + optionalSize;
  requireRange(bytes, sectionsOffset, sectionCount * 40, `${description} section table`);
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const sectionOffset = sectionsOffset + index * 40;
    sections.push({
      virtualSize: bytes.readUInt32LE(sectionOffset + 8),
      virtualAddress: bytes.readUInt32LE(sectionOffset + 12),
      rawSize: bytes.readUInt32LE(sectionOffset + 16),
      rawOffset: bytes.readUInt32LE(sectionOffset + 20),
    });
  }
  const sizeOfHeaders = bytes.readUInt32LE(optionalOffset + 60);
  const mapRva = (rva, size, part) =>
    mapRvaToOffset(bytes, sections, sizeOfHeaders, rva, size, `${description} ${part}`);
  const importRva = bytes.readUInt32LE(optionalOffset + 112 + 8);
  const importSize = bytes.readUInt32LE(optionalOffset + 116 + 8);
  if (importRva === 0 || importSize < 40 || importSize > 4096 || importSize % 20 !== 0) {
    throw new Error(`The ${description} import directory is invalid or unbounded.`);
  }
  const importOffset = mapRva(importRva, importSize, "import directory");
  const imports = [];
  let terminated = false;
  for (let index = 0; index < importSize / 20; index += 1) {
    const descriptorOffset = importOffset + index * 20;
    const fields = [0, 4, 8, 12, 16].map((offset) => bytes.readUInt32LE(descriptorOffset + offset));
    if (fields.every((value) => value === 0)) {
      terminated = true;
      break;
    }
    const [originalFirstThunk, , , nameRva] = fields;
    if (originalFirstThunk === 0 || nameRva === 0) {
      throw new Error(`The ${description} import descriptor is non-canonical.`);
    }
    const dll = readBoundedAsciiZ(bytes, mapRva(nameRva, 1, "import DLL name"), 128, "import DLL name");
    const functions = [];
    for (let functionIndex = 0; functionIndex <= maximumImportFunctions; functionIndex += 1) {
      if (functionIndex === maximumImportFunctions) {
        throw new Error(`The ${description} named-import table is not bounded.`);
      }
      const thunk = bytes.readBigUInt64LE(mapRva(originalFirstThunk + functionIndex * 8, 8, "import-name thunk"));
      if (thunk === 0n) {
        break;
      }
      if ((thunk & 0x8000000000000000n) !== 0n || thunk > 0xffffffffn) {
        throw new Error(`The ${description} must use only bounded named imports.`);
      }
      const hintNameOffset = mapRva(Number(thunk), 3, "import hint/name");
      functions.push(readBoundedAsciiZ(bytes, hintNameOffset + 2, 256, "import function name"));
    }
    imports.push(Object.freeze({ dll, functions: Object.freeze(functions) }));
  }
  if (!terminated) {
    throw new Error(`The ${description} import descriptor table is not terminated.`);
  }
  return Object.freeze(imports);
}

function runPinnedMsbuild({
  toolchain,
  buildRoot,
  projectPath: selectedProjectPath,
  expectedBinaryName,
  addressSanitizer,
  additionalProperties = [],
}) {
  const outDirectory = `${path.join(buildRoot, "out")}${path.sep}`;
  const objectDirectory = `${path.join(buildRoot, "obj")}${path.sep}`;
  fs.mkdirSync(outDirectory, { recursive: true });
  fs.mkdirSync(objectDirectory, { recursive: true });

  const properties = [
    ["Configuration", "Release"],
    ["Platform", toolchain.definition.msbuildPlatform],
    ["PlatformToolset", "v143"],
    ["VCToolsVersion", REMOTE_WORKER_WINDOWS_MSVC_VERSION],
    ["WindowsTargetPlatformVersion", REMOTE_WORKER_WINDOWS_SDK_VERSION],
    ["VCTargetsPath", `${toolchain.vcTargetsRoot}${path.sep}`],
    ["VCToolsInstallDir", `${toolchain.vcToolsRoot}${path.sep}`],
    ["CLToolPath", `${path.dirname(toolchain.compilerPath)}${path.sep}`],
    ["LinkToolPath", `${path.dirname(toolchain.linkerPath)}${path.sep}`],
    ["WindowsSdkDir", `${toolchain.sdkRoot}${path.sep}`],
    ["UniversalCRTSdkDir", `${toolchain.sdkRoot}${path.sep}`],
    ["WindowsSDKVersion", `${REMOTE_WORKER_WINDOWS_SDK_VERSION}\\`],
    ["UCRTVersion", REMOTE_WORKER_WINDOWS_SDK_VERSION],
    ["PreferredToolArchitecture", "x64"],
    ["ImportDirectoryBuildProps", "false"],
    ["ImportDirectoryBuildTargets", "false"],
    ["Deterministic", "true"],
    ["EnableASAN", addressSanitizer ? "true" : "false"],
    ["OutDir", outDirectory],
    ["IntDir", objectDirectory],
    ...additionalProperties,
  ];
  const arguments_ = [
    selectedProjectPath,
    "/nologo",
    "/m:1",
    "/nodeReuse:false",
    "/t:Rebuild",
    "/v:minimal",
    ...properties.map(([name, value]) => `/p:${name}=${value}`),
  ];
  const result = spawnSync(toolchain.msbuildPath, arguments_, {
    cwd: repoRoot,
    env: buildSanitizedEnvironment(toolchain, buildRoot),
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Pinned provisioner ${addressSanitizer ? "native-test" : "production"} build failed (${result.status}).\n${boundedBuildOutput(result.stdout)}\n${boundedBuildOutput(result.stderr)}`,
    );
  }
  const binaryPath = path.join(outDirectory, expectedBinaryName);
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Pinned build did not emit the exact ${expectedBinaryName} filename.`);
  }
  return binaryPath;
}

function buildSanitizedEnvironment(toolchain, buildRoot) {
  const systemRoot = process.env.SystemRoot;
  if (typeof systemRoot !== "string" || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("A valid Windows SystemRoot is required to launch the pinned build tools.");
  }
  const canonicalSystemRoot = fs.realpathSync.native(systemRoot);
  const system32 = checkedExistingDescendant(
    canonicalSystemRoot,
    path.join(canonicalSystemRoot, "System32"),
    "System32",
  );
  const temporaryDirectory = path.join(buildRoot, "tmp");
  fs.mkdirSync(temporaryDirectory, { recursive: true });
  return {
    SystemRoot: canonicalSystemRoot,
    ComSpec: path.join(system32, "cmd.exe"),
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    PATH: [
      path.dirname(toolchain.msbuildPath),
      path.dirname(toolchain.compilerPath),
      toolchain.sdkBinaryRoot,
      system32,
    ].join(path.delimiter),
    MSBUILDDISABLENODEREUSE: "1",
    VSCMD_SKIP_SENDTELEMETRY: "1",
  };
}

function checkedExistingDescendant(root, candidate, description) {
  const resolvedRoot = fs.realpathSync.native(root);
  const resolvedCandidate = fs.realpathSync.native(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return resolvedCandidate;
  }
  throw new Error(`${description} escaped its pinned root.`);
}

function boundedBuildOutput(value) {
  const text = typeof value === "string" ? value : "";
  return text.length <= 16_384 ? text : text.slice(text.length - 16_384);
}

export function inspectRemoteWorkerProvisionerPe(bytes, { expectedMachine, binaryKind = "service" }) {
  if (binaryKind !== "service" && binaryKind !== "client" && binaryKind !== "availability") {
    throw new Error(`Unknown provisioner PE binary kind: ${String(binaryKind)}.`);
  }
  if (!Buffer.isBuffer(bytes) || bytes.length < 512 || bytes.length > maximumPeBytes) {
    throw new Error("Provisioner PE size is outside the bounded proof range.");
  }
  if (bytes.readUInt16LE(0) !== 0x5a4d) {
    throw new Error("Provisioner PE has no DOS MZ signature.");
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  requireRange(bytes, peOffset, 24, "PE header");
  if (bytes.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error("Provisioner PE signature is invalid.");
  }

  const coffOffset = peOffset + 4;
  const machine = bytes.readUInt16LE(coffOffset);
  if (machine !== expectedMachine) {
    throw new Error(`Provisioner PE machine is 0x${machine.toString(16)}, expected 0x${expectedMachine.toString(16)}.`);
  }
  const sectionCount = bytes.readUInt16LE(coffOffset + 2);
  if (sectionCount === 0 || sectionCount > maximumSections) {
    throw new Error("Provisioner PE section count is invalid.");
  }
  const coffTimestamp = bytes.readUInt32LE(coffOffset + 4);
  if (bytes.readUInt32LE(coffOffset + 8) !== 0 || bytes.readUInt32LE(coffOffset + 12) !== 0) {
    throw new Error("Provisioner PE must not contain a COFF symbol table.");
  }
  const coffCharacteristics = bytes.readUInt16LE(coffOffset + 18);
  if ((coffCharacteristics & 0x0001) !== 0) {
    throw new Error("Provisioner PE base relocations must not be stripped.");
  }
  if ((coffCharacteristics & 0x0002) === 0 || (coffCharacteristics & 0x0020) === 0) {
    throw new Error("Provisioner PE must be an executable large-address-aware image.");
  }
  if ((coffCharacteristics & 0x2000) !== 0) {
    throw new Error("Provisioner PE must not be marked as a DLL.");
  }
  const optionalSize = bytes.readUInt16LE(coffOffset + 16);
  const optionalOffset = coffOffset + 20;
  requireRange(bytes, optionalOffset, optionalSize, "optional header");
  if (optionalSize < 112 + 16 * 8 || bytes.readUInt16LE(optionalOffset) !== 0x20b) {
    throw new Error("Provisioner must be a PE32+ image with a complete data-directory table.");
  }
  if (bytes.readUInt16LE(optionalOffset + 68) !== 3) {
    throw new Error("Provisioner PE must use the Windows console subsystem.");
  }

  const dllCharacteristics = bytes.readUInt16LE(optionalOffset + 70);
  const requiredDllCharacteristics = 0x0020 | 0x0040 | 0x0100 | 0x4000;
  if ((dllCharacteristics & requiredDllCharacteristics) !== requiredDllCharacteristics) {
    throw new Error("Provisioner PE is missing high-entropy ASLR, dynamic-base, NX, or CFG flags.");
  }
  const dataDirectoryCount = bytes.readUInt32LE(optionalOffset + 108);
  if (dataDirectoryCount < 16) {
    throw new Error("Provisioner PE data-directory table is incomplete.");
  }

  const sectionsOffset = optionalOffset + optionalSize;
  requireRange(bytes, sectionsOffset, sectionCount * 40, "section table");
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const sectionOffset = sectionsOffset + index * 40;
    sections.push({
      virtualSize: bytes.readUInt32LE(sectionOffset + 8),
      virtualAddress: bytes.readUInt32LE(sectionOffset + 12),
      rawSize: bytes.readUInt32LE(sectionOffset + 16),
      rawOffset: bytes.readUInt32LE(sectionOffset + 20),
      characteristics: bytes.readUInt32LE(sectionOffset + 36),
    });
  }
  const sizeOfHeaders = bytes.readUInt32LE(optionalOffset + 60);
  if (sizeOfHeaders === 0 || sizeOfHeaders > bytes.length) {
    throw new Error("Provisioner PE SizeOfHeaders is invalid.");
  }
  const imageBase = bytes.readBigUInt64LE(optionalOffset + 24);
  const sectionAlignment = bytes.readUInt32LE(optionalOffset + 32);
  const fileAlignment = bytes.readUInt32LE(optionalOffset + 36);
  const sizeOfImage = bytes.readUInt32LE(optionalOffset + 56);
  const isPowerOfTwo = (value) => value !== 0 && (value & (value - 1)) === 0;
  if (
    imageBase === 0n ||
    imageBase > 0x00007fffffff0000n ||
    imageBase % 0x10000n !== 0n ||
    !isPowerOfTwo(sectionAlignment) ||
    sectionAlignment < 0x1000 ||
    sectionAlignment > 0x10000 ||
    !isPowerOfTwo(fileAlignment) ||
    fileAlignment < 0x200 ||
    fileAlignment > sectionAlignment ||
    sizeOfHeaders % fileAlignment !== 0 ||
    sizeOfHeaders !== Math.ceil((sectionsOffset + sectionCount * 40) / fileAlignment) * fileAlignment
  ) {
    throw new Error("Provisioner PE image base or header alignment is non-canonical.");
  }
  let requiredImageBytes = sizeOfHeaders;
  for (const section of sections) {
    const virtualSpan = Math.max(section.virtualSize, section.rawSize);
    if (
      section.virtualAddress === 0 ||
      section.virtualAddress % sectionAlignment !== 0 ||
      section.rawOffset % fileAlignment !== 0 ||
      virtualSpan === 0 ||
      section.virtualAddress > 0xffffffff - virtualSpan
    ) {
      throw new Error("Provisioner PE section layout is non-canonical.");
    }
    requiredImageBytes = Math.max(requiredImageBytes, section.virtualAddress + virtualSpan);
  }
  const canonicalSizeOfImage = Math.ceil(requiredImageBytes / sectionAlignment) * sectionAlignment;
  if (sizeOfImage !== canonicalSizeOfImage || sizeOfImage > 512 * 1024 * 1024) {
    throw new Error("Provisioner PE SizeOfImage is non-canonical.");
  }
  assertNonOverlappingPeSections(bytes, sections, sizeOfHeaders);
  const mapRva = (rva, size, description) => mapRvaToOffset(bytes, sections, sizeOfHeaders, rva, size, description);
  const addressOfEntryPoint = bytes.readUInt32LE(optionalOffset + 16);
  if (addressOfEntryPoint === 0) {
    throw new Error("Provisioner PE AddressOfEntryPoint must be non-zero.");
  }
  const entrySection = sections.find((section) => {
    const virtualSpan = Math.max(section.virtualSize, section.rawSize);
    return addressOfEntryPoint >= section.virtualAddress && addressOfEntryPoint - section.virtualAddress < virtualSpan;
  });
  const requiredEntryCharacteristics = 0x00000020 | 0x20000000 | 0x40000000;
  if (
    entrySection === undefined ||
    (entrySection.characteristics & requiredEntryCharacteristics) !== requiredEntryCharacteristics ||
    (entrySection.characteristics & 0x80000000) !== 0
  ) {
    throw new Error("Provisioner PE entrypoint is not in a readable, executable, non-writable code section.");
  }
  mapRva(addressOfEntryPoint, 1, "entrypoint");

  const directory = (index) => ({
    rva: bytes.readUInt32LE(optionalOffset + 112 + index * 8),
    size: bytes.readUInt32LE(optionalOffset + 116 + index * 8),
  });
  const exportDirectory = directory(0);
  if (exportDirectory.rva !== 0 || exportDirectory.size !== 0) {
    throw new Error("Provisioner PE must not export a callable native surface.");
  }
  const authenticodeDirectory = directory(4);
  if (authenticodeDirectory.rva !== 0 || authenticodeDirectory.size !== 0) {
    throw new Error("Provisioner PE must not contain an Authenticode mutation at W0.");
  }
  for (const [index, description] of [
    [9, "TLS-callback"],
    [11, "bound-import"],
    [13, "delay-import"],
    [14, "managed-runtime"],
  ]) {
    const forbiddenDirectory = directory(index);
    if (forbiddenDirectory.rva !== 0 || forbiddenDirectory.size !== 0) {
      throw new Error(`Provisioner PE must not contain a ${description} directory.`);
    }
  }

  const debugDirectory = directory(6);
  if (debugDirectory.rva === 0 || debugDirectory.size !== 56) {
    throw new Error(
      `Provisioner PE must contain the exact LTCG + reproducibility metadata pair (rva=${debugDirectory.rva}, size=${debugDirectory.size}).`,
    );
  }
  const debugOffset = mapRva(debugDirectory.rva, debugDirectory.size, "debug directory");
  const debugEntries = [0, 28].map((relativeOffset) => {
    const entryOffset = debugOffset + relativeOffset;
    const characteristics = bytes.readUInt32LE(entryOffset);
    const timestamp = bytes.readUInt32LE(entryOffset + 4);
    const majorVersion = bytes.readUInt16LE(entryOffset + 8);
    const minorVersion = bytes.readUInt16LE(entryOffset + 10);
    const type = bytes.readUInt32LE(entryOffset + 12);
    const dataSize = bytes.readUInt32LE(entryOffset + 16);
    const dataRva = bytes.readUInt32LE(entryOffset + 20);
    const dataFileOffset = bytes.readUInt32LE(entryOffset + 24);
    if (
      characteristics !== 0 ||
      timestamp !== coffTimestamp ||
      majorVersion !== 0 ||
      minorVersion !== 0 ||
      dataSize > 64 * 1024
    ) {
      throw new Error("Provisioner PE debug metadata is non-canonical or unbounded.");
    }
    if (dataSize === 0) {
      if (dataRva !== 0 || dataFileOffset !== 0) {
        throw new Error("Provisioner PE empty debug metadata has non-zero data pointers.");
      }
      return { type, data: Buffer.alloc(0) };
    }
    const mappedDataOffset = mapRva(dataRva, dataSize, "debug metadata payload");
    if (mappedDataOffset !== dataFileOffset) {
      throw new Error("Provisioner PE debug metadata has inconsistent RVA/file offsets.");
    }
    return { type, data: bytes.subarray(dataFileOffset, dataFileOffset + dataSize) };
  });
  if (debugEntries[0].type !== 13 || debugEntries[1].type !== 16) {
    throw new Error(
      `Provisioner PE debug metadata types are not the exact LTCG/POGO + REPRO pair (${debugEntries.map((entry) => entry.type).join(",")}).`,
    );
  }
  if (debugEntries[0].data.length < 4 || debugEntries[0].data.readUInt32LE(0) !== 0x4c544347) {
    throw new Error("Provisioner PE IMAGE_DEBUG_TYPE_POGO payload is not canonical LTCG metadata.");
  }
  const reproData = debugEntries[1].data;
  if (reproData.length < 8 || reproData.length > 128) {
    throw new Error("Provisioner PE debug entry is not one bounded IMAGE_DEBUG_TYPE_REPRO record.");
  }
  const declaredReproHashBytes = reproData.readUInt32LE(0);
  if (declaredReproHashBytes === 0 || declaredReproHashBytes !== reproData.length - 4) {
    throw new Error("Provisioner PE reproducibility payload has a non-canonical hash length.");
  }

  const expectedImports = expectedImportsForMachine(expectedMachine, binaryKind);
  const importDirectory = directory(1);
  const expectedImportDirectorySize = (expectedImports.length + 1) * 20;
  if (importDirectory.rva === 0 || importDirectory.size !== expectedImportDirectorySize) {
    throw new Error(
      `Provisioner ${binaryKind} PE import descriptor closure is invalid (size=${importDirectory.size}, expected=${expectedImportDirectorySize}).`,
    );
  }
  const importOffset = mapRva(importDirectory.rva, importDirectory.size, "import directory");
  const imports = [];
  const iatRanges = [];
  for (let descriptorIndex = 0; descriptorIndex < expectedImports.length; descriptorIndex += 1) {
    const descriptorOffset = importOffset + descriptorIndex * 20;
    const [originalFirstThunk, timeDateStamp, forwarderChain, nameRva, firstThunk] = [0, 4, 8, 12, 16].map((offset) =>
      bytes.readUInt32LE(descriptorOffset + offset),
    );
    if (originalFirstThunk === 0 || timeDateStamp !== 0 || forwarderChain !== 0 || nameRva === 0 || firstThunk === 0) {
      throw new Error(`Provisioner ${binaryKind} PE import descriptor is non-canonical.`);
    }
    const dll = readBoundedAsciiZ(bytes, mapRva(nameRva, 1, "import DLL name"), 64, "import DLL name");
    if (!allowedImportDlls[binaryKind].includes(dll)) {
      throw new Error(`Provisioner ${binaryKind} PE DLL import is outside the W1A closure: ${dll}`);
    }

    const functions = [];
    for (let functionIndex = 0; functionIndex <= maximumImportFunctions; functionIndex += 1) {
      if (functionIndex === maximumImportFunctions) {
        throw new Error(`Provisioner ${binaryKind} PE named-import table is not bounded.`);
      }
      const nameThunkOffset = mapRva(originalFirstThunk + functionIndex * 8, 8, "import-name thunk");
      const addressThunkOffset = mapRva(firstThunk + functionIndex * 8, 8, "import-address thunk");
      const thunk = bytes.readBigUInt64LE(nameThunkOffset);
      if (bytes.readBigUInt64LE(addressThunkOffset) !== thunk) {
        throw new Error("Provisioner PE import-name and import-address tables differ before loading.");
      }
      if (thunk === 0n) {
        break;
      }
      if ((thunk & 0x8000000000000000n) !== 0n) {
        throw new Error("Provisioner PE contains a forbidden ordinal import.");
      }
      if (thunk > 0xffffffffn) {
        throw new Error("Provisioner PE named import has a non-canonical RVA.");
      }
      const hintNameOffset = mapRva(Number(thunk), 3, "import hint/name");
      functions.push(readBoundedAsciiZ(bytes, hintNameOffset + 2, 128, "import function name"));
    }
    const canonicalFunctions = [...new Set(functions)].sort(asciiCompare);
    if (canonicalFunctions.length !== functions.length) {
      throw new Error(`Provisioner ${binaryKind} PE contains duplicate named imports.`);
    }
    const forbiddenImport = canonicalFunctions.find(
      (name) =>
        !(binaryKind === "service" && w1b1aServiceAuthorityImports.includes(name)) &&
        !(binaryKind === "availability" && availabilityAuthorityImports.includes(name)) &&
        forbiddenProvisionerImportPatterns.some((pattern) => pattern.test(name)),
    );
    if (forbiddenImport !== undefined) {
      throw new Error(`Provisioner ${binaryKind} PE contains forbidden W1A authority import: ${forbiddenImport}`);
    }
    imports.push(Object.freeze({ dll, functions: Object.freeze(canonicalFunctions) }));
    iatRanges.push([firstThunk, firstThunk + (functions.length + 1) * 8]);
  }
  const terminatorOffset = importOffset + expectedImports.length * 20;
  const terminatorFields = [0, 4, 8, 12, 16].map((offset) => bytes.readUInt32LE(terminatorOffset + offset));
  if (terminatorFields.some((value) => value !== 0)) {
    throw new Error("Provisioner PE import descriptor table has no exact terminator.");
  }

  const canonicalImports = [...imports].sort((left, right) => asciiCompare(left.dll, right.dll));
  const canonicalExpectedImports = expectedImports.map((entry) => ({
    dll: entry.dll,
    functions: [...entry.functions].sort(asciiCompare),
  }));
  if (
    canonicalImports.length !== canonicalExpectedImports.length ||
    canonicalImports.some(
      (entry, index) =>
        entry.dll !== canonicalExpectedImports[index].dll ||
        entry.functions.length !== canonicalExpectedImports[index].functions.length ||
        entry.functions.some(
          (name, functionIndex) => name !== canonicalExpectedImports[index].functions[functionIndex],
        ),
    )
  ) {
    throw new Error(
      `Provisioner ${binaryKind} PE named imports are outside the exact W1A closure: ${JSON.stringify(canonicalImports)}.`,
    );
  }

  iatRanges.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < iatRanges.length; index += 1) {
    if (iatRanges[index][0] !== iatRanges[index - 1][1]) {
      throw new Error("Provisioner PE import-address tables are not one exact contiguous closure.");
    }
  }
  const importAddressTable = directory(12);
  if (
    importAddressTable.rva !== iatRanges[0][0] ||
    importAddressTable.size !== iatRanges[iatRanges.length - 1][1] - iatRanges[0][0]
  ) {
    throw new Error("Provisioner PE import-address table is outside the exact named-import closure.");
  }

  const loadConfigDirectory = directory(10);
  if (loadConfigDirectory.rva === 0 || loadConfigDirectory.size < 148 || loadConfigDirectory.size > 4096) {
    throw new Error("Provisioner PE CFG load configuration is missing.");
  }
  const loadConfigOffset = mapRva(loadConfigDirectory.rva, loadConfigDirectory.size, "load configuration");
  const declaredLoadConfigSize = bytes.readUInt32LE(loadConfigOffset);
  if (declaredLoadConfigSize !== loadConfigDirectory.size) {
    throw new Error("Provisioner PE load configuration is too small for GuardFlags.");
  }
  const guardCheckPointer = bytes.readBigUInt64LE(loadConfigOffset + 112);
  const guardDispatchPointer = bytes.readBigUInt64LE(loadConfigOffset + 120);
  const guardFunctionTable = bytes.readBigUInt64LE(loadConfigOffset + 128);
  const guardFunctionCount = bytes.readBigUInt64LE(loadConfigOffset + 136);
  const guardFlags = bytes.readUInt32LE(loadConfigOffset + 144);
  if (
    (guardFlags & 0x500) !== 0x500 ||
    guardCheckPointer === 0n ||
    guardDispatchPointer === 0n ||
    guardFunctionTable === 0n ||
    guardFunctionCount === 0n
  ) {
    throw new Error("Provisioner PE load configuration is not CFG-instrumented.");
  }
  const mapImageVa = (va, size, description) => {
    if (va < imageBase) {
      throw new Error(`Provisioner PE ${description} VA is below ImageBase.`);
    }
    const relative = va - imageBase;
    if (relative > 0xffffffffn) {
      throw new Error(`Provisioner PE ${description} VA overflows the image RVA range.`);
    }
    const rva = Number(relative);
    if (rva >= sizeOfImage || size > sizeOfImage - rva) {
      throw new Error(`Provisioner PE ${description} VA is outside SizeOfImage.`);
    }
    return { rva, offset: mapRva(rva, size, description) };
  };
  mapImageVa(guardCheckPointer, 8, "GuardCF check pointer slot");
  mapImageVa(guardDispatchPointer, 8, "GuardCF dispatch pointer slot");
  const guardTableExtraBytes = (guardFlags >>> 28) & 0x0f;
  const guardTableEntryBytes = 4 + guardTableExtraBytes;
  if (guardFunctionCount > 65_536n) {
    throw new Error("Provisioner PE GuardCFFunctionCount is unbounded.");
  }
  const guardTableBytes = Number(guardFunctionCount) * guardTableEntryBytes;
  if (guardTableBytes === 0 || guardTableBytes > 1024 * 1024) {
    throw new Error("Provisioner PE GuardCFFunctionTable size is invalid.");
  }
  const mappedGuardTable = mapImageVa(guardFunctionTable, guardTableBytes, "GuardCFFunctionTable");
  let previousGuardFunctionRva = -1;
  for (let index = 0; index < Number(guardFunctionCount); index += 1) {
    const functionRva = bytes.readUInt32LE(mappedGuardTable.offset + index * guardTableEntryBytes);
    const functionSection = sections.find((section) => {
      const virtualSpan = Math.max(section.virtualSize, section.rawSize);
      return functionRva >= section.virtualAddress && functionRva - section.virtualAddress < virtualSpan;
    });
    if (
      functionRva <= previousGuardFunctionRva ||
      functionRva >= sizeOfImage ||
      functionSection === undefined ||
      (functionSection.characteristics & 0x00000020) === 0 ||
      (functionSection.characteristics & 0x20000000) === 0 ||
      (functionSection.characteristics & 0x40000000) === 0 ||
      (functionSection.characteristics & 0x80000000) !== 0
    ) {
      throw new Error("Provisioner PE GuardCFFunctionTable entry is not canonical executable code.");
    }
    mapRva(functionRva, 1, "GuardCFFunctionTable entry");
    previousGuardFunctionRva = functionRva;
  }
  const relocationDirectory = directory(5);
  if (relocationDirectory.rva === 0 || relocationDirectory.size < 8 || relocationDirectory.size > 512 * 1024) {
    throw new Error("Provisioner PE dynamic-base relocation directory is missing.");
  }
  const relocationOffset = mapRva(relocationDirectory.rva, relocationDirectory.size, "base relocation directory");
  let relativeRelocationOffset = 0;
  let architectureRelocationCount = 0;
  while (relativeRelocationOffset < relocationDirectory.size) {
    const remainingBytes = relocationDirectory.size - relativeRelocationOffset;
    if (remainingBytes < 8) {
      throw new Error("Provisioner PE base relocation directory has trailing partial block data.");
    }
    const blockOffset = relocationOffset + relativeRelocationOffset;
    const pageRva = bytes.readUInt32LE(blockOffset);
    const blockSize = bytes.readUInt32LE(blockOffset + 4);
    if (blockSize < 8 || (blockSize & 3) !== 0 || blockSize > remainingBytes) {
      throw new Error("Provisioner PE base relocation block size is invalid.");
    }
    if ((pageRva & 0x0fff) !== 0) {
      throw new Error("Provisioner PE base relocation block page RVA is not page-aligned.");
    }
    const entryBytes = blockSize - 8;
    if ((entryBytes & 1) !== 0) {
      throw new Error("Provisioner PE base relocation block has a partial entry.");
    }
    for (let entryOffset = 0; entryOffset < entryBytes; entryOffset += 2) {
      const entry = bytes.readUInt16LE(blockOffset + 8 + entryOffset);
      const type = entry >>> 12;
      const offsetWithinPage = entry & 0x0fff;
      if (type === 0) {
        continue;
      }
      if (type !== 10) {
        throw new Error(`Provisioner PE base relocation type ${type} is invalid for PE32+ ${binaryKind}.`);
      }
      if (pageRva > 0xffffffff - offsetWithinPage) {
        throw new Error("Provisioner PE base relocation target RVA overflows the image address space.");
      }
      const targetRva = pageRva + offsetWithinPage;
      const targetSection = sections.find((section) => {
        const virtualSpan = Math.max(section.virtualSize, section.rawSize);
        return targetRva >= section.virtualAddress && targetRva - section.virtualAddress <= virtualSpan - 8;
      });
      if (targetSection === undefined) {
        throw new Error("Provisioner PE base relocation target is outside a mapped image section.");
      }
      mapRva(targetRva, 8, "base relocation target");
      architectureRelocationCount += 1;
    }
    relativeRelocationOffset += blockSize;
  }
  if (relativeRelocationOffset !== relocationDirectory.size || architectureRelocationCount === 0) {
    throw new Error("Provisioner PE base relocation directory has no architecture relocation entries.");
  }

  return Object.freeze({
    machine,
    sectionCount,
    coffTimestamp,
    dllCharacteristics,
    imports: Object.freeze(canonicalImports),
    guardFlags,
    debugDirectory: Object.freeze([
      Object.freeze({
        type: "IMAGE_DEBUG_TYPE_POGO",
        payloadSha256: crypto.createHash("sha256").update(debugEntries[0].data).digest("hex"),
      }),
      Object.freeze({
        type: "IMAGE_DEBUG_TYPE_REPRO",
        payloadSha256: crypto.createHash("sha256").update(reproData).digest("hex"),
      }),
    ]),
    authenticodeDirectory: false,
  });
}

function assertNonOverlappingPeSections(bytes, sections, sizeOfHeaders) {
  const rawRanges = [];
  const virtualRanges = [];
  for (const section of sections) {
    const containsCode = (section.characteristics & 0x00000020) !== 0;
    const executable = (section.characteristics & 0x20000000) !== 0;
    const readable = (section.characteristics & 0x40000000) !== 0;
    const writable = (section.characteristics & 0x80000000) !== 0;
    if ((executable && writable) || (containsCode && (!executable || !readable || writable))) {
      throw new Error("Provisioner PE section characteristics violate the W^X code policy.");
    }
    if (section.rawSize > 0) {
      requireRange(bytes, section.rawOffset, section.rawSize, "section raw bytes");
      if (section.rawOffset < sizeOfHeaders) {
        throw new Error("Provisioner PE section overlaps its headers.");
      }
      rawRanges.push([section.rawOffset, section.rawOffset + section.rawSize]);
    }
    const virtualSpan = Math.max(section.virtualSize, section.rawSize);
    if (section.virtualAddress === 0 || virtualSpan === 0) {
      throw new Error("Provisioner PE section has an empty virtual range.");
    }
    virtualRanges.push([section.virtualAddress, section.virtualAddress + virtualSpan]);
  }
  for (const ranges of [rawRanges, virtualRanges]) {
    ranges.sort((left, right) => left[0] - right[0]);
    for (let index = 1; index < ranges.length; index += 1) {
      if (ranges[index][0] < ranges[index - 1][1]) {
        throw new Error("Provisioner PE sections overlap.");
      }
    }
  }
}

function mapRvaToOffset(bytes, sections, sizeOfHeaders, rva, size, description) {
  if (!Number.isSafeInteger(rva) || !Number.isSafeInteger(size) || rva < 0 || size < 0) {
    throw new Error(`${description} has an invalid RVA range.`);
  }
  if (rva < sizeOfHeaders) {
    if (size > sizeOfHeaders - rva) {
      throw new Error(`${description} crosses the PE header boundary.`);
    }
    requireRange(bytes, rva, size, description);
    return rva;
  }
  for (const section of sections) {
    const span = Math.max(section.virtualSize, section.rawSize);
    if (rva < section.virtualAddress) continue;
    const delta = rva - section.virtualAddress;
    const startsInsideSection = size === 0 ? delta <= span : delta < span;
    if (!startsInsideSection || size > span - delta || delta > section.rawSize || size > section.rawSize - delta) {
      continue;
    }
    const offset = section.rawOffset + delta;
    requireRange(bytes, offset, size, description);
    return offset;
  }
  throw new Error(`${description} RVA is outside file-backed PE sections.`);
}

function readBoundedAsciiZ(bytes, offset, maximumLength, description) {
  requireRange(bytes, offset, 1, description);
  const endLimit = Math.min(bytes.length, offset + maximumLength + 1);
  let end = offset;
  while (end < endLimit && bytes[end] !== 0) {
    const value = bytes[end];
    if (value < 0x21 || value > 0x7e) {
      throw new Error(`${description} is not canonical printable ASCII.`);
    }
    end += 1;
  }
  if (end === endLimit || end === offset) {
    throw new Error(`${description} is missing a bounded non-empty terminator.`);
  }
  return bytes.toString("ascii", offset, end);
}

function requireRange(bytes, offset, length, description) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > bytes.length ||
    length > bytes.length - offset
  ) {
    throw new Error(`${description} is outside the bounded PE bytes.`);
  }
}

function asciiCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function expectedImportsForMachine(machine, binaryKind) {
  const closures = REMOTE_WORKER_WINDOWS_PROVISIONER_IMPORTS[binaryKind];
  if (closures === undefined) {
    throw new Error(`No frozen provisioner import closure exists for binary kind ${String(binaryKind)}.`);
  }
  if (machine === targetMachines["windows-x64"]) {
    return closures["windows-x64"];
  }
  if (machine === targetMachines["windows-arm64"]) {
    return closures["windows-arm64"];
  }
  throw new Error(`No frozen provisioner ${binaryKind} import closure exists for machine 0x${machine.toString(16)}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
