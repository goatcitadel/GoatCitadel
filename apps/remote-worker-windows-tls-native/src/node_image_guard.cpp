#include "tls_key.hpp"
#include "node_image_guard_api.hpp"
#include "tls_adapter_pin.hpp"
#include "service_identity.hpp"
#include <cstring>
#include <cwchar>
#include <memory>
#include <new>

namespace goatcitadel::worker_tls {
namespace {
INIT_ONCE initialization = INIT_ONCE_STATIC_INIT;
NodeImageGuardApi api{};
bool ready = false;
HMODULE this_module = nullptr;
constexpr wchar_t kGuardName[] = L"GoatCitadelRemoteWorkerImageGuard.node";
constexpr wchar_t kAdapterName[] = L"GoatCitadelRemoteWorkerTlsKey.dll";
constexpr wchar_t kFileExecutorName[] = L"GoatCitadelRemoteWorkerFiles.exe";
constexpr wchar_t kStdioExecutorName[] = L"GoatCitadelRemoteWorkerStdio.exe";
constexpr wchar_t kCellProvisioningName[] = L"GoatCitadelRemoteWorkerCellProvisioning.exe";
enum class InstalledComponent { tls, files, stdio, cell_provisioning };

BOOL CALLBACK Initialize(PINIT_ONCE, PVOID, PVOID*) noexcept {
  HMODULE host = GetModuleHandleW(nullptr);
  if (!host) return TRUE;
#define NAPI_BIND(field) \
  api.field = reinterpret_cast<decltype(api.field)>(GetProcAddress(host, "napi_" #field)); \
  if (!api.field) return TRUE;
  NAPI_BIND(throw_error); NAPI_BIND(get_cb_info); NAPI_BIND(get_value_string_utf8);
  NAPI_BIND(create_object); NAPI_BIND(create_string_utf16); NAPI_BIND(create_function);
  NAPI_BIND(create_external); NAPI_BIND(set_named_property); NAPI_BIND(object_freeze);
  NAPI_BIND(get_boolean);
#undef NAPI_BIND
  // External-value finalizers can outlive a require() cache entry.
  ready = GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
      reinterpret_cast<LPCWSTR>(&initialization), &this_module) != FALSE;
  return TRUE;
}

struct RuntimeImageLeases final {
  PinnedImageLease* adapter = nullptr;
  PinnedImageLease* helper = nullptr;
  ~RuntimeImageLeases() { ReleasePinnedImage(helper); ReleasePinnedImage(adapter); }
};

void __cdecl Finalize(napi_env, void* value, void*) noexcept {
  delete static_cast<RuntimeImageLeases*>(value);
}

napi_value Refuse(napi_env env, const char* reason = "The native image guard is unavailable or received invalid input.") noexcept {
  if (api.throw_error) api.throw_error(env, "REMOTE_WORKER_IMAGE_PIN_REJECTED",
      reason);
  return nullptr;
}

bool InstalledAuthority(KeyAuthority* authority, InstalledComponent component = InstalledComponent::tls) noexcept {
  std::array<wchar_t, kMaximumHelperPathCharacters + 1> path{};
  const DWORD length = GetModuleFileNameW(this_module, path.data(), static_cast<DWORD>(path.size()));
  if (!length || length >= path.size()) return false;
  // Node uses the extended DOS prefix with LoadLibraryExW. Strip only that
  // prefix; PinPath still rejects UNC/device paths and checks the final identity.
  const wchar_t* module_path = path.data();
  if (length > 4 && std::memcmp(module_path, L"\\\\?\\", 4 * sizeof(wchar_t)) == 0) module_path += 4;
  const wchar_t* filename = std::wcsrchr(module_path, L'\\');
  if (!filename || CompareStringOrdinal(filename + 1, -1, kGuardName, -1, TRUE) != CSTR_EQUAL) return false;
  const std::size_t prefix = static_cast<std::size_t>(filename + 1 - module_path);
  const wchar_t* installed_name = component == InstalledComponent::files ? kFileExecutorName :
    component == InstalledComponent::cell_provisioning ? kCellProvisioningName :
    component == InstalledComponent::stdio ? kStdioExecutorName : kAdapterName;
  const auto installed_characters = std::wcslen(installed_name) + 1;
  if (prefix + installed_characters > authority->helper_path.size()) return false;
  std::memcpy(authority->helper_path.data(), module_path, prefix * sizeof(wchar_t));
  std::memcpy(authority->helper_path.data() + prefix, installed_name, installed_characters * sizeof(wchar_t));
  authority->helper_sha256 = component == InstalledComponent::files ? kExpectedFileExecutorDigest :
    component == InstalledComponent::cell_provisioning ? kExpectedCellProvisioningDigest :
    component == InstalledComponent::stdio ? kExpectedStdioExecutorDigest : kExpectedTlsAdapterDigest;
  return true;
}

napi_value __cdecl Pin(napi_env env, napi_callback_info info) noexcept {
  std::array<napi_value, 2> args{};
  std::size_t count = args.size(), length = 0;
  if (!ready || api.get_cb_info(env, info, &count, args.data(), nullptr, nullptr) != kNapiOk || count != 1 ||
      api.get_value_string_utf8(env, args[0], nullptr, 0, &length) != kNapiOk ||
      length == 0 || length > kMaximumIdentifierCharacters) return Refuse(env);
  std::array<char, kMaximumIdentifierCharacters + 1> identifier{};
  std::size_t copied = 0;
  if (api.get_value_string_utf8(env, args[0], identifier.data(), identifier.size(), &copied) != kNapiOk ||
      copied != length || std::memchr(identifier.data(), '\0', length)) return Refuse(env);
  KeyAuthority helper{}, adapter{};
  if (!DecodeIdentifier(identifier.data(), &helper)) return Refuse(env, "The native helper identifier is invalid.");
  if (!InstalledAuthority(&adapter)) return Refuse(env, "The installed image guard has an unexpected module path.");
  std::unique_ptr<RuntimeImageLeases> owned(new (std::nothrow) RuntimeImageLeases);
  if (!owned) return Refuse(env);
  owned->helper = RetainPinnedImage(helper);
  if (!owned->helper) return Refuse(env, "The native helper image or ancestor path differs from its pinned authority.");
  owned->adapter = RetainPinnedImage(adapter);
  if (!owned->adapter) return Refuse(env, "The installed TLS adapter image or ancestor path differs from its compiled pin.");
  napi_value external = nullptr, output = nullptr, adapter_path = nullptr;
  if (api.create_external(env, owned.get(), Finalize, nullptr, &external) != kNapiOk) return Refuse(env);
  owned.release();  // The external-value finalizer owns both leases from this point.
  const auto path_length = wcsnlen_s(adapter.helper_path.data(), adapter.helper_path.size());
  static_assert(sizeof(wchar_t) == sizeof(char16_t));
  if (api.create_object(env, &output) != kNapiOk ||
      api.create_string_utf16(env, reinterpret_cast<const char16_t*>(adapter.helper_path.data()), path_length, &adapter_path) != kNapiOk ||
      api.set_named_property(env, output, "adapterPath", adapter_path) != kNapiOk ||
      api.set_named_property(env, output, "lease", external) != kNapiOk ||
      api.object_freeze(env, output) != kNapiOk) return Refuse(env);
  return output;
}

napi_value PinOwnedExecutor(napi_env env, napi_callback_info info, InstalledComponent component) noexcept {
  napi_value argument = nullptr;
  std::size_t count = 1;
  if (!ready || api.get_cb_info(env, info, &count, &argument, nullptr, nullptr) != kNapiOk || count != 0) return Refuse(env);
  KeyAuthority executor{};
  if (!InstalledAuthority(&executor, component)) return Refuse(env);
  std::unique_ptr<RuntimeImageLeases> owned(new (std::nothrow) RuntimeImageLeases);
  if (!owned) return Refuse(env);
  owned->helper = RetainPinnedImage(executor);
  if (!owned->helper) return Refuse(env, "The installed executor differs from its compiled pin.");
  napi_value external = nullptr, output = nullptr, executor_path = nullptr;
  if (api.create_external(env, owned.get(), Finalize, nullptr, &external) != kNapiOk) return Refuse(env);
  owned.release();
  const auto length = wcsnlen_s(executor.helper_path.data(), executor.helper_path.size());
  if (api.create_object(env, &output) != kNapiOk ||
      api.create_string_utf16(env, reinterpret_cast<const char16_t*>(executor.helper_path.data()), length, &executor_path) != kNapiOk ||
      api.set_named_property(env, output, "executorPath", executor_path) != kNapiOk ||
      api.set_named_property(env, output, "lease", external) != kNapiOk ||
      api.object_freeze(env, output) != kNapiOk) return Refuse(env);
  return output;
}
napi_value __cdecl PinFileExecutor(napi_env env, napi_callback_info info) noexcept {
  return PinOwnedExecutor(env, info, InstalledComponent::files);
}
napi_value __cdecl PinStdioExecutor(napi_env env, napi_callback_info info) noexcept {
  return PinOwnedExecutor(env, info, InstalledComponent::stdio);
}
napi_value __cdecl PinCellProvisioningExecutor(napi_env env, napi_callback_info info) noexcept {
  return PinOwnedExecutor(env, info, InstalledComponent::cell_provisioning);
}
struct StateWriterGate final {
  RuntimeImageLeases images;
  HANDLE directory = INVALID_HANDLE_VALUE, file = INVALID_HANDLE_VALUE;
  worker_host::WorkerStateGateLock lock;
  DWORD thread = GetCurrentThreadId();
  bool paused = false, failed = false;
  ~StateWriterGate() {
    lock.Release();
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    if (directory != INVALID_HANDLE_VALUE) CloseHandle(directory);
  }
};
std::unique_ptr<StateWriterGate> state_gate;
bool NoArguments(napi_env env, napi_callback_info info) noexcept {
  napi_value argument = nullptr; std::size_t count = 1;
  return ready && api.get_cb_info(env, info, &count, &argument, nullptr, nullptr) == kNapiOk && count == 0;
}
napi_value Boolean(napi_env env, bool value) noexcept {
  napi_value result = nullptr;
  return api.get_boolean(env, value, &result) == kNapiOk ? result : Refuse(env);
}
napi_value __cdecl StartStateWriterGate(napi_env env, napi_callback_info info) noexcept {
  if (!NoArguments(env, info) || state_gate) return Refuse(env);
  try {
    KeyAuthority executor{}; worker_host::TokenIdentity token;
    if (!InstalledAuthority(&executor, InstalledComponent::cell_provisioning) ||
        !worker_host::CollectWorkerToken(&token) || !worker_host::ValidateWorkerToken(token)) return Refuse(env);
    const std::wstring path(executor.helper_path.data());
    const std::wstring suffix = L"\\payload\\app\\native\\GoatCitadelRemoteWorkerCellProvisioning.exe";
    if (path.size() <= suffix.size() || CompareStringOrdinal(path.c_str() + path.size() - suffix.size(), -1, suffix.c_str(), -1, TRUE) != CSTR_EQUAL) return Refuse(env);
    auto gate = std::make_unique<StateWriterGate>();
    gate->images.helper = RetainPinnedImage(executor);
    if (!gate->images.helper) return Refuse(env);
    const auto directory = path.substr(0, path.size() - suffix.size()) + L"\\configuration";
    gate->directory = CreateFileW(directory.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    FILE_ATTRIBUTE_TAG_INFO directory_info{};
    if (gate->directory == INVALID_HANDLE_VALUE || GetFileType(gate->directory) != FILE_TYPE_DISK ||
        !GetFileInformationByHandleEx(gate->directory, FileAttributeTagInfo, &directory_info, sizeof(directory_info)) ||
        !(directory_info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (directory_info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
        !worker_host::VerifyWorkerFileHandle(gate->directory)) return Refuse(env);
    gate->file = CreateFileW((directory + L"\\state-writers.guard").c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, nullptr,
      OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (gate->file == INVALID_HANDLE_VALUE || !worker_host::VerifyWorkerFileHandle(gate->file) || gate->lock.Acquire(gate->file, false)) return Refuse(env);
    state_gate = std::move(gate); return Boolean(env, true);
  } catch (...) { return Refuse(env); }
}
napi_value __cdecl PauseStateWriterGate(napi_env env, napi_callback_info info) noexcept {
  if (!NoArguments(env, info) || !state_gate || state_gate->thread != GetCurrentThreadId() || state_gate->paused || state_gate->failed) return Refuse(env);
  if (state_gate->lock.Check() || state_gate->lock.Release()) { state_gate->failed = true; return Refuse(env); }
  state_gate->paused = true; return Boolean(env, true);
}
napi_value __cdecl ResumeStateWriterGate(napi_env env, napi_callback_info info) noexcept {
  if (!NoArguments(env, info) || !state_gate || state_gate->thread != GetCurrentThreadId() || !state_gate->paused || state_gate->failed) return Refuse(env);
  const auto error = state_gate->lock.Acquire(state_gate->file, false);
  if (error == ERROR_LOCK_VIOLATION) return Boolean(env, false);
  if (error) { state_gate->failed = true; return Refuse(env); }
  state_gate->paused = false; return Boolean(env, true);
}
}

napi_value RegisterImageGuard(napi_env env, napi_value exports) noexcept {
  if (!InitOnceExecuteOnce(&initialization, Initialize, nullptr, nullptr) || !ready) return Refuse(env);
  napi_value pin = nullptr, pin_file_executor = nullptr, pin_stdio_executor = nullptr, pin_cell_provisioning = nullptr;
  napi_value start_gate = nullptr, pause_gate = nullptr, resume_gate = nullptr;
  if (api.create_function(env, "pin", 3, Pin, nullptr, &pin) != kNapiOk ||
      api.set_named_property(env, exports, "pin", pin) != kNapiOk ||
      api.create_function(env, "pinFileExecutor", 15, PinFileExecutor, nullptr, &pin_file_executor) != kNapiOk ||
      api.set_named_property(env, exports, "pinFileExecutor", pin_file_executor) != kNapiOk ||
      api.create_function(env, "pinStdioExecutor", 16, PinStdioExecutor, nullptr, &pin_stdio_executor) != kNapiOk ||
      api.set_named_property(env, exports, "pinStdioExecutor", pin_stdio_executor) != kNapiOk ||
      api.create_function(env, "pinCellProvisioningExecutor", 27, PinCellProvisioningExecutor, nullptr, &pin_cell_provisioning) != kNapiOk ||
      api.set_named_property(env, exports, "pinCellProvisioningExecutor", pin_cell_provisioning) != kNapiOk ||
      api.create_function(env, "startStateWriterGate", 20, StartStateWriterGate, nullptr, &start_gate) != kNapiOk ||
      api.set_named_property(env, exports, "startStateWriterGate", start_gate) != kNapiOk ||
      api.create_function(env, "pauseStateWriterGate", 20, PauseStateWriterGate, nullptr, &pause_gate) != kNapiOk ||
      api.set_named_property(env, exports, "pauseStateWriterGate", pause_gate) != kNapiOk ||
      api.create_function(env, "resumeStateWriterGate", 21, ResumeStateWriterGate, nullptr, &resume_gate) != kNapiOk ||
      api.set_named_property(env, exports, "resumeStateWriterGate", resume_gate) != kNapiOk ||
      api.object_freeze(env, exports) != kNapiOk) return Refuse(env);
  return exports;
}
}

extern "C" __declspec(dllexport) std::int32_t __cdecl node_api_module_get_api_version_v1() { return 8; }
extern "C" __declspec(dllexport) goatcitadel::worker_tls::napi_value __cdecl napi_register_module_v1(
    goatcitadel::worker_tls::napi_env env, goatcitadel::worker_tls::napi_value exports) {
  return goatcitadel::worker_tls::RegisterImageGuard(env, exports);
}
