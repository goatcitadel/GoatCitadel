#include "cell_runtime_bundle.hpp"

namespace goatcitadel::worker_cell {
namespace {
struct RuntimeCapture final {
  const JobQuiescenceObserver& observer;
  CellWorkspaceDirectories* workspace;
  static DWORD Authorize(void* context) noexcept {
    auto& value = *static_cast<RuntimeCapture*>(context);
    const DWORD error = value.observer.authorize(value.observer.context);
    return error ? error : value.workspace ? value.workspace->Verify() : ERROR_SUCCESS;
  }
  static DWORD Capture(void* context, const JobQuiescence& job) noexcept {
    auto& value = *static_cast<RuntimeCapture*>(context);
    return value.observer.capture(value.observer.context, job);
  }
  static DWORD AuthorizeExecution(void* context) noexcept {
    auto& value = *static_cast<RuntimeCapture*>(context);
    const DWORD error = value.observer.authorize_execution(value.observer.context);
    return error ? error : value.workspace ? value.workspace->Verify() : ERROR_SUCCESS;
  }
  static void Discard(void* context) noexcept {
    auto& value = *static_cast<RuntimeCapture*>(context); value.observer.discard(value.observer.context);
  }
};
}
RuntimeJobResult RunVerifiedRuntimeJob(const RuntimeJobCommand& input, const JobLimits& limits,
                                     HANDLE cancellation, JobStdioChannel* stdio, const JobQuiescenceObserver* observer_input) noexcept {
  RuntimeJobResult result;
  const JobQuiescenceObserver observer = observer_input ? *observer_input : JobQuiescenceObserver{};
  struct CaptureLifetime final {
    const JobQuiescenceObserver& observer;
    const RuntimeJobResult& result;
    ~CaptureLifetime() { if (observer.discard && !result.job.quiescent_capture_verified) observer.discard(observer.context); }
  } capture_lifetime{observer, result};
  try {
    if (observer_input && (!observer.authorize || !observer.capture || !observer.discard || !observer.wall_ms || observer.wall_ms > 60000)) {
      result.job.error = ERROR_INVALID_PARAMETER; return result;
    }
    if (input.runtime_files.empty() || input.runtime_files.size() > 4096 ||
        limits.input_bytes > kMaximumCellJobInputBytes ||
        input.launch.standard_input.size() > limits.input_bytes ||
        (stdio && !input.launch.standard_input.empty())) {
      result.job.error = ERROR_INVALID_PARAMETER;
      return result;
    }
    CellFileSha256 manifest{};
    result.job.error = HashRuntimeBundleManifest(input.runtime_files, &manifest);
    if (result.job.error) return result;
    if (manifest != input.expected_runtime_bundle) { result.job.error = ERROR_CRC; return result; }
    const RuntimeJobCommand command = input;
    CellWorkspaceDirectories workspace;
    if (command.protected_workspace) {
      const auto& reference = *command.protected_workspace;
      if (!IsLiteralCellPath(reference.parent_path) ||
          command.expected_runtime_root != reference.identities.directories[static_cast<std::size_t>(CellDirectory::runtime)] ||
          command.launch.expected_directory_identity != reference.identities.directories[static_cast<std::size_t>(CellDirectory::work)]) {
        result.job.error = ERROR_INVALID_PARAMETER;
        return result;
      }
      const HANDLE parent = CreateFileW(reference.parent_path.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
      if (parent == INVALID_HANDLE_VALUE) { result.job.error = GetLastError(); return result; }
      result.job.error = workspace.OpenRecorded(parent, reference.identities, command.launch.job_name,
        reference.owner_sid, reference.controller_sid);
      CloseHandle(parent);
      if (result.job.error) return result;
    }
    PinnedCellRuntimeBundle bundle;
    result.job.error = bundle.Open(command.runtime_root, command.expected_runtime_root,
                                  command.runtime_files, command.expected_runtime_bundle, cancellation);
    if (result.job.error) {
      if (result.job.error == ERROR_CANCELLED) result.job.end = JobEnd::cancelled;
      return result;
    }
    if (!bundle.ContainsImage(command.launch.image, command.launch.expected_image_sha256)) {
      result.job.error = ERROR_FILE_INVALID;
      return result;
    }
    result.runtime_bundle_verified = true;
    result.runtime_bundle_sha256 = command.expected_runtime_bundle;
    if (command.protected_workspace) {
      result.job.error = workspace.Verify();
      if (result.job.error) return result;
    }
    RuntimeCapture capture{observer, command.protected_workspace ? &workspace : nullptr};
    const JobQuiescenceObserver wrapped{&capture, RuntimeCapture::Authorize, RuntimeCapture::Capture, RuntimeCapture::Discard, observer.wall_ms,
      observer.authorize_execution ? RuntimeCapture::AuthorizeExecution : nullptr};
    result.job = RunBoundedJob(command.launch, limits, cancellation, stdio, observer_input ? &wrapped : nullptr);
    if (command.protected_workspace) {
      const DWORD workspace_error = workspace.Verify();
      result.protected_workspace_verified = workspace_error == ERROR_SUCCESS;
      if (workspace_error && observer_input) {
        result.job.quiescent_capture_verified = false;
        if (!result.job.quiescent_capture_error) result.job.quiescent_capture_error = workspace_error;
      }
      if (workspace_error && !result.job.error) {
        result.job.error = workspace_error;
        result.job.end = JobEnd::control_failed;
      }
    }
    return result;
  } catch (...) { result.job.error = ERROR_NOT_ENOUGH_MEMORY; return result; }
}
}  // namespace goatcitadel::worker_cell
