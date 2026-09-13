#pragma once
#include <cstddef>
#include <cstdint>

// The Node-API v8 C ABI used by this small addon. Resolve these public exports
// from the current Node executable; do not load another runtime or node.dll.
// Signatures: nodejs/node v24.19.0 src/js_native_api.h and js_native_api_types.h.
namespace goatcitadel::worker_tls {
struct napi_env__;
struct napi_value__;
struct napi_callback_info__;
using napi_env = napi_env__*;
using napi_value = napi_value__*;
using napi_callback_info = napi_callback_info__*;
using napi_status = int;
using napi_callback = napi_value (__cdecl*)(napi_env, napi_callback_info);
using napi_finalize = void (__cdecl*)(napi_env, void*, void*);
constexpr napi_status kNapiOk = 0;
struct NodeImageGuardApi final {
  napi_status (__cdecl* get_cb_info)(napi_env, napi_callback_info, std::size_t*, napi_value*, napi_value*, void**);
  napi_status (__cdecl* get_value_string_utf8)(napi_env, napi_value, char*, std::size_t, std::size_t*);
  napi_status (__cdecl* create_object)(napi_env, napi_value*);
  napi_status (__cdecl* create_string_utf16)(napi_env, const char16_t*, std::size_t, napi_value*);
  napi_status (__cdecl* create_function)(napi_env, const char*, std::size_t, napi_callback, void*, napi_value*);
  napi_status (__cdecl* create_external)(napi_env, void*, napi_finalize, void*, napi_value*);
  napi_status (__cdecl* set_named_property)(napi_env, napi_value, const char*, napi_value);
  napi_status (__cdecl* object_freeze)(napi_env, napi_value);
  napi_status (__cdecl* throw_error)(napi_env, const char*, const char*);
};
}
