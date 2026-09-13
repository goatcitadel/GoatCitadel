#include "cell_ntfs_format_wmi.hpp"
#include <algorithm>
#include <new>
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "wbemuuid.lib")

namespace goatcitadel::worker_cell {
namespace {
DWORD Error() noexcept { const DWORD error = GetLastError(); return error ? error : ERROR_GEN_FAILURE; }
DWORD FromCom(HRESULT status) noexcept {
  if (SUCCEEDED(status)) return ERROR_SUCCESS;
  if (status == WBEM_E_NOT_FOUND) return ERROR_NOT_FOUND;
  if (status == WBEM_E_ACCESS_DENIED) return ERROR_ACCESS_DENIED;
  if (status == E_OUTOFMEMORY) return ERROR_NOT_ENOUGH_MEMORY;
  return HRESULT_FACILITY(status) == FACILITY_WIN32 ? HRESULT_CODE(status) : ERROR_GEN_FAILURE;
}
DWORD Control(ULONGLONG deadline, HANDLE cancellation) noexcept {
  if (cancellation) {
    if (cancellation == INVALID_HANDLE_VALUE || cancellation == GetCurrentThread()) return ERROR_INVALID_HANDLE;
    const DWORD state = WaitForSingleObject(cancellation, 0);
    if (state == WAIT_OBJECT_0) return ERROR_CANCELLED;
    if (state != WAIT_TIMEOUT) return state == WAIT_FAILED ? Error() : ERROR_INVALID_HANDLE;
  }
  return GetTickCount64() >= deadline ? ERROR_TIMEOUT : ERROR_SUCCESS;
}
long Slice(ULONGLONG deadline) noexcept {
  const auto now = GetTickCount64();
  return now >= deadline ? 0 : static_cast<long>(std::min<ULONGLONG>(100, deadline - now));
}
template<typename T> struct Com final {
  T* value = nullptr;
  ~Com() { if (value) value->Release(); }
  Com() = default;
  Com(const Com&) = delete;
  Com& operator=(const Com&) = delete;
};
struct Apartment final {
  HRESULT status = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  ~Apartment() { if (SUCCEEDED(status)) CoUninitialize(); }
};
struct String final {
  BSTR value;
  explicit String(std::wstring_view text) : value(SysAllocStringLen(text.data(), static_cast<UINT>(text.size()))) {
    if (!value) throw std::bad_alloc();
  }
  ~String() { SysFreeString(value); }
  String(const String&) = delete;
  String& operator=(const String&) = delete;
};
struct Variant final {
  VARIANT value{};
  ~Variant() { VariantClear(&value); }
};
DWORD Blanket(IUnknown* value) noexcept {
  return FromCom(CoSetProxyBlanket(value, RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE, nullptr,
    RPC_C_AUTHN_LEVEL_PKT_PRIVACY, RPC_C_IMP_LEVEL_IMPERSONATE, nullptr, EOAC_NONE));
}
DWORD Connect(IWbemServices** output) {
  *output = nullptr; Com<IWbemLocator> locator;
  DWORD error = FromCom(CoCreateInstance(CLSID_WbemLocator, nullptr, CLSCTX_INPROC_SERVER,
    IID_IWbemLocator, reinterpret_cast<void**>(&locator.value)));
  String name(L"ROOT\\Microsoft\\Windows\\Storage");
  if (!error) error = FromCom(locator.value->ConnectServer(name.value, nullptr, nullptr, nullptr,
    WBEM_FLAG_CONNECT_USE_MAX_WAIT, nullptr, nullptr, output));
  if (!error && !*output) error = ERROR_INVALID_DATA;
  if (!error) error = Blanket(*output);
  return error;
}
DWORD Text(IWbemClassObject* object, const wchar_t* key, std::size_t maximum, std::wstring* output) {
  output->clear(); Variant property; CIMTYPE type = 0;
  DWORD error = FromCom(object->Get(key, 0, &property.value, &type, nullptr));
  if (error) return error;
  if (type != CIM_STRING || property.value.vt != VT_BSTR || !property.value.bstrVal ||
      SysStringLen(property.value.bstrVal) > maximum) return ERROR_INVALID_DATA;
  output->assign(property.value.bstrVal, SysStringLen(property.value.bstrVal));
  if (output->find(L'\0') != std::wstring::npos) return ERROR_INVALID_DATA;
  return ERROR_SUCCESS;
}
DWORD Unsigned(IWbemClassObject* object, const wchar_t* key, CIMTYPE expected_type, DWORD* output) noexcept {
  *output = 0; Variant property; CIMTYPE type = 0;
  DWORD error = FromCom(object->Get(key, 0, &property.value, &type, nullptr));
  if (error) return error;
  if (type != expected_type) return ERROR_INVALID_DATA;
  if (property.value.vt == VT_I4 && property.value.lVal >= 0) *output = static_cast<DWORD>(property.value.lVal);
  else if (property.value.vt == VT_UI4) *output = property.value.ulVal;
  else return ERROR_INVALID_DATA;
  if (expected_type == CIM_UINT16 && *output > 65535) return ERROR_INVALID_DATA;
  return ERROR_SUCCESS;
}
DWORD Next(IEnumWbemClassObject* enumeration, IWbemClassObject** output, ULONGLONG deadline, HANDLE cancellation) noexcept {
  *output = nullptr;
  for (;;) {
    DWORD error = Control(deadline, cancellation);
    if (error) return error;
    ULONG count = 0;
    const HRESULT status = enumeration->Next(Slice(deadline), 1, output, &count);
    if (FAILED(status)) return FromCom(status);
    if (count > 1 || (count == 1 && !*output) || (count == 0 && *output)) return ERROR_INVALID_DATA;
    if (count == 1 || status == WBEM_S_FALSE) return Control(deadline, cancellation);
    if (status != WBEM_S_TIMEDOUT) return ERROR_INVALID_DATA;
  }
}
struct Target final { CellNtfsTargetFilesystem filesystem = CellNtfsTargetFilesystem::other; std::wstring object_path; };
DWORD Select(IWbemServices* services, const std::wstring& volume_path, Target* target,
             ULONGLONG deadline, HANDLE cancellation) {
  if (!IsCellVolumeGuidPath(volume_path)) return ERROR_INVALID_NAME;
  std::wstring query = L"SELECT * FROM MSFT_Volume WHERE Path = '";
  for (const auto character : volume_path) { if (character == L'\\') query += L'\\'; query += character; }
  query += L'\'';
  String language(L"WQL"), text(query); Com<IEnumWbemClassObject> enumeration;
  DWORD error = Control(deadline, cancellation);
  if (!error) error = FromCom(services->ExecQuery(language.value, text.value,
    WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY, nullptr, &enumeration.value));
  if (!error && !enumeration.value) error = ERROR_INVALID_DATA;
  if (!error) error = Blanket(enumeration.value);
  Com<IWbemClassObject> object, extra;
  if (!error) error = Next(enumeration.value, &object.value, deadline, cancellation);
  if (!error && !object.value) error = ERROR_NOT_FOUND;
  if (!error) error = Next(enumeration.value, &extra.value, deadline, cancellation);
  if (!error && extra.value) error = ERROR_DUP_NAME;
  std::wstring path, filesystem, label; DWORD type = 0;
  if (!error) error = Text(object.value, L"Path", 49, &path);
  if (!error && (!IsCellVolumeGuidPath(path) || CompareStringOrdinal(path.c_str(), -1, volume_path.c_str(), -1, TRUE) != CSTR_EQUAL)) error = ERROR_FILE_INVALID;
  if (!error) error = Text(object.value, L"__RELPATH", 4096, &target->object_path);
  if (!error && !target->object_path.starts_with(L"MSFT_Volume.")) error = ERROR_INVALID_DATA;
  if (!error) error = Text(object.value, L"FileSystem", 16, &filesystem);
  if (!error) error = Unsigned(object.value, L"FileSystemType", CIM_UINT16, &type);
  if (!error) {
    if (type == 0 && (filesystem.empty() || filesystem == L"RAW")) target->filesystem = CellNtfsTargetFilesystem::raw;
    else if (type == 14 && filesystem == L"NTFS") {
      error = Text(object.value, L"FileSystemLabel", 32, &label);
      if (!error && label == L"GoatCitadel cell") target->filesystem = CellNtfsTargetFilesystem::ntfs;
    }
  }
  return error ? error : Control(deadline, cancellation);
}
DWORD NoMountPaths(const std::wstring& path) noexcept {
  std::array<wchar_t, 4> paths{}; DWORD needed = 0;
  if (!GetVolumePathNamesForVolumeNameW(path.c_str(), paths.data(), static_cast<DWORD>(paths.size()), &needed)) {
    const DWORD error = Error(); return error == ERROR_MORE_DATA ? ERROR_ALREADY_EXISTS : error;
  }
  return needed >= 1 && needed <= 2 && paths[0] == L'\0' && paths[1] == L'\0' ? ERROR_SUCCESS : ERROR_ALREADY_EXISTS;
}
DWORD PutString(IWbemClassObject* object, const wchar_t* name, const wchar_t* value) {
  String text(value); VARIANT variant{}; variant.vt = VT_BSTR; variant.bstrVal = text.value;
  return FromCom(object->Put(name, 0, &variant, 0));
}
DWORD PutBoolean(IWbemClassObject* object, const wchar_t* name, bool value) noexcept {
  VARIANT variant{}; variant.vt = VT_BOOL; variant.boolVal = value ? VARIANT_TRUE : VARIANT_FALSE;
  return FromCom(object->Put(name, 0, &variant, 0));
}
DWORD Wait(IWbemCallResult* result, ULONGLONG deadline, HANDLE cancellation) noexcept {
  for (;;) {
    DWORD error = Control(deadline, cancellation);
    if (error) return error;
    long operation_status = E_FAIL;
    const HRESULT status = result->GetCallStatus(Slice(deadline), &operation_status);
    if (status == WBEM_S_TIMEDOUT) continue;
    if (FAILED(status)) return FromCom(status);
    if (status != WBEM_S_NO_ERROR) return ERROR_INVALID_DATA;
    error = FromCom(operation_status);
    return error ? error : Control(deadline, cancellation);
  }
}
DWORD FormatResult(DWORD status) noexcept {
  switch (status) {
    case 0: return ERROR_SUCCESS;
    case 1: return ERROR_NOT_SUPPORTED;
    case 3: return ERROR_TIMEOUT;
    case 5: return ERROR_INVALID_PARAMETER;
    case 40001: case 40018: case 42010: return ERROR_ACCESS_DENIED;
    case 40004: return ERROR_IO_DEVICE;
    case 43006: return ERROR_WRITE_PROTECT;
    default: return ERROR_GEN_FAILURE;
  }
}
}
DWORD CellNtfsFormatWmi::Parameters(IWbemClassObject* signature, IWbemClassObject** output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = nullptr;
  if (!signature) return ERROR_INVALID_PARAMETER;
  try {
    Com<IWbemClassObject> parameters;
    DWORD error = FromCom(signature->SpawnInstance(0, &parameters.value));
    if (!error && !parameters.value) error = ERROR_INVALID_DATA;
    if (!error) error = PutString(parameters.value, L"FileSystem", L"NTFS");
    if (!error) error = PutString(parameters.value, L"FileSystemLabel", L"GoatCitadel cell");
    VARIANT cluster{}; cluster.vt = VT_I4; cluster.lVal = 4096;
    if (!error) error = FromCom(parameters.value->Put(L"AllocationUnitSize", 0, &cluster, 0));
    // SetIntegrityStreams is intentionally omitted: it applies only to ReFS.
    for (const auto* name : {L"Full", L"Force", L"Compress", L"ShortFileNameSupport", L"UseLargeFRS", L"DisableHeatGathering"})
      if (!error) error = PutBoolean(parameters.value, name, false);
    if (!error) { *output = parameters.value; parameters.value = nullptr; }
    return error;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellNtfsFormatWmi::Read(const std::wstring& volume_path, CellNtfsTargetFilesystem* filesystem,
                            ULONGLONG deadline, HANDLE cancellation) noexcept {
  if (!filesystem) return ERROR_INVALID_PARAMETER;
  *filesystem = CellNtfsTargetFilesystem::other;
  if (!IsCellVolumeGuidPath(volume_path)) return ERROR_INVALID_NAME;
  DWORD error = Control(deadline, cancellation);
  if (error) return error;
  try {
    Apartment apartment; error = FromCom(apartment.status);
    Com<IWbemServices> services; Target target;
    if (!error) error = Connect(&services.value);
    if (!error) error = Select(services.value, volume_path, &target, deadline, cancellation);
    if (!error) *filesystem = target.filesystem;
    return error;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellNtfsFormatWmi::Format(const std::wstring& volume_path, DWORD (*before_send)(void*) noexcept,
                              void* context, ULONGLONG deadline, HANDLE cancellation) noexcept {
  if (!before_send) return ERROR_INVALID_PARAMETER;
  if (!IsCellVolumeGuidPath(volume_path)) return ERROR_INVALID_NAME;
  DWORD error = Control(deadline, cancellation);
  if (error) return error;
  try {
    Apartment apartment; error = FromCom(apartment.status);
    Com<IWbemServices> services; Target target;
    if (!error) error = Connect(&services.value);
    if (!error) error = Select(services.value, volume_path, &target, deadline, cancellation);
    if (!error && target.filesystem != CellNtfsTargetFilesystem::raw) error = ERROR_ALREADY_EXISTS;
    Com<IWbemClassObject> definition, signature, parameters;
    String class_name(L"MSFT_Volume"), method(L"Format"), object_path(target.object_path);
    if (!error) error = FromCom(services.value->GetObject(class_name.value, 0, nullptr, &definition.value, nullptr));
    if (!error && !definition.value) error = ERROR_INVALID_DATA;
    if (!error) error = FromCom(definition.value->GetMethod(L"Format", 0, &signature.value, nullptr));
    if (!error) error = Parameters(signature.value, &parameters.value);
    if (!error) error = NoMountPaths(volume_path);
    // Preparation may wait on COM. Re-enter current authority and the bound
    // kernel/RAW-volume checks immediately before the only mutating API call.
    if (!error) error = before_send(context);
    // The authority exchange can wait. Refuse a drive letter or directory mount
    // added during that wait before the storage provider receives a format.
    if (!error) error = NoMountPaths(volume_path);
    if (!error) error = Control(deadline, cancellation);
    Com<IWbemCallResult> result;
    if (!error) error = FromCom(services.value->ExecMethod(object_path.value, method.value, WBEM_FLAG_RETURN_IMMEDIATELY,
      nullptr, parameters.value, nullptr, &result.value));
    if (!error && !result.value) error = ERROR_INVALID_DATA;
    if (!error) error = Wait(result.value, deadline, cancellation);
    Com<IWbemClassObject> output; DWORD status = 0;
    if (!error) error = FromCom(result.value->GetResultObject(0, &output.value));
    if (!error && !output.value) error = ERROR_INVALID_DATA;
    if (!error) error = Unsigned(output.value, L"ReturnValue", CIM_UINT32, &status);
    if (!error) error = FormatResult(status);
    // A timeout/cancel/provider failure after submission is uncertain. Releasing
    // these COM interfaces does not establish cancellation of Windows formatting.
    return error ? error : Control(deadline, cancellation);
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
}
