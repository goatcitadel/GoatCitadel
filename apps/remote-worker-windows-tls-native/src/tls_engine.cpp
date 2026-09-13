#include "tls_key.hpp"
#include "openssl_engine_api.hpp"
#include <cstring>
#include <new>

namespace goatcitadel::worker_tls {
namespace {
constexpr int kEd25519 = 1087;
constexpr int kSignatureContextCustom = 4;
constexpr int kEngineExClass = 10;
constexpr int kPkeyExClass = 17;
constexpr char kEngineId[] = "goatcitadel-worker-tls-v1";
OpenSslApi api{};
INIT_ONCE initialized = INIT_ONCE_STATIC_INIT;
int key_index = -1;
int engine_index = -1;
bool api_ready = false;

struct EngineContext { EVP_PKEY_METHOD* method = nullptr; };
struct KeyContext {
  KeyAuthority authority;
  HANDLE image = INVALID_HANDLE_VALUE;
  ~KeyContext() { if (image != INVALID_HANDLE_VALUE) CloseHandle(image); }
};

void FreeKey(void*, void* ptr, CRYPTO_EX_DATA*, int, long, void*) {
  delete static_cast<KeyContext*>(ptr);
}
int DuplicateKey(CRYPTO_EX_DATA*, const CRYPTO_EX_DATA*, void** ptr, int, long, void*) {
  if (!ptr || !*ptr) return 1;
  const auto* original = static_cast<KeyContext*>(*ptr);
  auto* copy = new (std::nothrow) KeyContext;
  if (!copy) return 0;
  copy->authority = original->authority;
  if (!DuplicateHandle(GetCurrentProcess(), original->image, GetCurrentProcess(), &copy->image, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
    delete copy; return 0;
  }
  *ptr = copy;
  return 1;
}
void FreeEngine(void*, void* ptr, CRYPTO_EX_DATA*, int, long, void*) {
  // OpenSSL frees dynamic pkey methods before running engine ex-data cleanup.
  delete static_cast<EngineContext*>(ptr);
}

BOOL CALLBACK Initialize(PINIT_ONCE, PVOID, PVOID*) noexcept {
  HMODULE host = GetModuleHandleW(nullptr);
  if (!host) return TRUE;
#define RESOLVE(name) \
  api.name = reinterpret_cast<decltype(api.name)>(GetProcAddress(host, #name)); \
  if (!api.name) return TRUE
  RESOLVE(OpenSSL_version_num);
  if (api.OpenSSL_version_num() != 0x30500070UL) return TRUE;
  RESOLVE(ENGINE_set_id); RESOLVE(ENGINE_set_name);
  RESOLVE(ENGINE_set_pkey_meths); RESOLVE(ENGINE_set_load_privkey_function);
  RESOLVE(ENGINE_set_ex_data); RESOLVE(ENGINE_get_ex_data);
  RESOLVE(CRYPTO_get_ex_new_index);
  RESOLVE(EVP_PKEY_meth_new); RESOLVE(EVP_PKEY_meth_find);
  RESOLVE(EVP_PKEY_meth_copy); RESOLVE(EVP_PKEY_meth_free);
  RESOLVE(EVP_PKEY_meth_set_digestsign); RESOLVE(EVP_PKEY_new_raw_public_key);
  RESOLVE(EVP_PKEY_set1_engine); RESOLVE(EVP_PKEY_free);
  RESOLVE(EVP_PKEY_set_ex_data); RESOLVE(EVP_PKEY_get_ex_data);
  RESOLVE(EVP_MD_CTX_get_pkey_ctx); RESOLVE(EVP_PKEY_CTX_get0_pkey);
  RESOLVE(EVP_MD_CTX_new); RESOLVE(EVP_MD_CTX_free);
  RESOLVE(EVP_DigestVerifyInit); RESOLVE(EVP_DigestVerify);
#undef RESOLVE
  // Ex-data callbacks remain in the host's registry after an individual engine
  // is released. Pin their code before registering either callback.
  HMODULE retained = nullptr;
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
      reinterpret_cast<LPCWSTR>(&initialized), &retained)) return TRUE;
  key_index = api.CRYPTO_get_ex_new_index(kPkeyExClass, 0, nullptr, nullptr, DuplicateKey, FreeKey);
  engine_index = api.CRYPTO_get_ex_new_index(kEngineExClass, 0, nullptr, nullptr, nullptr, FreeEngine);
  api_ready = key_index >= 0 && engine_index >= 0;
  return TRUE;
}

bool VerifySignature(const KeyAuthority& authority, const std::array<std::uint8_t, 64>& signature,
    const unsigned char* preimage, std::size_t length) noexcept {
  EVP_PKEY* public_key = api.EVP_PKEY_new_raw_public_key(kEd25519, nullptr, authority.spki.data() + 12, 32);
  EVP_MD_CTX* context = api.EVP_MD_CTX_new();
  const bool valid = public_key && context &&
      api.EVP_DigestVerifyInit(context, nullptr, nullptr, nullptr, public_key) == 1 &&
      api.EVP_DigestVerify(context, signature.data(), signature.size(), preimage, length) == 1;
  api.EVP_MD_CTX_free(context); api.EVP_PKEY_free(public_key);
  return valid;
}

int Sign(EVP_MD_CTX* context, unsigned char* signature, std::size_t* capacity,
    const unsigned char* preimage, std::size_t length) {
  if (!context || !capacity || !IsClientCertificateVerify(preimage, length)) return 0;
  EVP_PKEY_CTX* key_context = api.EVP_MD_CTX_get_pkey_ctx(context);
  EVP_PKEY* key = key_context ? api.EVP_PKEY_CTX_get0_pkey(key_context) : nullptr;
  const auto* owned = key ? static_cast<KeyContext*>(api.EVP_PKEY_get_ex_data(key, key_index)) : nullptr;
  if (!owned) return 0;
  if (!signature) { *capacity = 64; return 1; }
  if (*capacity < 64) return 0;
  std::array<std::uint8_t, 64> result{};
  if (!SignWithPinnedHelper(owned->authority, owned->image, preimage, length, &result) ||
      !VerifySignature(owned->authority, result, preimage, length)) return 0;
  std::memcpy(signature, result.data(), result.size());
  *capacity = result.size();
  return 1;
}

int Methods(ENGINE* engine, EVP_PKEY_METHOD** method, const int** identifiers, int id) {
  static const int supported[] = {kEd25519};
  if (!method) { if (!identifiers) return 0; *identifiers = supported; return 1; }
  *method = nullptr;
  auto* context = static_cast<EngineContext*>(api.ENGINE_get_ex_data(engine, engine_index));
  if (!context || id != kEd25519) return 0;
  *method = context->method;
  return *method ? 1 : 0;
}

EVP_PKEY* Load(ENGINE* engine, const char* identifier, UI_METHOD*, void*) {
  auto* owned = new (std::nothrow) KeyContext;
  if (!owned) return nullptr;
  if (!DecodeIdentifier(identifier, &owned->authority)) { delete owned; return nullptr; }
  owned->image = OpenPinnedHelper(owned->authority);
  if (owned->image == INVALID_HANDLE_VALUE) { delete owned; return nullptr; }
  EVP_PKEY* key = api.EVP_PKEY_new_raw_public_key(kEd25519, nullptr, owned->authority.spki.data() + 12, 32);
  if (!key || api.EVP_PKEY_set_ex_data(key, key_index, owned) != 1) {
    api.EVP_PKEY_free(key); delete owned; return nullptr;
  }
  if (api.EVP_PKEY_set1_engine(key, engine) != 1) { api.EVP_PKEY_free(key); return nullptr; }
  return key;
}
}  // namespace

int Bind(ENGINE* engine, const char* identifier) noexcept {
  if (!engine || (identifier && std::strcmp(identifier, kEngineId) != 0) ||
      !InitOnceExecuteOnce(&initialized, Initialize, nullptr, nullptr) || !api_ready ||
      api.ENGINE_get_ex_data(engine, engine_index)) return 0;
  const EVP_PKEY_METHOD* original = api.EVP_PKEY_meth_find(kEd25519);
  auto* context = new (std::nothrow) EngineContext;
  if (!original || !context) { delete context; return 0; }
  context->method = api.EVP_PKEY_meth_new(kEd25519, kSignatureContextCustom);
  if (!context->method) { delete context; return 0; }
  api.EVP_PKEY_meth_copy(context->method, original);
  api.EVP_PKEY_meth_set_digestsign(context->method, Sign);
  if (!api.ENGINE_set_id(engine, kEngineId) || !api.ENGINE_set_name(engine, "GoatCitadel protected worker TLS key") ||
      !api.ENGINE_set_load_privkey_function(engine, Load) || !api.ENGINE_set_ex_data(engine, engine_index, context)) {
    api.EVP_PKEY_meth_free(context->method); delete context; return 0;
  }
  if (!api.ENGINE_set_pkey_meths(engine, Methods)) {
    api.ENGINE_set_ex_data(engine, engine_index, nullptr);
    api.EVP_PKEY_meth_free(context->method); delete context; return 0;
  }
  return 1;
}
}  // namespace goatcitadel::worker_tls

extern "C" __declspec(dllexport) unsigned long v_check(unsigned long version) {
  return version >= 0x00030000UL ? 0x00030000UL : 0;
}
extern "C" __declspec(dllexport) int bind_engine(goatcitadel::worker_tls::ENGINE* engine,
    const char* identifier, const void*) {
  return goatcitadel::worker_tls::Bind(engine, identifier);
}
