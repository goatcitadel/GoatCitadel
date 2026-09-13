#pragma once
#include <cstddef>

// Narrow public OpenSSL 3.5.7 C ABI used by Node's engine key interface. No
// OpenSSL structures or second libcrypto instance are embedded in this DLL.
// Declarations correspond to OpenSSL's engine.h, evp.h and crypto.h.
namespace goatcitadel::worker_tls {
struct ENGINE;
struct EVP_PKEY;
struct EVP_PKEY_METHOD;
struct EVP_PKEY_CTX;
struct EVP_MD_CTX;
struct EVP_MD;
struct UI_METHOD;
struct CRYPTO_EX_DATA;
using ExFree = void (*)(void*, void*, CRYPTO_EX_DATA*, int, long, void*);
using ExDup = int (*)(CRYPTO_EX_DATA*, const CRYPTO_EX_DATA*, void**, int, long, void*);
using ExNew = void (*)(void*, void*, CRYPTO_EX_DATA*, int, long, void*);
using SignCallback = int (*)(EVP_MD_CTX*, unsigned char*, std::size_t*, const unsigned char*, std::size_t);
using MethodCallback = int (*)(ENGINE*, EVP_PKEY_METHOD**, const int**, int);
using LoadCallback = EVP_PKEY* (*)(ENGINE*, const char*, UI_METHOD*, void*);

struct OpenSslApi {
  unsigned long (*OpenSSL_version_num)();
  int (*ENGINE_set_id)(ENGINE*, const char*);
  int (*ENGINE_set_name)(ENGINE*, const char*);
  int (*ENGINE_set_pkey_meths)(ENGINE*, MethodCallback);
  int (*ENGINE_set_load_privkey_function)(ENGINE*, LoadCallback);
  int (*ENGINE_set_ex_data)(ENGINE*, int, void*);
  void* (*ENGINE_get_ex_data)(const ENGINE*, int);
  int (*CRYPTO_get_ex_new_index)(int, long, void*, ExNew, ExDup, ExFree);
  EVP_PKEY_METHOD* (*EVP_PKEY_meth_new)(int, int);
  const EVP_PKEY_METHOD* (*EVP_PKEY_meth_find)(int);
  void (*EVP_PKEY_meth_copy)(EVP_PKEY_METHOD*, const EVP_PKEY_METHOD*);
  void (*EVP_PKEY_meth_free)(EVP_PKEY_METHOD*);
  void (*EVP_PKEY_meth_set_digestsign)(EVP_PKEY_METHOD*, SignCallback);
  EVP_PKEY* (*EVP_PKEY_new_raw_public_key)(int, ENGINE*, const unsigned char*, std::size_t);
  int (*EVP_PKEY_set1_engine)(EVP_PKEY*, ENGINE*);
  void (*EVP_PKEY_free)(EVP_PKEY*);
  int (*EVP_PKEY_set_ex_data)(EVP_PKEY*, int, void*);
  void* (*EVP_PKEY_get_ex_data)(const EVP_PKEY*, int);
  EVP_PKEY_CTX* (*EVP_MD_CTX_get_pkey_ctx)(const EVP_MD_CTX*);
  EVP_PKEY* (*EVP_PKEY_CTX_get0_pkey)(EVP_PKEY_CTX*);
  EVP_MD_CTX* (*EVP_MD_CTX_new)();
  void (*EVP_MD_CTX_free)(EVP_MD_CTX*);
  int (*EVP_DigestVerifyInit)(EVP_MD_CTX*, EVP_PKEY_CTX**, const EVP_MD*, ENGINE*, EVP_PKEY*);
  int (*EVP_DigestVerify)(EVP_MD_CTX*, const unsigned char*, std::size_t, const unsigned char*, std::size_t);
};
}  // namespace goatcitadel::worker_tls
