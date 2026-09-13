#include "cell_mounted_workspace.hpp"
#include <aclapi.h>
#include <bcrypt.h>
#include <sddl.h>
#include <algorithm>
#include <cstdio>
#include <functional>
#include <stdexcept>

using namespace goatcitadel::worker_cell;
namespace goatcitadel::worker_cell {
struct CellMountedWorkspaceTestPeer final {
  static DWORD Run(CellMountedWorkspace& owner, const CellMountedWorkspaceBinding& binding,
    const CellMountedWorkspaceCommitter& committer, DWORD (*verify)(void*) noexcept,
    DWORD (*create)(void*, CellWorkspaceIdentities*, DWORD (*)(void*) noexcept, void*) noexcept,
    DWORD (*inspect)(void*, const CellWorkspaceIdentities&, bool) noexcept, void* context,
    ULONGLONG deadline, HANDLE cancellation) {
    if (owner.attempted_) return ERROR_ALREADY_INITIALIZED;
    owner.attempted_ = true; owner.state_ = CellMountedWorkspaceState::unknown;
    owner.binding_ = binding; owner.committer_ = committer;
    return owner.Run({verify, create, inspect, context}, deadline, cancellation);
  }
  static DWORD Recover(CellMountedWorkspace& owner, const CellMountedWorkspaceBinding& binding,
    const std::vector<CellMountedWorkspaceCheckpoint>& records, DWORD (*verify)(void*) noexcept,
    DWORD (*inspect)(void*, const CellWorkspaceIdentities&, bool) noexcept, void* context,
    ULONGLONG deadline, HANDLE cancellation) {
    if (owner.attempted_) return ERROR_ALREADY_INITIALIZED;
    owner.attempted_ = true; owner.state_ = CellMountedWorkspaceState::unknown;
    owner.binding_ = binding; owner.records_ = records;
    return owner.Recover({verify, nullptr, inspect, context}, deadline, cancellation, true);
  }
  // No source handles exist. These states exercise native entry-point refusal
  // and consumption only; they cannot attach or acquire a physical volume.
  static void Incomplete(CellVolumeMount& mount, bool fresh, bool attempted = false) {
    mount.state_ = CellVolumeMountState::mounted;
    mount.freshly_mounted_ = fresh; mount.workspace_attempted_ = attempted;
  }
};
}
namespace {
unsigned checks = 0, native_checks = 0;
std::vector<CellMountedWorkspaceCheckpoint> golden;
constexpr wchar_t cell_name[] = L"gc-cell-0123456789abcdef0123456789abcdef";
void Check(bool value, const char* message) {
  ++checks;
  if (!value) throw std::runtime_error(std::string(message) + " (mounted workspace check " +
    std::to_string(checks) + ", Win32 " + std::to_string(GetLastError()) + ")");
}
struct Handle final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
CellMountedWorkspaceBinding Binding() {
  CellMountedWorkspaceBinding binding;
  binding.mount_sha256.fill(0xa1); binding.security_sha256.fill(0xb2);
  binding.volume_root.volume_serial = 0xfedcba9876543210ULL;
  binding.volume_root.file_id.fill(0xc3); binding.cell_name = cell_name;
  return binding;
}
CellWorkspaceIdentities Workspace() {
  CellWorkspaceIdentities value; value.parent = Binding().volume_root;
  for (std::size_t i = 0; i < value.directories.size(); ++i) {
    value.directories[i].volume_serial = value.parent.volume_serial;
    value.directories[i].file_id.fill(static_cast<std::uint8_t>(0xd0 + i));
  }
  return value;
}
struct Fixture final {
  CellMountedWorkspace owner;
  CellWorkspaceIdentities actual = Workspace();
  unsigned authorizations = 0, verifies = 0, inspections = 0, reopens = 0, creates = 0;
  unsigned fail_authorize = 0, fail_verify = 0, fail_inspect = 0, fail_create = 0, fail_commit = 0, bad_ack = 0;
  bool authorized = true;
  std::vector<CellMountedWorkspaceCheckpoint> retained;
  std::function<void(unsigned)> preparing, creating, committing, inspecting;
  static DWORD Authorize(void* raw) noexcept {
    auto& f = *static_cast<Fixture*>(raw);
    return ++f.authorizations == f.fail_authorize || !f.authorized ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
  static DWORD Verify(void* raw) noexcept {
    auto& f = *static_cast<Fixture*>(raw);
    return ++f.verifies == f.fail_verify ? ERROR_FILE_INVALID : ERROR_SUCCESS;
  }
  static DWORD Inspect(void* raw, const CellWorkspaceIdentities& expected, bool reopen) noexcept {
    auto& f = *static_cast<Fixture*>(raw); ++f.inspections; if (reopen) ++f.reopens;
    try { if (f.inspecting) f.inspecting(f.inspections); } catch (...) { return ERROR_GEN_FAILURE; }
    return f.inspections == f.fail_inspect || f.creates != 4 || expected != f.actual ? ERROR_FILE_INVALID : ERROR_SUCCESS;
  }
  static DWORD Commit(void* raw, const CellMountedWorkspaceCheckpoint& record, CellFileSha256* ack) noexcept {
    auto& f = *static_cast<Fixture*>(raw);
    try {
      f.retained.push_back(record); const auto count = static_cast<unsigned>(f.retained.size());
      if (f.committing) f.committing(count);
      if (count == f.fail_commit) return ERROR_TIMEOUT;
      std::copy_n(record.begin() + 480, 32, ack->begin());
      if (count == f.bad_ack) (*ack)[0] ^= 1;
      return ERROR_SUCCESS;
    } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  }
  static DWORD Create(void* raw, CellWorkspaceIdentities* output, DWORD (*guard)(void*) noexcept, void* context) noexcept {
    auto& f = *static_cast<Fixture*>(raw); *output = {};
    try {
      if (f.retained.size() != 1 || f.creates) return ERROR_INVALID_STATE;
      for (unsigned i = 1; i <= 4; ++i) {
        if (f.preparing) f.preparing(i);
        const auto error = guard(context);
        if (error) return error;
        ++f.creates;
        if (f.creating) f.creating(i);
        if (i == f.fail_create) return ERROR_IO_DEVICE;
      }
      *output = f.actual; return ERROR_SUCCESS;
    } catch (...) { return ERROR_GEN_FAILURE; }
  }
  DWORD Run(ULONGLONG deadline = GetTickCount64() + 10000, HANDLE cancellation = nullptr) {
    return CellMountedWorkspaceTestPeer::Run(owner, Binding(), {Commit, Authorize, this}, Verify, Create,
      Inspect, this, deadline, cancellation);
  }
  DWORD Recover(const std::vector<CellMountedWorkspaceCheckpoint>& records,
    const CellMountedWorkspaceBinding& binding = Binding(), HANDLE cancellation = nullptr) {
    creates = 4;
    return CellMountedWorkspaceTestPeer::Recover(owner, binding, records, Verify, Inspect,
      this, GetTickCount64() + 10000, cancellation);
  }
};
void Sequence() {
  Fixture success;
  Check(success.Run() == 0 && success.owner.State() == CellMountedWorkspaceState::recorded &&
    success.creates == 4 && success.inspections == 2 && success.retained.size() == 2, "successful creation retains both records and verifies all roots");
  golden = success.retained;
  std::vector<CellMountedWorkspaceCheckpoint> recorded;
  Check(success.owner.RecordCheckpoints(&recorded) == 0 && recorded == golden, "exact bytes are retained");
  success.owner.Close(); success.owner.Close();
  Check(success.owner.State() == CellMountedWorkspaceState::unknown && success.Run() == ERROR_ALREADY_INITIALIZED &&
    success.creates == 4, "Close never retries or repairs a workspace");
  for (unsigned phase = 1; phase <= 2; ++phase) {
    Fixture f; f.fail_commit = phase;
    Check(f.Run() == ERROR_TIMEOUT && f.retained.size() == phase && f.creates == (phase == 1 ? 0U : 4U) &&
      f.owner.State() == CellMountedWorkspaceState::unknown, "missing ACK stops progress and retains uncertain evidence");
    f.owner.Close(); Check(f.Run() == ERROR_ALREADY_INITIALIZED, "lost ACK cannot restart through Close");
    Fixture wrong; wrong.bad_ack = phase;
    Check(wrong.Run() == ERROR_INVALID_DATA && wrong.creates == (phase == 1 ? 0U : 4U) &&
      wrong.owner.State() == CellMountedWorkspaceState::unknown, "wrong exact ACK never authorizes completion");
  }
  for (unsigned boundary = 1; boundary <= success.authorizations; ++boundary) {
    Fixture f; f.fail_authorize = boundary;
    Check(f.Run() == ERROR_ACCESS_DENIED && f.owner.State() == CellMountedWorkspaceState::unknown,
      "revocation at every authorization boundary prevents completion");
  }
  for (unsigned boundary = 1; boundary <= success.verifies; ++boundary) {
    Fixture f; f.fail_verify = boundary;
    Check(f.Run() == ERROR_FILE_INVALID && f.owner.State() == CellMountedWorkspaceState::unknown,
      "source drift at every readback boundary prevents completion");
  }
  for (unsigned boundary = 1; boundary <= 4; ++boundary) {
    Fixture f; f.preparing = [&](unsigned index) { if (index == boundary) f.authorized = false; };
    Check(f.Run() == ERROR_ACCESS_DENIED && f.creates == boundary - 1 && f.retained.size() == 1,
      "revocation during each create preparation stops before that directory");
    Fixture changed; changed.preparing = [&](unsigned index) { if (index == boundary) changed.fail_verify = changed.verifies + 1; };
    Check(changed.Run() == ERROR_FILE_INVALID && changed.creates == boundary - 1,
      "source change during each create preparation stops before that directory");
    Fixture uncertain; uncertain.fail_create = boundary;
    Check(uncertain.Run() == ERROR_IO_DEVICE && uncertain.creates == boundary && uncertain.retained.size() == 1 &&
      uncertain.owner.State() == CellMountedWorkspaceState::unknown, "uncertain native creation cannot advance to recorded state");
  }
  for (unsigned boundary = 1; boundary <= 2; ++boundary) {
    Fixture f; f.fail_inspect = boundary;
    Check(f.Run() == ERROR_FILE_INVALID && f.owner.State() == CellMountedWorkspaceState::unknown,
      "directory drift on final readbacks prevents completion");
    Fixture revoke; revoke.committing = [&](unsigned phase) { if (phase == boundary) revoke.authorized = false; };
    Check(revoke.Run() == ERROR_ACCESS_DENIED && revoke.creates == (boundary == 1 ? 0U : 4U),
      "revocation while waiting for either ACK is checked before continuing");
  }
  Fixture alias; alias.actual.directories[3] = alias.actual.directories[2];
  Check(alias.Run() == ERROR_FILE_INVALID && alias.retained.size() == 1, "aliased directory results cannot be recorded");
  Fixture foreign; ++foreign.actual.directories[2].volume_serial;
  Check(foreign.Run() == ERROR_FILE_INVALID && foreign.retained.size() == 1, "a foreign-volume directory cannot be recorded");
  Fixture expired;
  Check(expired.Run(GetTickCount64()) == ERROR_TIMEOUT && !expired.authorizations && !expired.creates, "expired deadline prevents all callbacks");
  Fixture invalid;
  Check(invalid.Run(GetTickCount64() + 10000, INVALID_HANDLE_VALUE) == ERROR_INVALID_HANDLE && !invalid.creates,
    "invalid cancellation handle cannot allow creation");
  Fixture thread;
  Check(thread.Run(GetTickCount64() + 10000, GetCurrentThread()) == ERROR_INVALID_HANDLE && !thread.creates,
    "thread pseudo-handle cannot stand in for cancellation");
  Handle cancellation{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(cancellation.value != nullptr, "controlled cancellation event created");
  for (unsigned boundary = 0; boundary <= 7; ++boundary) {
    ResetEvent(cancellation.value); Fixture f;
    if (!boundary) SetEvent(cancellation.value);
    f.creating = [&](unsigned index) { if (index == boundary) SetEvent(cancellation.value); };
    f.committing = [&](unsigned phase) { if (boundary == phase + 4) SetEvent(cancellation.value); };
    f.inspecting = [&](unsigned index) { if (boundary == 7 && index == 2) SetEvent(cancellation.value); };
    Check(f.Run(GetTickCount64() + 10000, cancellation.value) == ERROR_CANCELLED &&
      f.owner.State() == CellMountedWorkspaceState::unknown, "cancellation through mutation, ACK and final readback never reports completion");
  }
}
void Rehash(CellMountedWorkspaceCheckpoint& record) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  Check(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0, "fixture SHA256 provider opened");
  const auto result = BCryptHash(algorithm, nullptr, 0, record.data(), 480, record.data() + 480, 32);
  BCryptCloseAlgorithmProvider(algorithm, 0); Check(result >= 0, "fixture SHA256 computed");
}
void RecordsAndRecovery() {
  CellWorkspaceIdentities output;
  Check(DecodeCellMountedWorkspaceCheckpoints(Binding(), golden, &output) == 0 && output == Workspace(),
    "complete records return all four exact identities");
  const auto prefix = std::span(golden).first(1);
  Check(ValidateCellMountedWorkspaceCheckpointPrefix(Binding(), prefix, &output) == 0 && output == CellWorkspaceIdentities{},
    "intent prefix is inspectable and has no execution identity");
  output = Workspace();
  Check(DecodeCellMountedWorkspaceCheckpoints(Binding(), prefix, &output) == ERROR_IO_INCOMPLETE && output == CellWorkspaceIdentities{},
    "partial decoder clears output and cannot recover");
  for (unsigned count : {0U, 1U, 3U}) {
    auto records = golden; records.resize(count); Fixture f;
    Check(f.Recover(records) != 0 && !f.verifies && !f.inspections, "partial and oversized recovery fail before native reads");
  }
  Check(DecodeCellMountedWorkspaceCheckpoints(Binding(), golden, nullptr) == ERROR_INVALID_PARAMETER, "null decoder output refused");
  for (const auto& mutate : std::vector<std::function<void(CellMountedWorkspaceBinding&)>>{
      [](auto& b) { b.mount_sha256.fill(0); }, [](auto& b) { b.security_sha256.fill(0); },
      [](auto& b) { b.volume_root.volume_serial = 0; }, [](auto& b) { b.volume_root.file_id.fill(0); },
      [](auto& b) { b.cell_name += L"\\escape"; }, [](auto& b) { b.cell_name[8] = L'A'; }}) {
    auto binding = Binding(); mutate(binding); output = Workspace();
    Check(!IsValidCellMountedWorkspaceBinding(binding) && DecodeCellMountedWorkspaceCheckpoints(binding, golden, &output) ==
      ERROR_INVALID_PARAMETER && output == CellWorkspaceIdentities{}, "invalid frozen binding refused with cleared output");
  }
  for (const auto& mutate : std::vector<std::function<void(CellMountedWorkspaceBinding&)>>{
      [](auto& b) { b.mount_sha256[0] ^= 1; }, [](auto& b) { b.security_sha256[0] ^= 1; },
      [](auto& b) { ++b.volume_root.volume_serial; }, [](auto& b) { b.volume_root.file_id[0] ^= 1; },
      [](auto& b) { b.cell_name[8] = L'9'; }}) {
    auto binding = Binding(); mutate(binding); Fixture f;
    Check(f.Recover(golden, binding) != 0 && !f.verifies, "substituted source, policy or name fails before native reads");
  }
  for (std::size_t index = 0; index < 2; ++index) {
    for (std::size_t offset : {0U, 8U, 12U, 16U, 48U, 80U, 112U, 152U, 160U, 176U, 200U, 224U, 248U, 272U, 479U, 480U, 511U}) {
      auto records = golden; records[index][offset] ^= 1; output = Workspace();
      Check(DecodeCellMountedWorkspaceCheckpoints(Binding(), records, &output) != 0 && output == CellWorkspaceIdentities{},
        "changed binding, phase, identity, padding or digest is refused");
    }
    for (std::size_t offset : {0U, 8U, 12U, 16U, 48U, 80U, 112U, 152U, 160U, 272U, 479U}) {
      auto records = golden; records[index][offset] ^= 1; Rehash(records[index]);
      Check(DecodeCellMountedWorkspaceCheckpoints(Binding(), records, &output) != 0,
        "rehashing cannot replace the frozen binding, phase or reserved bytes");
    }
  }
  for (std::size_t index = 0; index < 4; ++index) {
    auto records = golden;
    std::copy_n(records[1].begin() + 152, 24, records[1].begin() + 176 + index * 24); Rehash(records[1]);
    Check(DecodeCellMountedWorkspaceCheckpoints(Binding(), records, &output) != 0, "volume-root aliases cannot be directory records");
    records = golden; records[1][176 + index * 24] ^= 1; Rehash(records[1]);
    Check(DecodeCellMountedWorkspaceCheckpoints(Binding(), records, &output) != 0, "foreign-volume directory records are refused");
    records = golden; records[1][184 + index * 24] ^= 1; Rehash(records[1]); Fixture changed;
    Check(changed.Recover(records) == ERROR_FILE_INVALID && changed.inspections == 1 && !changed.authorizations,
      "a self-consistent changed directory identity still fails actual recovery readback");
  }
  auto swapped = golden; std::swap(swapped[0], swapped[1]);
  Check(DecodeCellMountedWorkspaceCheckpoints(Binding(), swapped, &output) != 0, "reordered checkpoints are refused");
  Fixture recovered;
  Check(recovered.Recover(golden) == 0 && recovered.owner.State() == CellMountedWorkspaceState::recorded &&
    recovered.inspections == 2 && recovered.reopens == 1 && !recovered.authorizations && recovered.retained.empty(),
    "complete recovery reopens once and only verifies recorded objects");
  for (unsigned boundary = 1; boundary <= 2; ++boundary) {
    Fixture f; f.fail_verify = boundary;
    Check(f.Recover(golden) == ERROR_FILE_INVALID && f.owner.State() == CellMountedWorkspaceState::unknown,
      "source drift during read-only recovery prevents completion");
    Fixture changed; changed.fail_inspect = boundary;
    Check(changed.Recover(golden) == ERROR_FILE_INVALID && changed.owner.State() == CellMountedWorkspaceState::unknown,
      "workspace drift during read-only recovery prevents completion");
  }
}
void EntryPoints() {
  CellVolumeMount mount; CellVolumeProtection protection; CellWorkspaceDirectories host; CellMountedWorkspace owner; Fixture f;
  const CellMountedWorkspaceCommitter sink{Fixture::Commit, Fixture::Authorize, &f};
  const auto create = [&](DWORD wall = 10000, HANDLE cancellation = nullptr) {
    return owner.Create(mount, protection, host, L"S-1-5-18", L"S-1-5-18", sink, wall, cancellation);
  };
  Check(create() == ERROR_INVALID_STATE && !f.authorizations, "absent mount cannot reach any native workspace operation");
  Check(create(0) == ERROR_INVALID_PARAMETER && create(600001) == ERROR_INVALID_PARAMETER, "unbounded deadline refused");
  Check(owner.Create(mount, protection, host, L"", L"", {}, 10000) == ERROR_INVALID_PARAMETER, "canonical callbacks are required");
  CellMountedWorkspaceTestPeer::Incomplete(mount, false);
  Check(create() == ERROR_INVALID_STATE && !f.authorizations, "read-only recovered mount cannot authorize fresh directories");
  CellMountedWorkspaceTestPeer::Incomplete(mount, true, true);
  Check(create() == ERROR_INVALID_STATE && !f.authorizations, "consumed mount cannot authorize another workspace");
  CellMountedWorkspaceTestPeer::Incomplete(mount, true);
  Check(create(10000, INVALID_HANDLE_VALUE) == ERROR_INVALID_HANDLE && !f.authorizations, "invalid cancellation refused before consuming sources");
  Check(create() != 0 && owner.State() == CellMountedWorkspaceState::unknown && f.retained.empty(),
    "incomplete mount is consumed without creating anything");
  owner.Close(); Check(create() == ERROR_ALREADY_INITIALIZED, "source refusal cannot be retried through Close");
  CellMountedWorkspace replacement;
  Check(replacement.Create(mount, protection, host, L"S-1-5-18", L"S-1-5-18", sink, 10000) == ERROR_INVALID_STATE,
    "new owner cannot reuse a consumed mount");
  CellWorkspaceIdentities output = Workspace();
  Check(replacement.RecordIdentities(mount, protection, host, &output, 10000) == ERROR_INVALID_STATE && output == CellWorkspaceIdentities{},
    "absent native owner never returns stale execution identities");
  Check(replacement.RecordIdentities(mount, protection, host, nullptr, 10000) == ERROR_INVALID_PARAMETER, "null native identity output refused");
  std::vector<CellMountedWorkspaceCheckpoint> records = golden;
  Check(replacement.RecordCheckpoints(&records) == ERROR_INVALID_STATE && records.empty(), "absent records clear output");
  Check(replacement.RecordCheckpoints(nullptr) == ERROR_INVALID_PARAMETER, "null checkpoint output refused");
  for (unsigned count : {0U, 1U, 3U}) {
    records = golden; records.resize(count); CellMountedWorkspace recovery;
    Check(recovery.OpenRecorded(mount, protection, host, L"S-1-5-18", L"S-1-5-18", records, 10000) == ERROR_INVALID_PARAMETER,
      "native recovery cannot adopt partial records");
  }
  CellMountedWorkspace recovery;
  Check(recovery.OpenRecorded(mount, protection, host, L"S-1-5-18", L"S-1-5-18", golden, 10000) != 0 &&
    recovery.State() == CellMountedWorkspaceState::unknown, "native recovery cannot substitute an incomplete physical source");
}
std::wstring CurrentUser() {
  Handle token; Check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value), "read task-owned process token");
  alignas(TOKEN_USER) std::array<std::uint8_t, 4096> buffer{}; DWORD size = 0;
  Check(GetTokenInformation(token.value, TokenUser, buffer.data(), static_cast<DWORD>(buffer.size()), &size), "read fixture owner SID");
  LPWSTR text = nullptr;
  Check(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid, &text), "convert fixture owner SID");
  const std::wstring user(text); LocalFree(text); return user;
}
CellFileIdentity Identity(HANDLE handle) {
  FILE_ID_INFO info{}; Check(GetFileInformationByHandleEx(handle, FileIdInfo, &info, sizeof(info)), "read ordinary directory identity");
  CellFileIdentity value; value.volume_serial = info.VolumeSerialNumber;
  std::copy(std::begin(info.FileId.Identifier), std::end(info.FileId.Identifier), value.file_id.begin()); return value;
}
HANDLE Parent(const std::wstring& path, const std::wstring& user) {
  std::vector<std::uint8_t> descriptor;
  Check(BuildCellParentSecurity(user, user, &descriptor) == 0, "build protected fixture parent descriptor");
  SECURITY_ATTRIBUTES attributes{sizeof(attributes), descriptor.data(), FALSE};
  Check(CreateDirectoryW(path.c_str(), &attributes), "create exclusive ordinary parent, never a volume root");
  const HANDLE handle = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  Check(handle != INVALID_HANDLE_VALUE, "open ordinary fixture parent"); return handle;
}
struct NativeGuard final {
  unsigned calls = 0, stop = 0, drift_at = 0;
  std::wstring drift_path, user;
  static DWORD Current(void* raw) noexcept {
    auto& f = *static_cast<NativeGuard*>(raw); ++f.calls;
    if (f.calls == f.stop) return ERROR_ACCESS_DENIED;
    if (f.calls != f.drift_at) return ERROR_SUCCESS;
    // Only a directory created by this fixture is modified. No volume root,
    // drive API, format command, mount API or installed entry point is used.
    try {
      const auto sddl = L"O:" + f.user + L"G:" + f.user + L"D:P(A;OICI;FA;;;" + f.user + L")";
      PSECURITY_DESCRIPTOR descriptor = nullptr;
      if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) return GetLastError();
      PACL dacl = nullptr; BOOL present = FALSE, defaulted = FALSE;
      DWORD error = GetSecurityDescriptorDacl(descriptor, &present, &dacl, &defaulted) ? ERROR_SUCCESS : GetLastError();
      Handle handle{CreateFileW(f.drift_path.c_str(), READ_CONTROL | WRITE_DAC, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
      if (!error && handle.value == INVALID_HANDLE_VALUE) error = GetLastError();
      if (!error) error = SetSecurityInfo(handle.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        nullptr, nullptr, dacl, nullptr);
      LocalFree(descriptor); return error;
    } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  }
};
bool Exists(const std::wstring& path) { return GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES; }
void Native(const std::wstring& root) {
  const auto before = checks;
  Check(root.size() > 3 && root[1] == L':' && root[2] == L'\\', "fresh absolute fixture subdirectory is required");
  Check(CreateDirectoryW(root.c_str(), nullptr), "create exclusive task-owned fixture root");
  const auto user = CurrentUser();
  for (unsigned stop = 1; stop <= 4; ++stop) {
    const auto path = root + L"\\deny-" + std::to_wstring(stop); Handle parent{Parent(path, user)};
    const auto identity = Identity(parent.value); CellWorkspaceDirectories contents; NativeGuard guard; guard.stop = stop;
    Check(contents.Create(parent.value, identity, cell_name, user, user, NativeGuard::Current, &guard) == ERROR_ACCESS_DENIED &&
      guard.calls == stop && !contents.Ready(), "native callback refusal stops exactly before each directory creation");
    const auto cell = path + L"\\" + cell_name;
    const std::array<std::wstring, 4> paths{cell, cell + L"\\control", cell + L"\\runtime", cell + L"\\work"};
    for (unsigned i = 0; i < 4; ++i) Check(Exists(paths[i]) == (i + 1 < stop), "only preceding ordinary directories were created");
    CellWorkspaceIdentities output = Workspace();
    Check(contents.RecordIdentities(&output) != 0 && output == CellWorkspaceIdentities{}, "partial native creation cannot expose complete identities");
    contents.Close(); Check(Identity(parent.value) == identity, "partial failure preserves parent identity");
  }
  for (unsigned prior = 0; prior <= 3; ++prior) {
    const auto path = root + L"\\drift-" + std::to_wstring(prior); Handle parent{Parent(path, user)};
    CellWorkspaceDirectories contents; NativeGuard guard;
    guard.drift_at = prior + 1; guard.user = user;
    const auto cell = path + L"\\" + cell_name;
    guard.drift_path = !prior ? path : prior == 1 ? cell : prior == 2 ? cell + L"\\control" : cell + L"\\runtime";
    const auto result = contents.Create(parent.value, Identity(parent.value), cell_name, user, user, NativeGuard::Current, &guard);
    if (result != ERROR_INVALID_SECURITY_DESCR) std::fprintf(stderr, "drift case %u returned %lu after %u guards\n", prior, result, guard.calls);
    Check(result == ERROR_INVALID_SECURITY_DESCR &&
      guard.calls == prior + 1, "permission drift inside the callback is caught before the next native create");
    const auto absent = !prior ? cell : prior == 1 ? cell + L"\\control" : prior == 2 ? cell + L"\\runtime" : cell + L"\\work";
    Check(!Exists(absent), "a changed parent or earlier directory cannot authorize the next directory");
  }
  const auto path = root + L"\\complete"; Handle parent{Parent(path, user)};
  const auto identity = Identity(parent.value); CellWorkspaceDirectories contents; NativeGuard guard;
  Check(contents.Create(parent.value, identity, cell_name, user, user, NativeGuard::Current, &guard) == 0 && guard.calls == 4,
    "actual protected workspace uses all four per-directory guards");
  CellWorkspaceIdentities recorded;
  Check(contents.RecordIdentities(&recorded) == 0 && recorded.parent == identity, "actual roots produce exact identities");
  const auto work = contents.DirectoryPath(CellDirectory::work);
  Handle file{CreateFileW((work + L"\\ordinary-output.txt").c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
    nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr)};
  Check(file.value != INVALID_HANDLE_VALUE && contents.Verify() == 0, "ordinary work files do not change recorded root identity");
  contents.Close(); CellWorkspaceDirectories reader;
  Check(reader.OpenRecorded(parent.value, recorded, cell_name, user, user) == 0 && reader.RecordIdentities(&recorded) == 0,
    "complete native recovery reopens the exact recorded directories");
  CellWorkspaceDirectories changed; auto substituted = recorded; substituted.directories[3].file_id.back() ^= 0x80;
  Check(changed.OpenRecorded(parent.value, substituted, cell_name, user, user) == ERROR_FILE_INVALID && !changed.Ready(),
    "native recovery refuses a changed recorded directory identity");
  CellWorkspaceDirectories duplicate;
  Check(duplicate.Create(parent.value, identity, cell_name, user, user) != 0 && Identity(parent.value) == identity,
    "exclusive creation cannot adopt existing workspace directories");
  CellWorkspaceDirectories missing; const auto missing_name = std::wstring(cell_name).replace(8, 1, L"9");
  Check(missing.OpenRecorded(parent.value, recorded, missing_name, user, user) == ERROR_FILE_NOT_FOUND &&
    !Exists(path + L"\\" + missing_name), "read-only recovery never creates a missing cell");
  native_checks = checks - before;
}
}
unsigned RunCellMountedWorkspaceTests(const std::wstring& directory) {
  Sequence(); RecordsAndRecovery(); EntryPoints(); Native(directory); return checks;
}
DWORD RunCellMountedWorkspaceJournalFixture(const CellMountedWorkspaceBinding& binding, const CellMountedWorkspaceCommitter& sink,
  unsigned* creates, unsigned fail_create) noexcept {
  if (!creates || !sink.commit || !sink.authorize || fail_create > 4) return ERROR_INVALID_PARAMETER;
  *creates = 0;
  try {
    Fixture fixture; fixture.fail_create = fail_create; fixture.actual.parent = binding.volume_root;
    for (std::size_t i = 0; i < fixture.actual.directories.size(); ++i) {
      fixture.actual.directories[i].volume_serial = binding.volume_root.volume_serial;
      fixture.actual.directories[i].file_id.fill(static_cast<std::uint8_t>(0xe8 + i));
    }
    struct Bridge { Fixture* fixture; const CellMountedWorkspaceCommitter* sink; } context{&fixture, &sink};
    const CellMountedWorkspaceCommitter committer{
      [](void* raw, const CellMountedWorkspaceCheckpoint& record, CellFileSha256* acknowledged) noexcept -> DWORD {
        auto& value = *static_cast<Bridge*>(raw);
        try { value.fixture->retained.push_back(record); } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
        return value.sink->commit(value.sink->context, record, acknowledged);
      },
      [](void* raw) noexcept -> DWORD {
        auto& value = *static_cast<Bridge*>(raw); return value.sink->authorize(value.sink->context);
      }, &context,
    };
    const DWORD error = CellMountedWorkspaceTestPeer::Run(fixture.owner, binding, committer, Fixture::Verify, Fixture::Create,
      Fixture::Inspect, &fixture, GetTickCount64() + 10000, nullptr);
    *creates = fixture.creates; return error;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
#ifdef GOATCITADEL_CELL_MOUNTED_WORKSPACE_STANDALONE
int wmain(int argc, wchar_t** argv) {
  try {
    Check(argc == 2, "fresh task-owned output path required"); RunCellMountedWorkspaceTests(argv[1]);
    std::printf("{\"passed\":true,\"checks\":%u,\"nativeDirectoryChecks\":%u,\"volumeMounted\":false,\"volumeAttached\":false,\"ntfsFormatted\":false,\"rootPermissionsChanged\":false,\"records\":[", checks, native_checks);
    for (std::size_t index = 0; index < golden.size(); ++index) {
      std::printf("%s\"", index ? "," : "");
      for (const auto byte : golden[index]) std::printf("%02x", static_cast<unsigned>(byte));
      std::printf("\"");
    }
    std::puts("]}"); return 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); return 1; }
}
#endif
