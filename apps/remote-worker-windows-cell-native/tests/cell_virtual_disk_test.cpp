#include "cell_virtual_disk.hpp"
#include "cell_security.hpp"
#include <aclapi.h>
#include <sddl.h>
#include <bcrypt.h>
#include <atomic>
#include <array>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <thread>

using namespace goatcitadel::worker_cell;
unsigned RunCellVirtualDiskAttachmentTests(CellVirtualDiskFile& source, CellWorkspaceDirectories& roots, bool live);
namespace {
struct Handle final { HANDLE value = nullptr; ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); } };
struct Descriptor final { void* value = nullptr; ~Descriptor() { if (value) LocalFree(value); } };
unsigned checks = 0;
bool recovery_process_verified = false;
void Check(bool condition, const char* message) {
  ++checks;
  if (!condition) throw std::runtime_error(std::string(message) + " (virtual disk check " + std::to_string(checks) + ")");
}
CellVirtualDiskSpec Spec() {
  CellVirtualDiskSpec value;
  if (BCryptGenRandom(nullptr, reinterpret_cast<PUCHAR>(&value.identifier), sizeof(value.identifier),
      BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) throw std::runtime_error("Virtual disk fixture GUID generation failed.");
  value.virtual_bytes = 16ULL * 1024 * 1024;
  value.reserved_file_bytes = 80ULL * 1024 * 1024;
  return value;
}
std::wstring CellName() {
  const auto spec = Spec();
  std::wstring name = L"gc-cell-";
  const auto* bytes = reinterpret_cast<const std::uint8_t*>(&spec.identifier);
  constexpr wchar_t hex[] = L"0123456789abcdef";
  for (std::size_t i = 0; i < sizeof(GUID); ++i) { name += hex[bytes[i] >> 4]; name += hex[bytes[i] & 15]; }
  return name;
}
std::vector<std::uint8_t> FileSecurity(const std::wstring& user) {
  Descriptor value;
  const std::wstring sddl = L"O:" + user + L"G:" + user + L"D:P(A;;FA;;;SY)" +
    (user == L"S-1-5-18" ? L"" : L"(A;;FA;;;" + user + L")") +
    L"(A;;RC;;;OW)S:(ML;;NW;;;ME)";
  Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &value.value, nullptr),
    "build independent expected backing-file descriptor");
  const auto* bytes = static_cast<const std::uint8_t*>(value.value);
  return {bytes, bytes + GetSecurityDescriptorLength(value.value)};
}
CellFileSha256 BackingDigest(const std::wstring& path) {
  Handle file{CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
    nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  LARGE_INTEGER size{};
  Check(file.value != INVALID_HANDLE_VALUE && GetFileSizeEx(file.value, &size) && size.QuadPart > 0 &&
    size.QuadPart <= 80LL * 1024 * 1024, "bounded independent fixture read opens the backing file");
  std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size.QuadPart));
  DWORD count = 0;
  Check(ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr) && count == bytes.size(),
    "read complete owned backing-file bytes for independent mutation detection");
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  Check(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0,
    "open independent fixture digest provider");
  CellFileSha256 digest{};
  const auto status = BCryptHash(algorithm, nullptr, 0, bytes.data(), static_cast<ULONG>(bytes.size()),
    digest.data(), static_cast<ULONG>(digest.size()));
  BCryptCloseAlgorithmProvider(algorithm, 0);
  Check(status >= 0, "hash complete owned backing file");
  return digest;
}
bool SameRecord(const CellVirtualDiskRecord& left, const CellVirtualDiskRecord& right) {
  return std::memcmp(&left.spec.identifier, &right.spec.identifier, sizeof(GUID)) == 0 &&
    left.spec.virtual_bytes == right.spec.virtual_bytes && left.spec.reserved_file_bytes == right.spec.reserved_file_bytes &&
    left.control == right.control && left.backing == right.backing;
}
// Fixed test-only metadata, passed to a new process without inheriting handles.
// Production still needs its canonical provisioning journal and service authority.
constexpr std::size_t fixture_record_bytes = 176;
std::wstring FixtureRecord(const CellWorkspaceIdentities& workspace, const CellVirtualDiskRecord& disk) {
  std::vector<std::uint8_t> bytes;
  const auto integer = [&](std::uint64_t value) { for (unsigned i = 0; i < 8; ++i) bytes.push_back(static_cast<std::uint8_t>(value >> (i * 8))); };
  const auto identity = [&](const CellFileIdentity& value) {
    integer(value.volume_serial); bytes.insert(bytes.end(), value.file_id.begin(), value.file_id.end());
  };
  identity(workspace.parent);
  for (const auto& value : workspace.directories) identity(value);
  identity(disk.backing);
  const auto* guid = reinterpret_cast<const std::uint8_t*>(&disk.spec.identifier);
  bytes.insert(bytes.end(), guid, guid + sizeof(GUID));
  integer(disk.spec.virtual_bytes); integer(disk.spec.reserved_file_bytes);
  Check(bytes.size() == fixture_record_bytes && disk.control == workspace.directories[1], "serialize the exact independent fixture records");
  constexpr wchar_t hex[] = L"0123456789abcdef";
  std::wstring text;
  for (const auto byte : bytes) { text += hex[byte >> 4]; text += hex[byte & 15]; }
  return text;
}
void FreshProcessRecovery(CellWorkspaceDirectories& roots, HANDLE parent, const std::wstring& user,
                          const CellVirtualDiskRecord& disk) {
  CellWorkspaceIdentities workspace;
  Check(roots.RecordIdentities(&workspace) == ERROR_SUCCESS, "capture workspace identity for the fresh process");
  const auto root_path = roots.DirectoryPath(CellDirectory::root);
  const auto separator = root_path.find_last_of(L'\\');
  const auto parent_path = root_path.substr(0, separator), cell_name = root_path.substr(separator + 1);
  const auto metadata = FixtureRecord(workspace, disk);
  std::array<wchar_t, 32768> module{};
  const DWORD length = GetModuleFileNameW(nullptr, module.data(), static_cast<DWORD>(module.size()));
  Check(length > 0 && length < module.size(), "locate the exact already-running native fixture image");
  const std::wstring image(module.data(), length);
  auto command = L"\"" + image + L"\" --recorded-disk \"" + parent_path + L"\" " + cell_name + L" " + user + L" " + metadata;
  // The disk's create/inspection handles are already closed. Release these roots
  // too, so the child must obtain and verify all of its own object references.
  roots.Close();
  STARTUPINFOW startup{sizeof(startup)};
  PROCESS_INFORMATION process{};
  Check(CreateProcessW(image.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
    nullptr, nullptr, &startup, &process), "start exact native recovery fixture without inherited handles");
  Handle child{process.hProcess}, thread{process.hThread};
  const DWORD waited = WaitForSingleObject(child.value, 10000);
  if (waited != WAIT_OBJECT_0) {
    TerminateProcess(child.value, 99);
    Check(WaitForSingleObject(child.value, 5000) == WAIT_OBJECT_0, "join only the owned recovery fixture after timeout");
  }
  DWORD exit_code = 1;
  Check(waited == WAIT_OBJECT_0 && GetExitCodeProcess(child.value, &exit_code) && exit_code == 0,
    "a fresh process reopens and verifies the exact workspace and disk records");
  Check(roots.OpenRecorded(parent, workspace, cell_name, user, user) == ERROR_SUCCESS,
    "the original fixture also reacquires its independently recorded workspace");
  recovery_process_verified = true;
}
}

bool CellVirtualDiskRecoveryProcessVerified() { return recovery_process_verified; }
int RunCellVirtualDiskRecoveryFixture(int argc, wchar_t** argv) {
  if (argc != 6 || wcslen(argv[5]) != fixture_record_bytes * 2) return 2;
  std::array<std::uint8_t, fixture_record_bytes> bytes{};
  const auto digit = [](wchar_t value) -> int {
    if (value >= L'0' && value <= L'9') return value - L'0';
    if (value >= L'a' && value <= L'f') return value - L'a' + 10;
    return -1;
  };
  for (std::size_t i = 0; i < bytes.size(); ++i) {
    const int high = digit(argv[5][2 * i]), low = digit(argv[5][2 * i + 1]);
    if (high < 0 || low < 0) return 2;
    bytes[i] = static_cast<std::uint8_t>((high << 4) | low);
  }
  std::size_t offset = 0;
  const auto integer = [&]() {
    std::uint64_t value = 0;
    for (unsigned i = 0; i < 8; ++i) value |= static_cast<std::uint64_t>(bytes[offset++]) << (i * 8);
    return value;
  };
  const auto identity = [&]() {
    CellFileIdentity value;
    value.volume_serial = integer();
    for (auto& byte : value.file_id) byte = bytes[offset++];
    return value;
  };
  CellWorkspaceIdentities recorded;
  recorded.parent = identity();
  for (auto& value : recorded.directories) value = identity();
  CellVirtualDiskRecord disk;
  disk.control = recorded.directories[1]; disk.backing = identity();
  std::memcpy(&disk.spec.identifier, bytes.data() + offset, sizeof(GUID)); offset += sizeof(GUID);
  disk.spec.virtual_bytes = integer(); disk.spec.reserved_file_bytes = integer();
  if (offset != bytes.size()) return 2;
  Handle parent{CreateFileW(argv[2], FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  CellWorkspaceDirectories workspace;
  if (parent.value == INVALID_HANDLE_VALUE || workspace.OpenRecorded(parent.value, recorded, argv[3], argv[4], argv[4])) return 3;
  CellVirtualDiskFile reopened;
  CellVirtualDiskRecord actual;
  if (reopened.OpenRecorded(workspace, disk, 10000) || reopened.CreationAttempted() || !reopened.Ready() ||
      reopened.RecordIdentity(workspace, &actual) || !SameRecord(actual, disk)) return 4;
  return 0;
}

unsigned RunCellVirtualDiskTests(CellWorkspaceDirectories& roots, HANDLE parent,
                                const CellFileIdentity& parent_identity, const std::wstring& user,
                                unsigned& attachment_checks, bool live_attachment) {
  checks = 0;
  recovery_process_verified = false;
  const auto spec = Spec();
  CellVirtualDiskFile disk;
  Check(!disk.Ready() && !disk.CreationAttempted() && disk.Verify(roots) == ERROR_INVALID_STATE,
    "uncreated backing file cannot claim verification");
  CellVirtualDiskRecord record{spec, {1, {1}}, {1, {2}}};
  Check(disk.RecordIdentity(roots, &record) == ERROR_INVALID_STATE && SameRecord(record, {}),
    "failed record capture clears all output");
  std::array<CellVirtualDiskSpec, 6> invalid{spec, spec, spec, spec, spec, spec};
  invalid[0].identifier = {};
  invalid[1].virtual_bytes = 0;
  invalid[2].virtual_bytes += 512;
  invalid[3].reserved_file_bytes = spec.virtual_bytes;
  invalid[4].virtual_bytes = 1ULL << 40;
  invalid[5].reserved_file_bytes = (1ULL << 40) + 1;
  for (const auto& value : invalid)
    Check(disk.Create(roots, value, 10000) == ERROR_INVALID_PARAMETER && !disk.CreationAttempted(),
      "invalid frozen capacity or identity is refused before submission");
  for (const DWORD limit : {0UL, 600001UL})
    Check(disk.Create(roots, spec, limit) == ERROR_INVALID_PARAMETER && !disk.CreationAttempted(),
      "invalid provisioning wall limit is refused");
  Handle cancel{CreateEventW(nullptr, TRUE, TRUE, nullptr)};
  Check(cancel.value != nullptr && disk.Create(roots, spec, 10000, cancel.value) == ERROR_CANCELLED &&
    !disk.CreationAttempted(), "preexisting cancellation submits no virtual-disk operation");
  Check(disk.Create(roots, spec, 10000, INVALID_HANDLE_VALUE) == ERROR_INVALID_HANDLE &&
    !disk.CreationAttempted(), "invalid control handle cannot authorize creation");
  Check(disk.Create(roots, spec, 10000, GetCurrentThread()) == ERROR_INVALID_HANDLE &&
    !disk.CreationAttempted(), "thread pseudo-handle cannot authorize creation");
  const auto path = roots.DirectoryPath(CellDirectory::control) + L"\\cell.vhdx";
  Check(GetFileAttributesW(path.c_str()) == INVALID_FILE_ATTRIBUTES, "rejected inputs create no backing file");
  const DWORD created = disk.Create(roots, spec, 10000);
  if (created) std::fprintf(stderr, "VHDX create error=%lu physical=%llu allocated=%llu\n", created,
    disk.PhysicalBytes(), disk.AllocatedBytes());
  Check(created == ERROR_SUCCESS && disk.Ready() && disk.CreationAttempted(), "create actual fixed protected VHDX");
  Check(disk.RecordIdentity(roots, nullptr) == ERROR_INVALID_PARAMETER, "null record output is refused");
  Check(disk.RecordIdentity(roots, &record) == ERROR_SUCCESS &&
    SameRecord(record, {spec, roots.DirectoryIdentity(CellDirectory::control), disk.Identity()}),
    "capture exact independently verifiable capacity and object identities");
  attachment_checks = RunCellVirtualDiskAttachmentTests(disk, roots, live_attachment);
  Check(disk.Verify(roots) == ERROR_SUCCESS && disk.Ready(), "reverify exact unattached native image");
  Check(disk.PhysicalBytes() >= spec.virtual_bytes && disk.AllocatedBytes() >= disk.PhysicalBytes() &&
    disk.AllocatedBytes() <= spec.reserved_file_bytes, "metadata and host allocation fit the admitted reservation");
  Handle file{CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  Check(file.value != INVALID_HANDLE_VALUE, "independent controller can inspect the created file");
  FILE_ID_INFO id{};
  Check(GetFileInformationByHandleEx(file.value, FileIdInfo, &id, sizeof(id)) &&
    id.VolumeSerialNumber == disk.Identity().volume_serial &&
    std::memcmp(id.FileId.Identifier, disk.Identity().file_id.data(), 16) == 0, "recorded identity matches independent NTFS handle");
  const auto security = FileSecurity(user);
  Check(VerifyCellSecurity(file.value, security) == ERROR_SUCCESS, "backing file has exact protected controller descriptor");
  Check(!MoveFileW(path.c_str(), (path + L".moved").c_str()) && GetLastError() == ERROR_SHARING_VIOLATION,
    "retained backing-file handle prevents rename");
  Check(disk.Create(roots, spec, 10000) == ERROR_ALREADY_INITIALIZED, "one owner cannot submit a second creation");
  CellVirtualDiskFile duplicate;
  const DWORD duplicate_error = duplicate.Create(roots, spec, 10000);
  Check(duplicate_error != ERROR_SUCCESS && !duplicate.Ready(), "second owner refuses existing VHDX");
  Check(disk.Verify(roots) == ERROR_SUCCESS, "collision preserves original admitted image");
  CellWorkspaceDirectories unrelated;
  Check(unrelated.Create(parent, parent_identity, CellName(), user, user) == ERROR_SUCCESS, "create distinct owned fixture cell");
  Check(disk.Verify(unrelated) == ERROR_FILE_INVALID && !disk.Ready(), "different valid workspace cannot authorize backing image");
  Check(disk.Verify(roots) == ERROR_SUCCESS, "correct original workspace permits fresh verification");

  Handle editable{CreateFileW(path.c_str(), READ_CONTROL | WRITE_DAC, FILE_SHARE_READ | FILE_SHARE_WRITE,
    nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  Check(editable.value != INVALID_HANDLE_VALUE, "controller obtains descriptor drift fixture handle");
  PACL dacl = nullptr;
  BOOL present = FALSE, ignored = FALSE;
  Check(GetSecurityDescriptorDacl(const_cast<std::uint8_t*>(security.data()), &present, &dacl, &ignored) && present,
    "retain exact DACL for owned fixture restoration");
  Check(SetSecurityInfo(editable.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION,
    nullptr, nullptr, dacl, nullptr) == ERROR_SUCCESS, "controller changes owned backing-file DACL protection");
  Check(disk.Verify(roots) == ERROR_INVALID_SECURITY_DESCR && !disk.Ready(), "backing-file security drift clears readiness");
  auto refused_record = record;
  Check(disk.RecordIdentity(roots, &refused_record) == ERROR_INVALID_SECURITY_DESCR && SameRecord(refused_record, {}),
    "security drift cannot publish a stale record");
  Check(SetSecurityInfo(editable.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
    nullptr, nullptr, dacl, nullptr) == ERROR_SUCCESS && disk.Verify(roots) == ERROR_SUCCESS,
    "exact restored descriptor requires and passes fresh verification");
  const auto retained_identity = disk.Identity();
  disk.Close();
  Check(!disk.Ready() && !disk.CreationAttempted() && GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES,
    "close releases authority while preserving backing file");
  Check(disk.Verify(roots) == ERROR_INVALID_STATE && disk.Create(roots, spec, 10000) != ERROR_SUCCESS && !disk.Ready(),
    "closing does not permit adoption on another create attempt");
  Check(GetFileInformationByHandleEx(file.value, FileIdInfo, &id, sizeof(id)) &&
    std::memcmp(id.FileId.Identifier, retained_identity.file_id.data(), 16) == 0, "retained file identity survives close and refused reuse");
  disk.Close();
  CloseHandle(file.value); file.value = nullptr;
  CloseHandle(editable.value); editable.value = nullptr;
  const auto before_recovery = BackingDigest(path);
  CellVirtualDiskFile recovered;
  std::array<CellVirtualDiskRecord, 7> bad_records{record, record, record, record, record, record, record};
  bad_records[0].control = {};
  bad_records[1].backing = {};
  bad_records[2].backing = record.control;
  bad_records[3].backing.volume_serial ^= 1;
  bad_records[4].spec.identifier = {};
  bad_records[5].spec.virtual_bytes = 0;
  bad_records[6].spec.reserved_file_bytes = spec.virtual_bytes;
  for (const auto& bad : bad_records)
    Check(recovered.OpenRecorded(roots, bad, 10000) == ERROR_INVALID_PARAMETER &&
      !recovered.Ready() && !recovered.CreationAttempted() && recovered.Path().empty(),
      "malformed frozen record cannot open or create a backing file");
  for (const DWORD limit : {0UL, 600001UL})
    Check(recovered.OpenRecorded(roots, record, limit) == ERROR_INVALID_PARAMETER && !recovered.Ready(),
      "invalid recovery deadline is refused before opening");
  Check(recovered.OpenRecorded(roots, record, 10000, cancel.value) == ERROR_CANCELLED && !recovered.Ready(),
    "preexisting cancellation refuses recovery");
  Check(recovered.OpenRecorded(roots, record, 10000, INVALID_HANDLE_VALUE) == ERROR_INVALID_HANDLE && !recovered.Ready(),
    "invalid recovery control handle is refused");
  auto wrong_record = record;
  wrong_record.backing.file_id[0] ^= 1;
  Check(recovered.OpenRecorded(roots, wrong_record, 10000) == ERROR_FILE_INVALID && recovered.Path().empty(),
    "a different recorded file identity is refused and releases its pins");
  wrong_record = record; wrong_record.spec.identifier.Data1 ^= 1;
  Check(recovered.OpenRecorded(roots, wrong_record, 10000) == ERROR_FILE_INVALID && recovered.Path().empty(),
    "the SDK disk identity must match the independently recorded GUID");
  wrong_record = record; wrong_record.spec.virtual_bytes += 2ULL * 1024 * 1024;
  wrong_record.spec.reserved_file_bytes += 2ULL * 1024 * 1024;
  Check(recovered.OpenRecorded(roots, wrong_record, 10000) != ERROR_SUCCESS && recovered.Path().empty(),
    "a valid but different capacity record cannot authorize the image");
  Check(recovered.OpenRecorded(unrelated, record, 10000) == ERROR_FILE_INVALID && recovered.Path().empty(),
    "another verified workspace cannot adopt the recorded disk");
  const DWORD reopened = recovered.OpenRecorded(roots, record, 10000);
  if (reopened) std::fprintf(stderr, "VHDX recorded open error=%lu\n", reopened);
  Check(reopened == ERROR_SUCCESS && recovered.Ready() && !recovered.CreationAttempted() &&
    recovered.Identity() == retained_identity, "a new owner reopens the exact unattached recorded disk");
  Check(recovered.RecordIdentity(roots, &refused_record) == ERROR_SUCCESS && SameRecord(refused_record, record),
    "fresh inspection reproduces the original record");
  Check(recovered.OpenRecorded(roots, record, 10000) == ERROR_ALREADY_INITIALIZED &&
    recovered.Create(roots, spec, 10000) == ERROR_ALREADY_INITIALIZED && !recovered.CreationAttempted(),
    "a retained inspection owner cannot be reinitialized or create another disk");
  Check(!MoveFileW(path.c_str(), (path + L".unexpected").c_str()) && GetLastError() == ERROR_SHARING_VIOLATION,
    "recovered file pins prevent path substitution");
  recovered.Close();
  Check(BackingDigest(path) == before_recovery, "successful and rejected recovery leave exact VHDX bytes unchanged");
  const auto retained_path = path + L".recorded", replacement_path = path + L".replacement";
  Check(MoveFileW(path.c_str(), retained_path.c_str()), "release all pins and retain the original owned image");
  Check(recovered.OpenRecorded(roots, record, 10000) == ERROR_FILE_NOT_FOUND && !recovered.Ready() &&
    GetFileAttributesW(path.c_str()) == INVALID_FILE_ATTRIBUTES, "missing recorded disk is never recreated");
  Check(CopyFileW(retained_path.c_str(), path.c_str(), TRUE), "place a byte-identical owned copy at the recorded name");
  {
    Handle replacement{CreateFileW(path.c_str(), READ_CONTROL | WRITE_DAC | WRITE_OWNER,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
    PACL label = nullptr;
    Check(replacement.value != INVALID_HANDLE_VALUE &&
      GetSecurityDescriptorSacl(const_cast<std::uint8_t*>(security.data()), &present, &label, &ignored) && present &&
      SetSecurityInfo(replacement.value, SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
        nullptr, nullptr, dacl, label) == ERROR_SUCCESS && VerifyCellSecurity(replacement.value, security) == ERROR_SUCCESS,
      "give only the copied fixture the exact expected controller permissions and integrity label");
    Check(GetFileInformationByHandleEx(replacement.value, FileIdInfo, &id, sizeof(id)) &&
      std::memcmp(id.FileId.Identifier, record.backing.file_id.data(), 16) != 0,
      "independent NTFS observation proves the identical copy is a different object");
  }
  Check(BackingDigest(path) == before_recovery, "replacement fixture has identical VHDX bytes and embedded GUID");
  Check(recovered.OpenRecorded(roots, record, 10000) == ERROR_FILE_INVALID && !recovered.Ready() && recovered.Path().empty(),
    "identical replacement bytes do not substitute for the recorded NTFS object");
  Check(MoveFileW(path.c_str(), replacement_path.c_str()) && MoveFileW(retained_path.c_str(), path.c_str()),
    "failed recovery releases pins and preserves both controlled images");
  Check(recovered.OpenRecorded(roots, record, 10000) == ERROR_SUCCESS && recovered.Verify(roots) == ERROR_SUCCESS,
    "the restored exact recorded object requires fresh verification");
  recovered.Close();
  {
    Handle drift{CreateFileW(path.c_str(), READ_CONTROL | WRITE_DAC, FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
    Check(drift.value != INVALID_HANDLE_VALUE &&
      SetSecurityInfo(drift.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION,
        nullptr, nullptr, dacl, nullptr) == ERROR_SUCCESS, "change only the owned recovery fixture descriptor");
    Check(recovered.OpenRecorded(roots, record, 10000) == ERROR_INVALID_SECURITY_DESCR && !recovered.Ready(),
      "reopening refuses security drift instead of repairing it");
    Check(VerifyCellSecurity(drift.value, security) == ERROR_INVALID_SECURITY_DESCR,
      "refused recovery leaves drifted security unchanged");
    Check(SetSecurityInfo(drift.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
      nullptr, nullptr, dacl, nullptr) == ERROR_SUCCESS, "restore the exact owned fixture descriptor");
  }
  Check(recovered.OpenRecorded(roots, record, 10000) == ERROR_SUCCESS, "explicitly restored custody permits fresh inspection");
  recovered.Close();
  FreshProcessRecovery(roots, parent, user, record);
  Check(BackingDigest(path) == before_recovery, "record recovery never changes or deletes backing contents");

  // A submitted fixed allocation is cancelled after its file becomes visible.
  // The native owner must join that exact operation before its stack/event dies.
  auto large = Spec();
  large.virtual_bytes = 256ULL * 1024 * 1024;
  large.reserved_file_bytes = 320ULL * 1024 * 1024;
  const auto pending_path = unrelated.DirectoryPath(CellDirectory::control) + L"\\cell.vhdx";
  Handle pending_cancel{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(pending_cancel.value != nullptr, "create pending allocation cancellation event");
  std::atomic<bool> finished{false}, observed{false};
  std::thread canceller([&] {
    while (!finished.load()) {
      if (GetFileAttributesW(pending_path.c_str()) != INVALID_FILE_ATTRIBUTES) {
        observed.store(true); SetEvent(pending_cancel.value); return;
      }
      Sleep(1);
    }
  });
  CellVirtualDiskFile pending;
  const DWORD cancelled = pending.Create(unrelated, large, 10000, pending_cancel.value);
  finished.store(true); canceller.join();
  Check(observed.load() && pending.CreationAttempted() && cancelled == ERROR_CANCELLED && !pending.Ready(),
    "cancel a real submitted fixed allocation before readiness");
  Check(pending.Verify(unrelated) == ERROR_INVALID_STATE, "cancelled operation cannot be promoted by verification");
  pending.Close();
  Check(unrelated.Verify() == ERROR_SUCCESS, "cancelled allocation preserves protected workspace authority");

  CellWorkspaceDirectories expired;
  Check(expired.Create(parent, parent_identity, CellName(), user, user) == ERROR_SUCCESS,
    "create isolated provisioning deadline fixture");
  CellVirtualDiskFile timed;
  Check(timed.Create(expired, large, 1) == ERROR_TIMEOUT && !timed.Ready() &&
    timed.Verify(expired) == ERROR_INVALID_STATE, "expired preparation or allocation cannot produce readiness");
  timed.Close();
  Check(expired.Verify() == ERROR_SUCCESS, "expiry preserves existing protected directory authority");

  CellWorkspaceDirectories occupied;
  Check(occupied.Create(parent, parent_identity, CellName(), user, user) == ERROR_SUCCESS,
    "create independent non-VHD collision fixture");
  const auto occupied_path = occupied.DirectoryPath(CellDirectory::control) + L"\\cell.vhdx";
  Handle sentinel{CreateFileW(occupied_path.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
    nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr)};
  Check(sentinel.value != INVALID_HANDLE_VALUE, "create ordinary file at the intended image name");
  constexpr char marker[] = "existing controlled bytes must survive";
  DWORD written = 0;
  Check(WriteFile(sentinel.value, marker, sizeof(marker), &written, nullptr) && written == sizeof(marker) &&
    FlushFileBuffers(sentinel.value), "retain actual existing file bytes");
  CellVirtualDiskFile refused;
  Check(refused.Create(occupied, spec, 10000) != ERROR_SUCCESS && !refused.Ready(),
    "image creation refuses an existing non-VHD file");
  LARGE_INTEGER start{}, length{};
  DWORD read = 0;
  std::array<char, sizeof(marker)> actual{};
  Check(GetFileSizeEx(sentinel.value, &length) && length.QuadPart == sizeof(marker) &&
    SetFilePointerEx(sentinel.value, start, nullptr, FILE_BEGIN) &&
    ReadFile(sentinel.value, actual.data(), static_cast<DWORD>(actual.size()), &read, nullptr) &&
    read == sizeof(marker) && std::memcmp(actual.data(), marker, sizeof(marker)) == 0,
    "refused creation preserves the exact existing non-VHD file");
  return checks;
}
