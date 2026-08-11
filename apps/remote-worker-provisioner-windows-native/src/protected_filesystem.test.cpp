#include "protected_filesystem.hpp"

#if defined(GOATCITADEL_PROVISIONER_TESTING)

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace gc = goatcitadel::remote_worker_provisioner;

namespace {

static_assert(gc::kProtectedPathCharacters == 512U);
static_assert(gc::kProtectedEntryNameCharacters == 80U);
static_assert(gc::kMaximumProtectedDirectoryEntries == 288U);

bool EqualPath(const gc::ProtectedPath& path, const wchar_t* expected) noexcept {
  if (expected == nullptr) return false;
  std::size_t length = 0U;
  while (expected[length] != L'\0') ++length;
  return path.length == length &&
         std::memcmp(
             path.value.data(), expected, (length + 1U) * sizeof(wchar_t)) == 0;
}

void RecordFailure(int* failures, const char* message) noexcept {
  if (failures == nullptr || message == nullptr) return;
  ++*failures;
  std::size_t length = 0U;
  while (message[length] != '\0') ++length;
  DWORD written = 0U;
  WriteFile(
      GetStdHandle(STD_ERROR_HANDLE),
      message,
      static_cast<DWORD>(length),
      &written,
      nullptr);
}

bool AllZero(const void* value, std::size_t length) noexcept {
  if (value == nullptr) return false;
  const auto* bytes = static_cast<const std::uint8_t*>(value);
  std::uint8_t aggregate = 0U;
  for (std::size_t index = 0U; index < length; ++index) {
    aggregate = static_cast<std::uint8_t>(aggregate | bytes[index]);
  }
  return aggregate == 0U;
}

bool CopyPath(const wchar_t* value, gc::ProtectedPath* output) noexcept {
  if (value == nullptr || output == nullptr) return false;
  *output = gc::ProtectedPath{};
  while (value[output->length] != L'\0') {
    if (output->length + 1U >= output->value.size()) return false;
    output->value[output->length] = value[output->length];
    ++output->length;
  }
  output->value[output->length] = L'\0';
  return output->length != 0U;
}

}  // namespace

int RunProtectedFilesystemTests() noexcept {
  int failures = 0;

  // Path composition is literal, bounded, null-terminated, and preserves input.
  gc::ProtectedPath parent{};
  constexpr wchar_t kParent[] = L"\\\\?\\C:\\ProgramData\\GoatCitadel";
  constexpr wchar_t kChild[] =
      L"\\\\?\\C:\\ProgramData\\GoatCitadel\\RemoteWorkerProvisioner";
  parent.length = (sizeof(kParent) / sizeof(kParent[0])) - 1U;
  std::memcpy(parent.value.data(), kParent, sizeof(kParent));
  const gc::ProtectedPath original_parent = parent;
  gc::ProtectedPath child{};
  if (!gc::ComposeProtectedChildPath(
          parent, L"RemoteWorkerProvisioner", &child) ||
      !EqualPath(child, kChild) ||
      std::memcmp(&parent, &original_parent, sizeof(parent)) != 0) {
    RecordFailure(&failures, "protected_filesystem: path composition\n");
  }
  if (gc::ComposeProtectedChildPath(parent, nullptr, &child) ||
      gc::ComposeProtectedChildPath(parent, L"x", nullptr)) {
    RecordFailure(&failures, "protected_filesystem: null path inputs\n");
  }
  gc::ProtectedPath empty{};
  if (gc::ComposeProtectedChildPath(empty, L"x", &child)) {
    RecordFailure(&failures, "protected_filesystem: empty parent\n");
  }
  gc::ProtectedPath full{};
  full.length = full.value.size() - 1U;
  full.value[full.length - 1U] = L'x';
  full.value[full.length] = L'\0';
  if (gc::ComposeProtectedChildPath(full, L"x", &child)) {
    RecordFailure(&failures, "protected_filesystem: path overflow\n");
  }

  // Every declared cutpoint has exact fail-on-N and independent count semantics.
  constexpr std::array<gc::ProtectedFilesystemTestCutpoint, 7U> kCutpoints = {
      gc::ProtectedFilesystemTestCutpoint::CreateDirectory,
      gc::ProtectedFilesystemTestCutpoint::CreateFile,
      gc::ProtectedFilesystemTestCutpoint::Write,
      gc::ProtectedFilesystemTestCutpoint::FirstFlush,
      gc::ProtectedFilesystemTestCutpoint::Rename,
      gc::ProtectedFilesystemTestCutpoint::SecondFlush,
      gc::ProtectedFilesystemTestCutpoint::Reopen,
  };
  for (const auto cutpoint : kCutpoints) {
    gc::SetProtectedFilesystemFailureForTest(cutpoint, 2U);
    if (!gc::PermitProtectedFilesystemStepForTest(cutpoint) ||
        gc::PermitProtectedFilesystemStepForTest(cutpoint) ||
        !gc::PermitProtectedFilesystemStepForTest(cutpoint) ||
        gc::ProtectedFilesystemCallCountForTest(cutpoint) != 3U) {
      RecordFailure(&failures, "protected_filesystem: cutpoint fail-on-N\n");
    }
    for (const auto other : kCutpoints) {
      if (other != cutpoint &&
          gc::ProtectedFilesystemCallCountForTest(other) != 0U) {
        RecordFailure(&failures, "protected_filesystem: cutpoint isolation\n");
      }
    }
  }
  gc::ResetProtectedFilesystemFailuresForTest();
  for (const auto cutpoint : kCutpoints) {
    if (gc::ProtectedFilesystemCallCountForTest(cutpoint) != 0U ||
        !gc::PermitProtectedFilesystemStepForTest(cutpoint)) {
      RecordFailure(&failures, "protected_filesystem: cutpoint reset\n");
    }
  }
  const auto invalid_cutpoint =
      static_cast<gc::ProtectedFilesystemTestCutpoint>(0U);
  const auto over_cutpoint =
      static_cast<gc::ProtectedFilesystemTestCutpoint>(8U);
  if (gc::PermitProtectedFilesystemStepForTest(invalid_cutpoint) ||
      gc::PermitProtectedFilesystemStepForTest(over_cutpoint) ||
      gc::ProtectedFilesystemCallCountForTest(invalid_cutpoint) != 0U ||
      gc::ProtectedFilesystemCallCountForTest(over_cutpoint) != 0U) {
    RecordFailure(&failures, "protected_filesystem: invalid cutpoint\n");
  }

  // Public mutation owners stop at the injected cutpoint before touching Win32.
  gc::ProtectedFilesystemState ready{};
  ready.ready = true;
  ready.security_descriptor_length = 1U;
  HANDLE output = reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(1U));
  gc::SetProtectedFilesystemFailureForTest(
      gc::ProtectedFilesystemTestCutpoint::CreateDirectory, 1U);
  if (gc::CreateProtectedDirectory(ready, parent, &output) ||
      gc::ProtectedFilesystemCallCountForTest(
          gc::ProtectedFilesystemTestCutpoint::CreateDirectory) != 1U ||
      output != reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(1U))) {
    RecordFailure(&failures, "protected_filesystem: create-directory cutpoint\n");
  }
  gc::SetProtectedFilesystemFailureForTest(
      gc::ProtectedFilesystemTestCutpoint::CreateFile, 1U);
  if (gc::CreateProtectedFile(ready, parent, false, &output) ||
      gc::ProtectedFilesystemCallCountForTest(
          gc::ProtectedFilesystemTestCutpoint::CreateFile) != 1U ||
      output != reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(1U))) {
    RecordFailure(&failures, "protected_filesystem: create-file cutpoint\n");
  }
  gc::SetProtectedFilesystemFailureForTest(
      gc::ProtectedFilesystemTestCutpoint::FirstFlush, 1U);
  if (gc::FlushAndRenameProtectedFile(
          reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(1U)), child) ||
      gc::ProtectedFilesystemCallCountForTest(
          gc::ProtectedFilesystemTestCutpoint::FirstFlush) != 1U) {
    RecordFailure(&failures, "protected_filesystem: first-flush cutpoint\n");
  }
  gc::SetProtectedFilesystemFailureForTest(
      gc::ProtectedFilesystemTestCutpoint::Rename, 1U);
  if (gc::RenameProtectedDirectory(
          reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(1U)), child) ||
      gc::ProtectedFilesystemCallCountForTest(
          gc::ProtectedFilesystemTestCutpoint::Rename) != 1U) {
    RecordFailure(&failures, "protected_filesystem: rename cutpoint\n");
  }

  // No-replace publication treats an already-selected final name as a hard
  // collision. It leaves both source and final intact and never advances to a
  // second-flush/retry path.
  std::array<wchar_t, MAX_PATH + 1U> temporary_directory{};
  std::array<wchar_t, MAX_PATH + 1U> collision_source{};
  std::array<wchar_t, MAX_PATH + 1U> collision_final{};
  const DWORD temporary_length = GetTempPathW(
      static_cast<DWORD>(temporary_directory.size()),
      temporary_directory.data());
  const bool temporary_path_ready =
      temporary_length != 0U && temporary_length < temporary_directory.size();
  const bool collision_source_created =
      temporary_path_ready &&
      GetTempFileNameW(
          temporary_directory.data(), L"gcs", 0U, collision_source.data()) != 0U;
  const bool collision_final_created =
      temporary_path_ready &&
      GetTempFileNameW(
          temporary_directory.data(), L"gcf", 0U, collision_final.data()) != 0U;
  const bool temporary_ready =
      collision_source_created && collision_final_created;
  HANDLE collision_handle = temporary_ready
      ? CreateFileW(
            collision_source.data(),
            GENERIC_READ | GENERIC_WRITE | DELETE,
            0U,
            nullptr,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH,
            nullptr)
      : INVALID_HANDLE_VALUE;
  gc::ProtectedPath collision_final_path{};
  const std::uint8_t source_byte = 0x31U;
  DWORD collision_written = 0U;
  gc::ResetProtectedFilesystemFailuresForTest();
  const bool collision_rejected =
      collision_handle != INVALID_HANDLE_VALUE &&
      WriteFile(
          collision_handle,
          &source_byte,
          sizeof(source_byte),
          &collision_written,
          nullptr) != FALSE &&
      collision_written == sizeof(source_byte) &&
      CopyPath(collision_final.data(), &collision_final_path) &&
      !gc::FlushAndRenameProtectedFile(
          collision_handle, collision_final_path);
  if (collision_handle != INVALID_HANDLE_VALUE) CloseHandle(collision_handle);
  if (!collision_rejected ||
      GetFileAttributesW(collision_source.data()) == INVALID_FILE_ATTRIBUTES ||
      GetFileAttributesW(collision_final.data()) == INVALID_FILE_ATTRIBUTES ||
      gc::ProtectedFilesystemCallCountForTest(
          gc::ProtectedFilesystemTestCutpoint::Rename) != 1U ||
      gc::ProtectedFilesystemCallCountForTest(
          gc::ProtectedFilesystemTestCutpoint::SecondFlush) != 0U) {
    RecordFailure(&failures, "protected_filesystem: no-replace collision\n");
  }
  if (collision_source_created) DeleteFileW(collision_source.data());
  if (collision_final_created) DeleteFileW(collision_final.data());

  // Recovery STOP/deadline authority is checked before every guarded mutation
  // primitive, before even the test cutpoint that represents its first effect.
  HANDLE recovery_stop = CreateEventW(nullptr, TRUE, TRUE, nullptr);
  gc::ProtectedFilesystemState guarded{};
  guarded.ready = true;
  guarded.security_descriptor_length = 1U;
  gc::ConfigureProtectedFilesystemRecoveryGuard(
      &guarded, GetTickCount64() + 10000U, recovery_stop);
  gc::ResetProtectedFilesystemFailuresForTest();
  HANDLE guarded_output = reinterpret_cast<HANDLE>(
      static_cast<std::uintptr_t>(1U));
  gc::ProtectedObjectIdentity guarded_identity{};
  std::array<gc::ProtectedDirectoryEntry,
             gc::kMaximumProtectedDirectoryEntries> guarded_entries{};
  std::size_t guarded_count = guarded_entries.size();
  std::array<std::uint8_t, 32U> guarded_bytes{};
  std::size_t guarded_length = guarded_bytes.size();
  if (recovery_stop == nullptr ||
      gc::ProtectedFilesystemRecoveryCheckpoint(guarded) ||
      gc::CreateProtectedDirectory(guarded, parent, &guarded_output) ||
      gc::CreateProtectedFile(guarded, parent, false, &guarded_output) ||
      gc::CaptureProtectedObjectIdentity(
          guarded,
          reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(1U)),
          &guarded_identity) ||
      gc::ProtectedDirectoryIsEmptyGuarded(
          guarded,
          reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(1U))) ||
      gc::EnumerateProtectedDirectory(
          guarded,
          reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(1U)),
          &guarded_entries,
          &guarded_count) ||
      gc::OpenProtectedExistingDirectory(
          guarded, parent, false, &guarded_output, &guarded_identity) ||
      gc::ReadProtectedExistingFile(
          guarded,
          parent,
          guarded_bytes.data(),
          guarded_bytes.size(),
          &guarded_length,
          &guarded_identity) ||
      gc::ReadProtectedFinalFile(
          guarded,
          parent,
          guarded_bytes.data(),
          guarded_bytes.size(),
          &guarded_length,
          &guarded_identity) ||
      gc::PromoteProtectedExistingFile(
          guarded, parent, child, false, &guarded_identity) ||
      gc::MoveProtectedExistingDirectory(
          guarded, parent, child, &guarded_identity) ||
      gc::FlushAndRenameProtectedFile(
          guarded,
          reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(1U)),
          child) ||
      gc::RenameProtectedDirectory(
          guarded,
          reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(1U)),
          child) ||
      gc::ProtectedFilesystemCallCountForTest(
          gc::ProtectedFilesystemTestCutpoint::CreateDirectory) != 0U ||
      gc::ProtectedFilesystemCallCountForTest(
          gc::ProtectedFilesystemTestCutpoint::CreateFile) != 0U ||
      gc::ProtectedFilesystemCallCountForTest(
          gc::ProtectedFilesystemTestCutpoint::FirstFlush) != 0U ||
      gc::ProtectedFilesystemCallCountForTest(
          gc::ProtectedFilesystemTestCutpoint::Rename) != 0U ||
      gc::ProtectedFilesystemCallCountForTest(
          gc::ProtectedFilesystemTestCutpoint::Reopen) != 0U) {
    RecordFailure(&failures, "protected_filesystem: STOP before mutation\n");
  }
  if (recovery_stop != nullptr) ResetEvent(recovery_stop);
  gc::ConfigureProtectedFilesystemRecoveryGuard(
      &guarded, GetTickCount64(), recovery_stop);
  gc::ResetProtectedFilesystemFailuresForTest();
  if (gc::ProtectedFilesystemRecoveryCheckpoint(guarded) ||
      gc::CreateProtectedDirectory(guarded, parent, &guarded_output) ||
      gc::CreateProtectedFile(guarded, parent, false, &guarded_output) ||
      gc::CaptureProtectedObjectIdentity(
          guarded,
          reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(1U)),
          &guarded_identity) ||
      gc::ProtectedDirectoryIsEmptyGuarded(
          guarded,
          reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(1U))) ||
      gc::EnumerateProtectedDirectory(
          guarded,
          reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(1U)),
          &guarded_entries,
          &guarded_count) ||
      gc::OpenProtectedExistingDirectory(
          guarded, parent, false, &guarded_output, &guarded_identity) ||
      gc::ReadProtectedExistingFile(
          guarded,
          parent,
          guarded_bytes.data(),
          guarded_bytes.size(),
          &guarded_length,
          &guarded_identity) ||
      gc::ReadProtectedFinalFile(
          guarded,
          parent,
          guarded_bytes.data(),
          guarded_bytes.size(),
          &guarded_length,
          &guarded_identity) ||
      gc::PromoteProtectedExistingFile(
          guarded, parent, child, false, &guarded_identity) ||
      gc::MoveProtectedExistingDirectory(
          guarded, parent, child, &guarded_identity) ||
      gc::FlushAndRenameProtectedFile(
          guarded,
          reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(1U)),
          child) ||
      gc::RenameProtectedDirectory(
          guarded,
          reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(1U)),
          child) ||
      gc::ProtectedFilesystemCallCountForTest(
          gc::ProtectedFilesystemTestCutpoint::CreateDirectory) != 0U ||
      gc::ProtectedFilesystemCallCountForTest(
          gc::ProtectedFilesystemTestCutpoint::CreateFile) != 0U ||
      gc::ProtectedFilesystemCallCountForTest(
          gc::ProtectedFilesystemTestCutpoint::FirstFlush) != 0U ||
      gc::ProtectedFilesystemCallCountForTest(
          gc::ProtectedFilesystemTestCutpoint::Rename) != 0U ||
      gc::ProtectedFilesystemCallCountForTest(
          gc::ProtectedFilesystemTestCutpoint::Reopen) != 0U) {
    RecordFailure(&failures, "protected_filesystem: deadline before mutation\n");
  }
  gc::ConfigureProtectedFilesystemRecoveryGuard(&guarded, 0U, nullptr);
  if (!gc::ProtectedFilesystemRecoveryCheckpoint(guarded) ||
      guarded.recovery_deadline_ms != 0U ||
      guarded.recovery_stop_event != nullptr) {
    RecordFailure(&failures, "protected_filesystem: recovery guard clear\n");
  }
  if (recovery_stop != nullptr) CloseHandle(recovery_stop);
  gc::SetProtectedFilesystemFailureForTest(
      gc::ProtectedFilesystemTestCutpoint::Reopen, 1U);
  gc::ProtectedObjectIdentity reopened_identity{};
  output = reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(1U));
  if (gc::OpenProtectedExistingDirectory(
          ready, parent, false, &output, &reopened_identity) ||
      gc::ProtectedFilesystemCallCountForTest(
          gc::ProtectedFilesystemTestCutpoint::Reopen) != 1U ||
      output != nullptr) {
    RecordFailure(&failures, "protected_filesystem: directory-reopen cutpoint\n");
  }
  gc::SetProtectedFilesystemFailureForTest(
      gc::ProtectedFilesystemTestCutpoint::Reopen, 1U);
  std::array<std::uint8_t, 32U> reopened_bytes{};
  std::size_t reopened_length = reopened_bytes.size();
  if (gc::ReadProtectedExistingFile(
          ready,
          parent,
          reopened_bytes.data(),
          reopened_bytes.size(),
          &reopened_length,
          &reopened_identity) ||
      gc::ProtectedFilesystemCallCountForTest(
          gc::ProtectedFilesystemTestCutpoint::Reopen) != 1U ||
      reopened_length != 0U) {
    RecordFailure(&failures, "protected_filesystem: file-reopen cutpoint\n");
  }

  // Invalid entrypoints fail closed, and Close wipes all state-owned material.
  gc::ProtectedObjectIdentity identity{};
  gc::ProtectedFilesystemState state{};
  std::array<gc::ProtectedDirectoryEntry,
             gc::kMaximumProtectedDirectoryEntries> entries{};
  std::size_t entry_count = 99U;
  if (gc::CaptureProtectedObjectIdentity(nullptr, &identity) ||
      gc::CaptureProtectedObjectIdentity(INVALID_HANDLE_VALUE, &identity) ||
      gc::CaptureProtectedObjectIdentity(nullptr, nullptr) ||
      gc::ProtectedDirectoryIsEmpty(nullptr) ||
      gc::ProtectedDirectoryIsEmpty(INVALID_HANDLE_VALUE) ||
      gc::EnumerateProtectedDirectory(nullptr, &entries, &entry_count) ||
      gc::EnumerateProtectedDirectory(
          INVALID_HANDLE_VALUE, &entries, &entry_count) ||
      gc::EnumerateProtectedDirectory(nullptr, nullptr, nullptr) ||
      gc::OpenProtectedExistingDirectory(
          state, parent, false, &output, &identity) ||
      gc::ReadProtectedExistingFile(
          state,
          parent,
          reopened_bytes.data(),
          reopened_bytes.size(),
          &reopened_length,
          &identity) ||
      gc::OpenProtectedFilesystem(nullptr, 0U, &state) ||
      gc::OpenProtectedFilesystem(L"short", 5U, &state)) {
    RecordFailure(&failures, "protected_filesystem: invalid entrypoints\n");
  }
  state.ready = true;
  state.security_descriptor_length = 1U;
  state.security_descriptor.fill(0xa5U);
  state.security_projection.fill(0x5aU);
  state.state_root_path = parent;
  gc::CloseProtectedFilesystem(&state);
  if (!AllZero(&state, sizeof(state))) {
    RecordFailure(&failures, "protected_filesystem: close wipe\n");
  }
  gc::CloseProtectedFilesystem(nullptr);
  gc::ResetProtectedFilesystemFailuresForTest();
  return failures;
}

#endif
