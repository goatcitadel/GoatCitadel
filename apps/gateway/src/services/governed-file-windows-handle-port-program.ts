/**
 * Fixed helper program for the governed-file Windows handle port.
 *
 * Kept in its own module so the strictly-validated protocol wrapper stays
 * reviewable on its own; the program is content-addressed by the wrapper's
 * diagnostics and delivered to the fixed System32 PowerShell host via an
 * environment variable, exactly like the remote-worker no-follow precedent.
 */

import { GOVERNED_FILE_HANDLE_PORT_SCHEMA_VERSION as SCHEMA_VERSION } from "./governed-file-windows-handle-port-schema.js";

export function buildPowerShellProgram(): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.Encoding]::ASCII
[Console]::OutputEncoding = [Text.Encoding]::ASCII
$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class GoatGovernedFileMutation {
  const uint FILE_READ_DATA = 0x0001, FILE_WRITE_DATA = 0x0002, FILE_APPEND_DATA = 0x0004;
  const uint FILE_LIST_DIRECTORY = 0x0001, FILE_ADD_FILE = 0x0002;
  const uint FILE_READ_ATTRIBUTES = 0x0080, FILE_WRITE_ATTRIBUTES = 0x0100, FILE_TRAVERSE = 0x0020, DELETE = 0x00010000;
  const uint READ_CONTROL = 0x00020000, SYNCHRONIZE = 0x00100000;
  const uint FILE_SHARE_READ = 0x1, FILE_SHARE_WRITE = 0x2, FILE_SHARE_DELETE = 0x4;
  const uint FILE_OPEN = 1, FILE_CREATE = 2;
  const uint FILE_DIRECTORY_FILE = 0x1, FILE_NON_DIRECTORY_FILE = 0x40;
  const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x20, FILE_OPEN_REPARSE_POINT = 0x00200000;
  const uint OBJ_DONT_REPARSE = 0x1000;
  const uint OPEN_EXISTING = 3, FILE_FLAG_BACKUP_SEMANTICS = 0x02000000, FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const int FileBasicInfo = 0, FileStandardInfo = 1, FileAttributeTagInfo = 9, FileIdInfo = 18;
  const int FileRenameInformationExClass = 65, FileDispositionInformationExClass = 64;
  const int STATUS_OBJECT_NAME_NOT_FOUND = unchecked((int)0xC0000034);
  const int STATUS_OBJECT_NAME_COLLISION = unchecked((int)0xC0000035);
  const int STATUS_FILE_IS_A_DIRECTORY = unchecked((int)0xC00000BA);
  const int STATUS_NOT_A_DIRECTORY = unchecked((int)0xC0000103);
  const int STATUS_INVALID_INFO_CLASS = unchecked((int)0xC0000003);
  const int STATUS_INVALID_PARAMETER = unchecked((int)0xC000000D);
  const int STATUS_NOT_SUPPORTED = unchecked((int)0xC00000BB);
  const uint FILE_RENAME_REPLACE_IF_EXISTS = 0x1, FILE_RENAME_POSIX_SEMANTICS = 0x2;
  const uint FILE_DISPOSITION_DELETE = 0x1, FILE_DISPOSITION_POSIX_SEMANTICS = 0x2;
  const int FileStreamInformation = 22;

  [StructLayout(LayoutKind.Sequential)] struct IO_STATUS_BLOCK { public IntPtr Status; public UIntPtr Information; }
  [StructLayout(LayoutKind.Sequential)] struct UNICODE_STRING { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct OBJECT_ATTRIBUTES {
    public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes;
    public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService;
  }
  [StructLayout(LayoutKind.Sequential)] struct FILE_BASIC_INFO {
    public long CreationTime, LastAccessTime, LastWriteTime, ChangeTime; public uint FileAttributes;
  }
  [StructLayout(LayoutKind.Sequential)] struct FILE_STANDARD_INFO {
    public long AllocationSize, EndOfFile; public uint NumberOfLinks; [MarshalAs(UnmanagedType.U1)] public bool DeletePending;
    [MarshalAs(UnmanagedType.U1)] public bool Directory;
  }
  [StructLayout(LayoutKind.Sequential)] struct FILE_ATTRIBUTE_TAG_INFO { public uint FileAttributes, ReparseTag; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct FILE_ID_INFO {
    public ulong VolumeSerialNumber; [MarshalAs(UnmanagedType.ByValArray, SizeConst=16)] public byte[] FileId;
  }

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string n, uint a, uint s, IntPtr p, uint d, uint f, IntPtr t);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern uint GetDriveTypeW(string root);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint QueryDosDeviceW(string device, StringBuilder target, int maximumCharacters);
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr h, uint a, ref OBJECT_ATTRIBUTES o,
    out IO_STATUS_BLOCK i, IntPtr z, uint fa, uint share, uint disposition, uint options, IntPtr e, uint el);
  [DllImport("ntdll.dll")] static extern int NtSetInformationFile(IntPtr h, out IO_STATUS_BLOCK ios,
    IntPtr info, uint length, int cls);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationFile(IntPtr h, out IO_STATUS_BLOCK ios,
    IntPtr info, uint length, int cls);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(
    SafeFileHandle h, int cls, IntPtr info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(
    SafeFileHandle h, byte[] buffer, uint bytesToRead, out uint bytesRead, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(
    SafeFileHandle h, byte[] buffer, uint bytesToWrite, out uint bytesWritten, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFilePointerEx(
    SafeFileHandle h, long distance, out long newPointer, uint moveMethod);

  public sealed class Refusal : Exception { public Refusal(string reason) : base(reason) {} }

  public sealed class ParentWalk : IDisposable {
    public readonly List<SafeFileHandle> Handles = new List<SafeFileHandle>();
    public ParentWalk(string root, string parentRelative, bool wantWrite) {
      AssertNativeFixedVolume(root);
      string volume = @"\\?\" + root.Substring(0, 3);
      // Directory handles keep full sharing: a directory's share mode never
      // guards entry mutations, but a restrictive one blocks the kernel's own
      // internal target-directory open during rename-by-handle.
      SafeFileHandle current = CreateFileW(volume, FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, IntPtr.Zero, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
      if (current.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      Handles.Add(current);
      var all = new List<string>();
      all.AddRange(root.Substring(3).Split(new[]{'\\'}, StringSplitOptions.RemoveEmptyEntries));
      if (!String.IsNullOrEmpty(parentRelative)) all.AddRange(parentRelative.Split('/'));
      for (int index = 0; index < all.Count; index++) {
        bool final = index == all.Count - 1;
        uint access = FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE | FILE_LIST_DIRECTORY | FILE_TRAVERSE;
        if (final && wantWrite) access |= FILE_ADD_FILE;
        current = OpenRelativeDirectory(current, all[index], access);
        Handles.Add(current);
        var tag = Query<FILE_ATTRIBUTE_TAG_INFO>(current, FileAttributeTagInfo);
        if (tag.ReparseTag != 0) throw new Refusal("reparse_refused");
      }
    }
    public SafeFileHandle Parent { get { return Handles[Handles.Count - 1]; } }
    public void Dispose() { for (int i = Handles.Count - 1; i >= 0; i--) Handles[i].Dispose(); }
  }

  static void AssertNativeFixedVolume(string root) {
    string drive = root.Substring(0, 2), driveRoot = drive + @"\";
    if (GetDriveTypeW(driveRoot) != 3) throw new IOException("native fixed volume required");
    var target = new StringBuilder(1024);
    uint count = QueryDosDeviceW(drive, target, target.Capacity);
    if (count == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
    string value = target.ToString();
    if (!System.Text.RegularExpressions.Regex.IsMatch(value, @"^\\Device\\HarddiskVolume[0-9]+$", System.Text.RegularExpressions.RegexOptions.CultureInvariant))
      throw new IOException("native fixed volume required");
  }

  public static SafeFileHandle OpenRelative(SafeFileHandle parent, string name, uint access, uint disposition, uint options) {
    int status;
    SafeFileHandle handle = TryOpenRelative(parent, name, access, disposition, options, out status);
    if (handle == null) {
      if (status == STATUS_FILE_IS_A_DIRECTORY || status == STATUS_NOT_A_DIRECTORY) throw new Refusal("entry_kind_invalid");
      throw new IOException("relative handle open failed");
    }
    return handle;
  }

  static SafeFileHandle OpenRelativeDirectory(SafeFileHandle parent, string name, uint access) {
    int status;
    SafeFileHandle handle = TryOpenRelativeWithShare(parent, name, access, FILE_OPEN,
      FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT | FILE_DIRECTORY_FILE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, out status);
    if (handle == null) {
      if (status == STATUS_FILE_IS_A_DIRECTORY || status == STATUS_NOT_A_DIRECTORY) throw new Refusal("entry_kind_invalid");
      throw new IOException("relative handle open failed");
    }
    return handle;
  }

  public static SafeFileHandle TryOpenRelative(SafeFileHandle parent, string name, uint access, uint disposition, uint options, out int status) {
    // Entry and temp files deny concurrent writers for the CAS window while
    // still sharing delete so the POSIX rename can supersede the target.
    return TryOpenRelativeWithShare(parent, name, access, disposition, options,
      FILE_SHARE_READ | FILE_SHARE_DELETE, out status);
  }

  public static SafeFileHandle TryOpenWitness(SafeFileHandle parent, string name, out int status) {
    // Post-effect witness: a read-only observation that must coexist with the
    // still-held write handle, so it shares everything.
    return TryOpenRelativeWithShare(parent, name, EntryReadAccess(), FILE_OPEN, EntryOptions(),
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, out status);
  }

  static SafeFileHandle TryOpenRelativeWithShare(SafeFileHandle parent, string name, uint access, uint disposition, uint options, uint share, out int status) {
    IntPtr text = Marshal.StringToHGlobalUni(name), usPtr = IntPtr.Zero;
    try {
      UNICODE_STRING us = new UNICODE_STRING { Length=(ushort)(name.Length*2), MaximumLength=(ushort)(name.Length*2), Buffer=text };
      usPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING))); Marshal.StructureToPtr(us, usPtr, false);
      OBJECT_ATTRIBUTES oa = new OBJECT_ATTRIBUTES { Length=Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)), RootDirectory=parent.DangerousGetHandle(), ObjectName=usPtr, Attributes=OBJ_DONT_REPARSE };
      IO_STATUS_BLOCK ios; IntPtr raw;
      status = NtCreateFile(out raw, access, ref oa, out ios, IntPtr.Zero, 0, share, disposition, options, IntPtr.Zero, 0);
      if (status < 0) return null;
      return new SafeFileHandle(raw, true);
    } finally { if (usPtr != IntPtr.Zero) Marshal.FreeHGlobal(usPtr); Marshal.FreeHGlobal(text); }
  }

  static T Query<T>(SafeFileHandle h, int cls) where T : struct {
    int size = Marshal.SizeOf(typeof(T)); IntPtr p = Marshal.AllocHGlobal(size);
    try {
      if (!GetFileInformationByHandleEx(h, cls, p, (uint)size)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return (T)Marshal.PtrToStructure(p, typeof(T));
    } finally { Marshal.FreeHGlobal(p); }
  }
  static string Hex(byte[] b) { var s = new StringBuilder(b.Length*2); foreach (byte x in b) s.Append(x.ToString("x2")); return s.ToString(); }

  public static Dictionary<string,object> Observe(SafeFileHandle h) {
    var b = Query<FILE_BASIC_INFO>(h, FileBasicInfo);
    var s = Query<FILE_STANDARD_INFO>(h, FileStandardInfo);
    var t = Query<FILE_ATTRIBUTE_TAG_INFO>(h, FileAttributeTagInfo);
    var id = Query<FILE_ID_INFO>(h, FileIdInfo);
    return new Dictionary<string,object>{
      {"volumeSerial", id.VolumeSerialNumber.ToString("x16")},
      {"fileId", Hex(id.FileId)},
      {"sizeBytes", s.EndOfFile},
      {"linkCount", s.NumberOfLinks},
      {"attributes", b.FileAttributes},
      {"reparseTag", t.ReparseTag},
      {"lastWriteTime", b.LastWriteTime.ToString()},
      {"changeTime", b.ChangeTime.ToString()}
    };
  }

  public static void AssertPlainRegularEntry(SafeFileHandle h) {
    var t = Query<FILE_ATTRIBUTE_TAG_INFO>(h, FileAttributeTagInfo);
    if (t.ReparseTag != 0 || (t.FileAttributes & 0x400) != 0) throw new Refusal("reparse_refused");
    if ((t.FileAttributes & 0x10) != 0) throw new Refusal("entry_kind_invalid");
    var s = Query<FILE_STANDARD_INFO>(h, FileStandardInfo);
    if (s.NumberOfLinks != 1) throw new Refusal("entry_kind_invalid");
    if (CountDataStreams(h) > 1) throw new Refusal("entry_kind_invalid");
  }

  static int CountDataStreams(SafeFileHandle h) {
    int cap = 65536; IntPtr p = Marshal.AllocHGlobal(cap);
    try {
      IO_STATUS_BLOCK ios;
      int status = NtQueryInformationFile(h.DangerousGetHandle(), out ios, p, (uint)cap, FileStreamInformation);
      if (status < 0) throw new IOException("stream query failed");
      long used = (long)ios.Information.ToUInt64();
      if (used == 0) return 0;
      if (used < 24 || used > cap) throw new IOException("stream query invalid");
      int offset = 0, streams = 0;
      while (true) {
        if (offset + 24 > used) throw new IOException("stream query invalid");
        int next = Marshal.ReadInt32(p, offset), nameBytes = Marshal.ReadInt32(p, offset + 4);
        if (nameBytes < 0 || offset + 24 + nameBytes > used || nameBytes % 2 != 0) throw new IOException("stream query invalid");
        streams += 1;
        if (next == 0) break;
        if (next < 24 || offset + next > used) throw new IOException("stream query invalid");
        offset += next;
      }
      return streams;
    } finally { Marshal.FreeHGlobal(p); }
  }

  public static void AssertIdentity(Dictionary<string,object> observation, string volumeSerial, string fileId, string reason) {
    if (!String.Equals((string)observation["volumeSerial"], volumeSerial, StringComparison.Ordinal) ||
        !String.Equals((string)observation["fileId"], fileId, StringComparison.Ordinal)) throw new Refusal(reason);
  }

  public static byte[] ReadAll(SafeFileHandle h, int max) {
    long position;
    if (!SetFilePointerEx(h, 0, out position, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    var output = new MemoryStream(); byte[] buf = new byte[65536];
    try {
      while (true) {
        uint n;
        if (!ReadFile(h, buf, (uint)buf.Length, out n, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (n == 0) break;
        if (output.Length + n > max) throw new IOException("file too large");
        output.Write(buf, 0, (int)n);
      }
      return output.ToArray();
    } finally { Array.Clear(buf, 0, buf.Length); output.Dispose(); }
  }

  public static void WriteAll(SafeFileHandle h, byte[] content) {
    long position;
    if (!SetFilePointerEx(h, 0, out position, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    int offset = 0;
    while (offset < content.Length) {
      int chunk = Math.Min(65536, content.Length - offset);
      byte[] slice = new byte[chunk];
      Array.Copy(content, offset, slice, 0, chunk);
      uint written;
      bool ok = WriteFile(h, slice, (uint)chunk, out written, IntPtr.Zero);
      Array.Clear(slice, 0, slice.Length);
      if (!ok || written != chunk) throw new IOException("write failed");
      offset += chunk;
    }
    if (!FlushFileBuffers(h)) throw new IOException("flush failed");
  }

  public static void RenameOverEntry(SafeFileHandle file, SafeFileHandle parent, string name, bool replaceExisting) {
    byte[] chars = Encoding.Unicode.GetBytes(name);
    int total = 20 + chars.Length + 2;
    IntPtr buffer = Marshal.AllocHGlobal(total);
    try {
      for (int i = 0; i < total; i++) Marshal.WriteByte(buffer, i, 0);
      uint flags = FILE_RENAME_POSIX_SEMANTICS | (replaceExisting ? FILE_RENAME_REPLACE_IF_EXISTS : 0);
      Marshal.WriteInt32(buffer, 0, (int)flags);
      Marshal.WriteIntPtr(buffer, 8, parent.DangerousGetHandle());
      Marshal.WriteInt32(buffer, 16, chars.Length);
      Marshal.Copy(chars, 0, IntPtr.Add(buffer, 20), chars.Length);
      IO_STATUS_BLOCK ios;
      int status = NtSetInformationFile(file.DangerousGetHandle(), out ios, buffer, (uint)(20 + chars.Length), FileRenameInformationExClass);
      if (status == STATUS_INVALID_INFO_CLASS || status == STATUS_NOT_SUPPORTED || status == STATUS_INVALID_PARAMETER)
        throw new Refusal("posix_semantics_unsupported");
      if (status == STATUS_OBJECT_NAME_COLLISION) throw new Refusal("presence_conflict");
      if (status < 0) throw new IOException("rename failed");
    } finally { Marshal.FreeHGlobal(buffer); }
  }

  public static void DeleteByHandle(SafeFileHandle file) {
    IntPtr buffer = Marshal.AllocHGlobal(4);
    try {
      Marshal.WriteInt32(buffer, 0, (int)(FILE_DISPOSITION_DELETE | FILE_DISPOSITION_POSIX_SEMANTICS));
      IO_STATUS_BLOCK ios;
      int status = NtSetInformationFile(file.DangerousGetHandle(), out ios, buffer, 4, FileDispositionInformationExClass);
      if (status == STATUS_INVALID_INFO_CLASS || status == STATUS_NOT_SUPPORTED || status == STATUS_INVALID_PARAMETER)
        throw new Refusal("posix_semantics_unsupported");
      if (status < 0) throw new IOException("delete failed");
    } finally { Marshal.FreeHGlobal(buffer); }
  }

  public static void TryDeleteByHandle(SafeFileHandle file) {
    try { DeleteByHandle(file); } catch {}
  }

  public static string Sha256Hex(byte[] content) {
    using (var sha = SHA256.Create()) { return Hex(sha.ComputeHash(content)); }
  }

  public static bool IsNotFound(int status) { return status == STATUS_OBJECT_NAME_NOT_FOUND; }
  public static bool IsKindConflict(int status) {
    return status == STATUS_FILE_IS_A_DIRECTORY || status == STATUS_NOT_A_DIRECTORY;
  }
  public static uint EntryReadAccess() { return FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE; }
  public static uint EntryReadDeleteAccess() { return EntryReadAccess() | DELETE; }
  public static uint EntryWriteAccess() {
    return FILE_READ_DATA | FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES |
      READ_CONTROL | SYNCHRONIZE | DELETE;
  }
  public static uint EntryOptions() {
    return FILE_SYNCHRONOUS_IO_NONALERT | FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT;
  }
  public static string TempName() { return ".goatgoverned-" + Guid.NewGuid().ToString("N") + ".tmp"; }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
function Frame([object]$value) { $json=$value|ConvertTo-Json -Depth 20 -Compress; $bytes=[Text.Encoding]::UTF8.GetBytes($json); [Console]::Out.Write($bytes.Length.ToString()+[char]10+[Convert]::ToBase64String($bytes)+[char]10) }
function SplitParent([string]$relative) {
  $segments=$relative -split '/'
  $name=$segments[$segments.Count-1]
  $parent=if($segments.Count -gt 1){($segments[0..($segments.Count-2)]) -join '/'}else{''}
  return @($parent,$name)
}
$operation='unknown'
try {
  $lengthLine=[Console]::In.ReadLine(); $encoded=[Console]::In.ReadLine(); if($null -eq $lengthLine -or $null -eq $encoded){throw 'frame'}
  $bytes=[Convert]::FromBase64String($encoded); if($bytes.Length -ne [int]$lengthLine -or $bytes.Length -gt 2162688){throw 'frame'}
  $request=[Text.Encoding]::UTF8.GetString($bytes)|ConvertFrom-Json
  if($request.schemaVersion -ne '${SCHEMA_VERSION}'){throw 'schema'}
  $operation=[string]$request.operation
  $parts=SplitParent([string]$request.relativePath)
  $parentRelative=$parts[0]; $entryName=$parts[1]
  $maxBytes=[int]$request.maxBytes
  $readAccess=[GoatGovernedFileMutation]::EntryReadAccess()
  $readDeleteAccess=[GoatGovernedFileMutation]::EntryReadDeleteAccess()
  $writeAccess=[GoatGovernedFileMutation]::EntryWriteAccess()
  $entryOptions=[GoatGovernedFileMutation]::EntryOptions()
  if($operation -eq 'capture'){
    $walk=[GoatGovernedFileMutation+ParentWalk]::new([string]$request.rootPath,$parentRelative,$false)
    try {
      $parentBefore=[GoatGovernedFileMutation]::Observe($walk.Parent)
      $status=0
      $entry=[GoatGovernedFileMutation]::TryOpenRelative($walk.Parent,$entryName,$readAccess,1,$entryOptions,[ref]$status)
      if($null -eq $entry){
        if(-not [GoatGovernedFileMutation]::IsNotFound($status)){
          if([GoatGovernedFileMutation]::IsKindConflict($status)){ throw [GoatGovernedFileMutation+Refusal]::new('entry_kind_invalid') }
          throw 'open'
        }
        $parentAfter=[GoatGovernedFileMutation]::Observe($walk.Parent)
        [GoatGovernedFileMutation]::AssertIdentity($parentAfter,[string]$parentBefore['volumeSerial'],[string]$parentBefore['fileId'],'parent_identity_changed')
        Frame @{schemaVersion='${SCHEMA_VERSION}';operation='capture';status='ok';rootPath=$request.rootPath;relativePath=$request.relativePath;parentBefore=$parentBefore;parentAfter=$parentAfter;present=$false;entry=$null;contentBase64='';sha256=''}
      } else {
        try {
          [GoatGovernedFileMutation]::AssertPlainRegularEntry($entry)
          $entryBefore=[GoatGovernedFileMutation]::Observe($entry)
          $content=[GoatGovernedFileMutation]::ReadAll($entry,$maxBytes)
          $entryAfter=[GoatGovernedFileMutation]::Observe($entry)
          [GoatGovernedFileMutation]::AssertIdentity($entryAfter,[string]$entryBefore['volumeSerial'],[string]$entryBefore['fileId'],'entry_identity_changed')
          if([long]$entryAfter['sizeBytes'] -ne $content.Length){ throw [GoatGovernedFileMutation+Refusal]::new('entry_identity_changed') }
          $parentAfter=[GoatGovernedFileMutation]::Observe($walk.Parent)
          [GoatGovernedFileMutation]::AssertIdentity($parentAfter,[string]$parentBefore['volumeSerial'],[string]$parentBefore['fileId'],'parent_identity_changed')
          $sha=[GoatGovernedFileMutation]::Sha256Hex($content)
          Frame @{schemaVersion='${SCHEMA_VERSION}';operation='capture';status='ok';rootPath=$request.rootPath;relativePath=$request.relativePath;parentBefore=$parentBefore;parentAfter=$parentAfter;present=$true;entry=$entryAfter;contentBase64=[Convert]::ToBase64String($content);sha256=$sha}
          [Array]::Clear($content,0,$content.Length)
        } finally { $entry.Dispose() }
      }
    } finally { $walk.Dispose() }
  } elseif($operation -eq 'publish'){
    $newContent=[Convert]::FromBase64String([string]$request.contentBase64)
    if($newContent.Length -lt 1 -or $newContent.Length -gt $maxBytes){throw 'content'}
    $expectPresent=[bool]$request.expectedPriorPresent
    $walk=[GoatGovernedFileMutation+ParentWalk]::new([string]$request.rootPath,$parentRelative,$true)
    try {
      $parentBefore=[GoatGovernedFileMutation]::Observe($walk.Parent)
      [GoatGovernedFileMutation]::AssertIdentity($parentBefore,[string]$request.expectedParentVolumeSerial,[string]$request.expectedParentFileId,'parent_identity_changed')
      $priorSha=''
      $status=0
      $entry=[GoatGovernedFileMutation]::TryOpenRelative($walk.Parent,$entryName,$readDeleteAccess,1,$entryOptions,[ref]$status)
      if($null -eq $entry){
        if(-not [GoatGovernedFileMutation]::IsNotFound($status)){
          if([GoatGovernedFileMutation]::IsKindConflict($status)){ throw [GoatGovernedFileMutation+Refusal]::new('entry_kind_invalid') }
          throw 'open'
        }
        if($expectPresent){ throw [GoatGovernedFileMutation+Refusal]::new('presence_conflict') }
      } else {
        if(-not $expectPresent){ $entry.Dispose(); throw [GoatGovernedFileMutation+Refusal]::new('presence_conflict') }
      }
      $temp=$null
      try {
        if($null -ne $entry){
          [GoatGovernedFileMutation]::AssertPlainRegularEntry($entry)
          $prior=[GoatGovernedFileMutation]::ReadAll($entry,$maxBytes)
          $priorSha=[GoatGovernedFileMutation]::Sha256Hex($prior)
          [Array]::Clear($prior,0,$prior.Length)
          if($priorSha -cne [string]$request.expectedPriorSha256){ throw [GoatGovernedFileMutation+Refusal]::new('precondition_drift') }
        }
        $tempName=[GoatGovernedFileMutation]::TempName()
        $temp=[GoatGovernedFileMutation]::OpenRelative($walk.Parent,$tempName,$writeAccess,2,$entryOptions)
        $renamed=$false
        try {
          [GoatGovernedFileMutation]::WriteAll($temp,$newContent)
          [GoatGovernedFileMutation]::RenameOverEntry($temp,$walk.Parent,$entryName,$expectPresent)
          $renamed=$true
        } finally {
          if(-not $renamed -and $null -ne $temp){ [GoatGovernedFileMutation]::TryDeleteByHandle($temp) }
        }
        try {
          $published=[GoatGovernedFileMutation]::Observe($temp)
          $verifyStatus=0
          $reopened=[GoatGovernedFileMutation]::TryOpenWitness($walk.Parent,$entryName,[ref]$verifyStatus)
          if($null -eq $reopened){ throw [GoatGovernedFileMutation+Refusal]::new('uncertain:entry_witness_missing') }
          try {
            $witness=[GoatGovernedFileMutation]::Observe($reopened)
            if(([string]$witness['volumeSerial']) -cne ([string]$published['volumeSerial']) -or ([string]$witness['fileId']) -cne ([string]$published['fileId'])){
              throw [GoatGovernedFileMutation+Refusal]::new('uncertain:entry_witness_mismatch')
            }
          } finally { $reopened.Dispose() }
          $parentAfter=[GoatGovernedFileMutation]::Observe($walk.Parent)
          if(([string]$parentAfter['volumeSerial']) -cne ([string]$parentBefore['volumeSerial']) -or ([string]$parentAfter['fileId']) -cne ([string]$parentBefore['fileId'])){
            throw [GoatGovernedFileMutation+Refusal]::new('uncertain:parent_witness_mismatch')
          }
          $publishedSha=[GoatGovernedFileMutation]::Sha256Hex($newContent)
          $priorShaOut=if($expectPresent){$priorSha}else{''}
          Frame @{schemaVersion='${SCHEMA_VERSION}';operation='publish';status='ok';rootPath=$request.rootPath;relativePath=$request.relativePath;parentBefore=$parentBefore;parentAfter=$parentAfter;priorPresent=$expectPresent;priorSha256=$priorShaOut;published=$published;publishedSha256=$publishedSha}
        } catch [GoatGovernedFileMutation+Refusal] {
          $reason=$_.Exception.Message
          if($reason.StartsWith('uncertain:')){
            Frame @{schemaVersion='${SCHEMA_VERSION}';operation='publish';status='uncertain';reason=$reason.Substring(10)}
          } else { throw }
        }
      } finally {
        if($null -ne $temp){ $temp.Dispose() }
        if($null -ne $entry){ $entry.Dispose() }
        [Array]::Clear($newContent,0,$newContent.Length)
      }
    } finally { $walk.Dispose() }
  } elseif($operation -eq 'remove'){
    $walk=[GoatGovernedFileMutation+ParentWalk]::new([string]$request.rootPath,$parentRelative,$true)
    try {
      $parentBefore=[GoatGovernedFileMutation]::Observe($walk.Parent)
      [GoatGovernedFileMutation]::AssertIdentity($parentBefore,[string]$request.expectedParentVolumeSerial,[string]$request.expectedParentFileId,'parent_identity_changed')
      $status=0
      $entry=[GoatGovernedFileMutation]::TryOpenRelative($walk.Parent,$entryName,$readDeleteAccess,1,$entryOptions,[ref]$status)
      if($null -eq $entry){
        if([GoatGovernedFileMutation]::IsNotFound($status)){ throw [GoatGovernedFileMutation+Refusal]::new('presence_conflict') }
        if([GoatGovernedFileMutation]::IsKindConflict($status)){ throw [GoatGovernedFileMutation+Refusal]::new('entry_kind_invalid') }
        throw 'open'
      }
      try {
        [GoatGovernedFileMutation]::AssertPlainRegularEntry($entry)
        $prior=[GoatGovernedFileMutation]::ReadAll($entry,$maxBytes)
        $priorSha=[GoatGovernedFileMutation]::Sha256Hex($prior)
        [Array]::Clear($prior,0,$prior.Length)
        if($priorSha -cne [string]$request.expectedPriorSha256){ throw [GoatGovernedFileMutation+Refusal]::new('precondition_drift') }
        [GoatGovernedFileMutation]::DeleteByHandle($entry)
        $verifyStatus=0
        $reopened=[GoatGovernedFileMutation]::TryOpenWitness($walk.Parent,$entryName,[ref]$verifyStatus)
        if($null -ne $reopened){
          $reopened.Dispose()
          Frame @{schemaVersion='${SCHEMA_VERSION}';operation='remove';status='uncertain';reason='entry_witness_present'}
        } else {
          $parentAfter=[GoatGovernedFileMutation]::Observe($walk.Parent)
          if(([string]$parentAfter['volumeSerial']) -cne ([string]$parentBefore['volumeSerial']) -or ([string]$parentAfter['fileId']) -cne ([string]$parentBefore['fileId'])){
            Frame @{schemaVersion='${SCHEMA_VERSION}';operation='remove';status='uncertain';reason='parent_witness_mismatch'}
          } else {
            Frame @{schemaVersion='${SCHEMA_VERSION}';operation='remove';status='ok';rootPath=$request.rootPath;relativePath=$request.relativePath;parentBefore=$parentBefore;parentAfter=$parentAfter;priorSha256=$priorSha}
          }
        }
      } finally { $entry.Dispose() }
    } finally { $walk.Dispose() }
  } else { throw 'operation' }
} catch [GoatGovernedFileMutation+Refusal] {
  $reason=$_.Exception.Message
  if($reason.StartsWith('uncertain:')){
    Frame @{schemaVersion='${SCHEMA_VERSION}';operation=$operation;status='uncertain';reason=$reason.Substring(10)}
  } else {
    Frame @{schemaVersion='${SCHEMA_VERSION}';operation=$operation;status='refused';reason=$reason}
  }
} catch { exit 73 }
`;
}
