#pragma once

// Test-only observation. Public SDK contracts: processsnapshot.h;
// https://learn.microsoft.com/windows/win32/api/processsnapshot/nf-processsnapshot-psscapturesnapshot
// https://learn.microsoft.com/windows/win32/api/processsnapshot/ns-processsnapshot-pss_handle_entry
// https://learn.microsoft.com/windows/win32/api/processsnapshot/nf-processsnapshot-psswalksnapshot
// No snapshot memory, thread context, raw file contents or retained OS handles.
#if defined(GOATCITADEL_PROVISIONER_TESTING)
#include <windows.h>
#include <processsnapshot.h>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <initializer_list>
#include <type_traits>

namespace goatcitadel::remote_worker_provisioner::test {

inline bool HandleDiagnosticsEnabled() noexcept {
  const DWORD preservedError = GetLastError();
  wchar_t value[2]{};
  const DWORD length = GetEnvironmentVariableW(L"GOATCITADEL_PROVISIONER_HANDLE_DIAGNOSTICS", value, 2U);
  const bool enabled = length == 1U && value[0] == L'1';
  SetLastError(preservedError);
  return enabled;
}
inline DWORD DiagnosticHandleCount() noexcept {
  const DWORD preservedError = GetLastError();
  DWORD count = 0U;
  if (!GetProcessHandleCount(GetCurrentProcess(), &count)) count = UINT32_MAX;
  SetLastError(preservedError);
  return count;
}
// The protected filesystem owns File handles (including directories), not the
// process's asynchronously created Windows thread-pool/RPC handles. Capture all
// handle types and compare exact File counts. Unsupported PSS types are checked
// with GetFileType; only a confirmed non-file or already-closed handle is omitted.
// Incomplete tables and unverifiable reads fail. No tolerance, polling, or retry.
inline BOOL GetProtectedFileHandleCount(HANDLE process, DWORD* count) noexcept {
  if (!count) { SetLastError(ERROR_INVALID_PARAMETER); return FALSE; }
  const DWORD preservedError = GetLastError();
  HPSS snapshot = nullptr;
  HPSSWALK marker = nullptr;
  DWORD result = PssCaptureSnapshot(process,
      static_cast<PSS_CAPTURE_FLAGS>(PSS_CAPTURE_HANDLES | PSS_CAPTURE_HANDLE_BASIC_INFORMATION | PSS_CAPTURE_HANDLE_NAME_INFORMATION | PSS_CAPTURE_HANDLE_TYPE_SPECIFIC_INFORMATION), 0U, &snapshot);
  DWORD files = 0U;
  if (result == ERROR_SUCCESS) result = PssWalkMarkerCreate(nullptr, &marker);
  bool complete = false;
  if (result == ERROR_SUCCESS) {
    for (std::size_t index = 0U; index < 512U; ++index) {
      PSS_HANDLE_ENTRY entry{};
      result = PssWalkSnapshot(snapshot, PSS_WALK_HANDLES, marker, &entry, static_cast<DWORD>(sizeof(entry)));
      if (result == ERROR_NO_MORE_ITEMS) { complete = true; result = ERROR_SUCCESS; break; }
      if (result != ERROR_SUCCESS) break;
      if ((entry.Flags & PSS_HANDLE_HAVE_TYPE) == 0 || !entry.TypeName || entry.TypeNameLength == 0U) {
        SetLastError(ERROR_SUCCESS);
        const DWORD kind = GetFileType(entry.Handle);
        const DWORD typeError = GetLastError();
        if (kind != FILE_TYPE_UNKNOWN || typeError == ERROR_SUCCESS) { ++files; continue; }
        if (typeError != ERROR_INVALID_HANDLE) { result = typeError; break; }
        DWORD handleFlags = 0U;
        SetLastError(ERROR_SUCCESS);
        if (GetHandleInformation(entry.Handle, &handleFlags) != FALSE || GetLastError() == ERROR_INVALID_HANDLE) continue;
        result = GetLastError(); break;
      }
      if (entry.TypeNameLength % sizeof(wchar_t) != 0U) { result = ERROR_INVALID_DATA; break; }
      constexpr wchar_t fileType[] = L"File";
      // Current SDK captures include the terminator; the public contract also
      // permits unterminated names. Compare exactly either representation.
      if ((entry.TypeNameLength == sizeof(fileType) - sizeof(wchar_t) || entry.TypeNameLength == sizeof(fileType))
          && std::memcmp(entry.TypeName, fileType, entry.TypeNameLength) == 0) ++files;
    }
    if (!complete && result == ERROR_SUCCESS) result = ERROR_MORE_DATA;
  }
  if (marker) { const DWORD closed = PssWalkMarkerFree(marker); if (result == ERROR_SUCCESS) result = closed; }
  if (snapshot) { const DWORD closed = PssFreeSnapshot(process, snapshot); if (result == ERROR_SUCCESS) result = closed; }
  if (result != ERROR_SUCCESS) { SetLastError(result); return FALSE; }
  *count = files;
  SetLastError(preservedError);
  return TRUE;
}
constexpr std::size_t kDiagnosticHandleLimit = 256U;
constexpr std::size_t kDiagnosticThreadLimit = 128U;
constexpr std::size_t kDiagnosticDifferenceLimit = 32U;
struct DiagnosticHandle {
  std::uintptr_t value;
  DWORD flags, objectType, processId, threadId, exitStatus;
  std::array<wchar_t, 48U> typeName;
  std::array<wchar_t, 128U> objectName;
  bool typeTruncated, nameTruncated, malformedNameLength;
};
struct DiagnosticThread {
  DWORD processId, threadId, exitStatus;
  std::uintptr_t startOffset;
  std::array<wchar_t, 128U> moduleName;
};
struct HandleSnapshot {
  std::array<DiagnosticHandle, kDiagnosticHandleLimit> handles;
  std::array<DiagnosticThread, kDiagnosticThreadLimit> threads;
  std::size_t handleCount, threadCount;
  DWORD captureStatus, handleWalkStatus, threadWalkStatus;
  DWORD handleMarkerFreeStatus, threadMarkerFreeStatus, snapshotFreeStatus;
  DWORD countBeforeStatus, countAfterStatus, countBefore, countAfter;
  bool handleLimitReached, threadLimitReached;
};
static_assert(std::is_trivially_copyable_v<HandleSnapshot>);

namespace handle_diagnostics_detail {
template <std::size_t N>
inline void CopyName(const wchar_t* source, WORD bytes,
                     std::array<wchar_t, N>* target, bool* truncated,
                     bool* malformed) noexcept {
  if ((bytes % sizeof(wchar_t)) != 0U || (bytes != 0U && !source)) {
    *malformed = true;
    return;
  }
  const std::size_t length = bytes / sizeof(wchar_t);
  const std::size_t copied = length < N ? length : N - 1U;
  for (std::size_t i = 0U; i < copied; ++i) (*target)[i] = source[i];
  (*target)[copied] = L'\0';
  *truncated = copied != length;
}

inline void WalkHandles(HPSS snapshot, HandleSnapshot* output) noexcept {
  HPSSWALK marker = nullptr;
  output->handleWalkStatus = PssWalkMarkerCreate(nullptr, &marker);
  if (output->handleWalkStatus == ERROR_SUCCESS) {
    while (output->handleCount < output->handles.size()) {
      PSS_HANDLE_ENTRY entry{};
      const DWORD status = PssWalkSnapshot(snapshot, PSS_WALK_HANDLES, marker,
                                          &entry, static_cast<DWORD>(sizeof(entry)));
      if (status == ERROR_NO_MORE_ITEMS) break;
      if (status != ERROR_SUCCESS) { output->handleWalkStatus = status; break; }
      DiagnosticHandle& record = output->handles[output->handleCount++];
      record.value = reinterpret_cast<std::uintptr_t>(entry.Handle);
      record.flags = static_cast<DWORD>(entry.Flags);
      if ((record.flags & PSS_HANDLE_HAVE_TYPE) != 0U) {
        record.objectType = static_cast<DWORD>(entry.ObjectType);
        CopyName(entry.TypeName, entry.TypeNameLength, &record.typeName,
                 &record.typeTruncated, &record.malformedNameLength);
      }
      if ((record.flags & PSS_HANDLE_HAVE_NAME) != 0U) {
        CopyName(entry.ObjectName, entry.ObjectNameLength, &record.objectName,
                 &record.nameTruncated, &record.malformedNameLength);
      }
      if ((record.flags & (PSS_HANDLE_HAVE_TYPE | PSS_HANDLE_HAVE_TYPE_SPECIFIC_INFORMATION))
          == static_cast<DWORD>(PSS_HANDLE_HAVE_TYPE | PSS_HANDLE_HAVE_TYPE_SPECIFIC_INFORMATION)) {
        if (entry.ObjectType == PSS_OBJECT_TYPE_THREAD) {
          record.processId = entry.TypeSpecificInformation.Thread.ProcessId;
          record.threadId = entry.TypeSpecificInformation.Thread.ThreadId;
          record.exitStatus = entry.TypeSpecificInformation.Thread.ExitStatus;
        } else if (entry.ObjectType == PSS_OBJECT_TYPE_PROCESS) {
          record.processId = entry.TypeSpecificInformation.Process.ProcessId;
          record.exitStatus = entry.TypeSpecificInformation.Process.ExitStatus;
        }
      }
    }
    // Conservatively incomplete even when the exact table might end at this cap.
    output->handleLimitReached = output->handleCount == output->handles.size();
    if (output->handleLimitReached) output->handleWalkStatus = ERROR_MORE_DATA;
  }
  if (marker) output->handleMarkerFreeStatus = PssWalkMarkerFree(marker);
}

inline void WalkThreads(HPSS snapshot, HandleSnapshot* output) noexcept {
  HPSSWALK marker = nullptr;
  output->threadWalkStatus = PssWalkMarkerCreate(nullptr, &marker);
  if (output->threadWalkStatus == ERROR_SUCCESS) {
    while (output->threadCount < output->threads.size()) {
      PSS_THREAD_ENTRY entry{};
      const DWORD status = PssWalkSnapshot(snapshot, PSS_WALK_THREADS, marker,
                                          &entry, static_cast<DWORD>(sizeof(entry)));
      if (status == ERROR_NO_MORE_ITEMS) break;
      if (status != ERROR_SUCCESS) { output->threadWalkStatus = status; break; }
      auto& record = output->threads[output->threadCount++];
      record.processId = entry.ProcessId; record.threadId = entry.ThreadId; record.exitStatus = entry.ExitStatus;
      HMODULE module = nullptr;
      if (entry.Win32StartAddress && GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
          reinterpret_cast<LPCWSTR>(entry.Win32StartAddress), &module)) {
        record.startOffset = reinterpret_cast<std::uintptr_t>(entry.Win32StartAddress) - reinterpret_cast<std::uintptr_t>(module);
        GetModuleFileNameW(module, record.moduleName.data(), static_cast<DWORD>(record.moduleName.size()));
        record.moduleName.back() = L'\0';
      }
    }
    output->threadLimitReached = output->threadCount == output->threads.size();
    if (output->threadLimitReached) output->threadWalkStatus = ERROR_MORE_DATA;
  }
  if (marker) output->threadMarkerFreeStatus = PssWalkMarkerFree(marker);
}

inline bool Complete(const HandleSnapshot& value) noexcept {
  return value.captureStatus == ERROR_SUCCESS && value.handleWalkStatus == ERROR_SUCCESS
      && value.threadWalkStatus == ERROR_SUCCESS && value.handleMarkerFreeStatus == ERROR_SUCCESS
      && value.threadMarkerFreeStatus == ERROR_SUCCESS && value.snapshotFreeStatus == ERROR_SUCCESS;
}
inline void PrintSummary(const char* label, const HandleSnapshot& value) noexcept {
  std::fprintf(stderr, "handle_diagnostic snapshot=%s complete=%d handles=%zu threads=%zu caps=%zu/%zu "
      "capture=%lu walks=%lu/%lu marker_free=%lu/%lu snapshot_free=%lu "
      "live_counts=%lu/%lu count_status=%lu/%lu count_changed_during_capture=%d\n",
      label, Complete(value) ? 1 : 0, value.handleCount, value.threadCount,
      kDiagnosticHandleLimit, kDiagnosticThreadLimit,
      value.captureStatus, value.handleWalkStatus, value.threadWalkStatus,
      value.handleMarkerFreeStatus, value.threadMarkerFreeStatus, value.snapshotFreeStatus,
      value.countBefore, value.countAfter, value.countBeforeStatus, value.countAfterStatus,
      value.countBeforeStatus == ERROR_SUCCESS && value.countAfterStatus == ERROR_SUCCESS
          && value.countBefore != value.countAfter ? 1 : 0);
}
template <std::size_t N>
inline void PrintName(const std::array<wchar_t, N>& name) noexcept {
  std::fputc('"', stderr);
  for (std::size_t i = 0U; i < N && name[i] != L'\0'; ++i) {
    const unsigned int unit = static_cast<unsigned int>(name[i]);
    if (unit >= 32U && unit <= 126U && unit != '"' && unit != '\\') std::fputc(static_cast<int>(unit), stderr);
    else std::fprintf(stderr, "\\u%04x", unit);
  }
  std::fputc('"', stderr);
}
inline void PrintHandle(const char* delta, const DiagnosticHandle& value) noexcept {
  std::fprintf(stderr, "handle_diagnostic delta=%s handle=0x%llx flags=%lu object_type=%lu pid=%lu tid=%lu exit=%lu type=",
      delta, static_cast<unsigned long long>(value.value), value.flags, value.objectType,
      value.processId, value.threadId, value.exitStatus);
  PrintName(value.typeName);
  std::fputs(" name=", stderr); PrintName(value.objectName);
  std::fprintf(stderr, " truncated=%d/%d malformed_name_length=%d\n",
      value.typeTruncated ? 1 : 0, value.nameTruncated ? 1 : 0, value.malformedNameLength ? 1 : 0);
}
inline const DiagnosticHandle* FindHandle(const HandleSnapshot& snapshot, std::uintptr_t value) noexcept {
  for (std::size_t i = 0U; i < snapshot.handleCount; ++i) if (snapshot.handles[i].value == value) return &snapshot.handles[i];
  return nullptr;
}
inline bool SameMetadata(const DiagnosticHandle& left, const DiagnosticHandle& right) noexcept {
  return left.flags == right.flags && left.objectType == right.objectType
      && left.processId == right.processId && left.threadId == right.threadId && left.exitStatus == right.exitStatus
      && left.typeName == right.typeName && left.objectName == right.objectName
      && left.typeTruncated == right.typeTruncated && left.nameTruncated == right.nameTruncated
      && left.malformedNameLength == right.malformedNameLength;
}
inline bool HasThread(const HandleSnapshot& snapshot, const DiagnosticThread& value) noexcept {
  for (std::size_t i = 0U; i < snapshot.threadCount; ++i) {
    const auto& old = snapshot.threads[i];
    if (old.processId == value.processId && old.threadId == value.threadId && old.exitStatus == value.exitStatus) return true;
  }
  return false;
}
}  // namespace handle_diagnostics_detail

// Caller places this after its unchanged strict baseline/count assertion.
// All variable SDK data is copied before marker/snapshot release; no retries.
inline DWORD CaptureHandleSnapshot(HandleSnapshot* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  const DWORD preservedError = GetLastError();
  std::memset(output, 0, sizeof(*output));
  output->handleWalkStatus = ERROR_NOT_READY;
  output->threadWalkStatus = ERROR_NOT_READY;
  if (!GetProcessHandleCount(GetCurrentProcess(), &output->countBefore)) output->countBeforeStatus = GetLastError();
  HPSS snapshot = nullptr;
  constexpr auto flags = static_cast<PSS_CAPTURE_FLAGS>(PSS_CAPTURE_HANDLES | PSS_CAPTURE_HANDLE_BASIC_INFORMATION | PSS_CAPTURE_HANDLE_NAME_INFORMATION
      | PSS_CAPTURE_HANDLE_TYPE_SPECIFIC_INFORMATION | PSS_CAPTURE_THREADS);
  output->captureStatus = PssCaptureSnapshot(GetCurrentProcess(), flags, 0U, &snapshot);
  if (output->captureStatus == ERROR_SUCCESS) {
    handle_diagnostics_detail::WalkHandles(snapshot, output);
    handle_diagnostics_detail::WalkThreads(snapshot, output);
  }
  if (snapshot) output->snapshotFreeStatus = PssFreeSnapshot(GetCurrentProcess(), snapshot);
  if (!GetProcessHandleCount(GetCurrentProcess(), &output->countAfter)) output->countAfterStatus = GetLastError();
  DWORD status = ERROR_SUCCESS;
  for (const DWORD item : {output->captureStatus, output->handleWalkStatus, output->threadWalkStatus,
                          output->handleMarkerFreeStatus, output->threadMarkerFreeStatus, output->snapshotFreeStatus,
                          output->countBeforeStatus, output->countAfterStatus}) {
    if (item != ERROR_SUCCESS) { status = item; break; }
  }
  SetLastError(preservedError);
  return status;
}

// Invoke once at the first original failure. Observations never change verdicts.
inline void PrintHandleSnapshotDifference(const HandleSnapshot& baseline, const HandleSnapshot& failure) noexcept {
  const DWORD preservedError = GetLastError();
  using namespace handle_diagnostics_detail;
  PrintSummary("baseline", baseline); PrintSummary("first_failure", failure);
  for (const auto* snapshot : {&baseline, &failure}) {
    for (std::size_t index = 0U; index < snapshot->threadCount; ++index) {
      const auto& thread = snapshot->threads[index];
      std::fprintf(stderr, "handle_diagnostic thread_snapshot=%s pid=%lu tid=%lu exit=%lu start_offset=0x%llx module=",
          snapshot == &baseline ? "baseline" : "failure", thread.processId, thread.threadId, thread.exitStatus,
          static_cast<unsigned long long>(thread.startOffset));
      PrintName(thread.moduleName); std::fputc('\n', stderr);
    }
  }
  std::fputs("handle_diagnostic limitations=bounded_copied_metadata;partial_tables_cannot_establish_absence;"
      "numeric_handles_and_thread_ids_can_be_reused;no_kernel_object_identity;names_may_be_truncated;"
      "PSS_and_printing_can_perturb_runtime;no_owner_attribution_or_count_subtraction\n", stderr);
  std::size_t printed = 0U, observed = 0U;
  for (std::size_t i = 0U; i < failure.handleCount; ++i) {
    const auto& value = failure.handles[i];
    const auto* old = FindHandle(baseline, value.value);
    if (old && SameMetadata(*old, value)) continue;
    ++observed;
    if (printed++ < kDiagnosticDifferenceLimit) PrintHandle(old ? "changed_metadata" : "new_observation", value);
  }
  for (std::size_t i = 0U; i < baseline.handleCount; ++i) {
    const auto& value = baseline.handles[i];
    if (FindHandle(failure, value.value)) continue;
    ++observed;
    if (printed++ < kDiagnosticDifferenceLimit) PrintHandle("not_observed_after", value);
  }
  for (std::size_t i = 0U; i < failure.threadCount; ++i) {
    const auto& value = failure.threads[i];
    if (HasThread(baseline, value)) continue;
    ++observed;
    if (printed++ < kDiagnosticDifferenceLimit) std::fprintf(stderr,
        "handle_diagnostic thread=new_or_changed_observation pid=%lu tid=%lu exit=%lu\n",
        value.processId, value.threadId, value.exitStatus);
  }
  std::fprintf(stderr, "handle_diagnostic observed_differences=%zu printed_cap=%zu omitted=%zu\n",
      observed, kDiagnosticDifferenceLimit, observed > kDiagnosticDifferenceLimit ? observed - kDiagnosticDifferenceLimit : 0U);
  SetLastError(preservedError);
}

}  // namespace goatcitadel::remote_worker_provisioner::test
#endif  // GOATCITADEL_PROVISIONER_TESTING
