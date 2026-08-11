#include <windows.h>

#include "ed25519_runtime.hpp"

#include "monocypher-ed25519.h"
#include "monocypher.h"

#include <array>
#include <cstddef>
#include <cstdint>

namespace goatcitadel::remote_worker_provisioner {

namespace {

constexpr std::size_t kSeedBytes = 32U;
constexpr std::size_t kPublicKeyBytes = 32U;
constexpr std::size_t kSecretKeyBytes = 64U;
constexpr std::size_t kSignatureBytes = 64U;
constexpr std::size_t kPkcs8Bytes = 48U;
constexpr std::size_t kSpkiBytes = 44U;
constexpr std::size_t kMaximumTestMessageBytes = 1024U;
constexpr std::uint8_t kEmptyMessageByte = 0U;

constexpr std::array<std::uint8_t, 16U> kPkcs8Prefix = {
    0x30U, 0x2eU, 0x02U, 0x01U, 0x00U, 0x30U, 0x05U, 0x06U,
    0x03U, 0x2bU, 0x65U, 0x70U, 0x04U, 0x22U, 0x04U, 0x20U,
};
constexpr std::array<std::uint8_t, 12U> kSpkiPrefix = {
    0x30U, 0x2aU, 0x30U, 0x05U, 0x06U, 0x03U,
    0x2bU, 0x65U, 0x70U, 0x03U, 0x21U, 0x00U,
};

constexpr std::array<std::uint8_t, kSeedBytes> kRfc8032Test1Seed = {
    0x9dU, 0x61U, 0xb1U, 0x9dU, 0xefU, 0xfdU, 0x5aU, 0x60U,
    0xbaU, 0x84U, 0x4aU, 0xf4U, 0x92U, 0xecU, 0x2cU, 0xc4U,
    0x44U, 0x49U, 0xc5U, 0x69U, 0x7bU, 0x32U, 0x69U, 0x19U,
    0x70U, 0x3bU, 0xacU, 0x03U, 0x1cU, 0xaeU, 0x7fU, 0x60U,
};
constexpr std::array<std::uint8_t, kPublicKeyBytes> kRfc8032Test1Public = {
    0xd7U, 0x5aU, 0x98U, 0x01U, 0x82U, 0xb1U, 0x0aU, 0xb7U,
    0xd5U, 0x4bU, 0xfeU, 0xd3U, 0xc9U, 0x64U, 0x07U, 0x3aU,
    0x0eU, 0xe1U, 0x72U, 0xf3U, 0xdaU, 0xa6U, 0x23U, 0x25U,
    0xafU, 0x02U, 0x1aU, 0x68U, 0xf7U, 0x07U, 0x51U, 0x1aU,
};
constexpr std::array<std::uint8_t, kSignatureBytes> kRfc8032Test1Signature = {
    0xe5U, 0x56U, 0x43U, 0x00U, 0xc3U, 0x60U, 0xacU, 0x72U,
    0x90U, 0x86U, 0xe2U, 0xccU, 0x80U, 0x6eU, 0x82U, 0x8aU,
    0x84U, 0x87U, 0x7fU, 0x1eU, 0xb8U, 0xe5U, 0xd9U, 0x74U,
    0xd8U, 0x73U, 0xe0U, 0x65U, 0x22U, 0x49U, 0x01U, 0x55U,
    0x5fU, 0xb8U, 0x82U, 0x15U, 0x90U, 0xa3U, 0x3bU, 0xacU,
    0xc6U, 0x1eU, 0x39U, 0x70U, 0x1cU, 0xf9U, 0xb4U, 0x6bU,
    0xd2U, 0x5bU, 0xf5U, 0xf0U, 0x59U, 0x5bU, 0xbeU, 0x24U,
    0x65U, 0x51U, 0x41U, 0x43U, 0x8eU, 0x7aU, 0x10U, 0x0bU,
};
constexpr std::array<std::uint8_t, kPkcs8Bytes> kRfc8032Test1Pkcs8 = {
    0x30U, 0x2eU, 0x02U, 0x01U, 0x00U, 0x30U, 0x05U, 0x06U,
    0x03U, 0x2bU, 0x65U, 0x70U, 0x04U, 0x22U, 0x04U, 0x20U,
    0x9dU, 0x61U, 0xb1U, 0x9dU, 0xefU, 0xfdU, 0x5aU, 0x60U,
    0xbaU, 0x84U, 0x4aU, 0xf4U, 0x92U, 0xecU, 0x2cU, 0xc4U,
    0x44U, 0x49U, 0xc5U, 0x69U, 0x7bU, 0x32U, 0x69U, 0x19U,
    0x70U, 0x3bU, 0xacU, 0x03U, 0x1cU, 0xaeU, 0x7fU, 0x60U,
};
constexpr std::array<std::uint8_t, kSpkiBytes> kRfc8032Test1Spki = {
    0x30U, 0x2aU, 0x30U, 0x05U, 0x06U, 0x03U, 0x2bU, 0x65U,
    0x70U, 0x03U, 0x21U, 0x00U, 0xd7U, 0x5aU, 0x98U, 0x01U,
    0x82U, 0xb1U, 0x0aU, 0xb7U, 0xd5U, 0x4bU, 0xfeU, 0xd3U,
    0xc9U, 0x64U, 0x07U, 0x3aU, 0x0eU, 0xe1U, 0x72U, 0xf3U,
    0xdaU, 0xa6U, 0x23U, 0x25U, 0xafU, 0x02U, 0x1aU, 0x68U,
    0xf7U, 0x07U, 0x51U, 0x1aU,
};

struct InternalVectorResult {
  std::array<std::uint8_t, kPublicKeyBytes> public_key{};
  std::array<std::uint8_t, kSignatureBytes> signature{};
  std::array<std::uint8_t, kPkcs8Bytes> pkcs8{};
  std::array<std::uint8_t, kSpkiBytes> spki{};
};

enum class WipeLabel : std::uint32_t {
  SeedCopy = 1U,
  ParsedSeed = 2U,
  SecretKey = 3U,
  ExpandedScalarPrefix = 4U,
  NonceDigest = 5U,
  NonceScalar = 6U,
  CanonicalR = 7U,
  ChallengeDigest = 8U,
  ChallengeScalar = 9U,
  PartialSignature = 10U,
  FailedPublicKey = 11U,
  FailedPkcs8 = 12U,
  FailedSpki = 13U,
  KnownAnswerArtifacts = 14U,
};

#if defined(GOATCITADEL_PROVISIONER_TESTING)
Ed25519WipeObserverForTest g_wipe_observer = nullptr;
Ed25519FailurePointForTest g_failure_point =
    Ed25519FailurePointForTest::None;
bool g_last_sha512_context_wiped = true;

__declspec(noinline) void WipeOwned(
    WipeLabel label,
    void* bytes,
    std::size_t size) noexcept {
  if (bytes == nullptr || size == 0U) {
    return;
  }
  SecureZeroMemory(bytes, size);
  if (g_wipe_observer != nullptr) {
    g_wipe_observer(
        static_cast<Ed25519WipeLabelForTest>(label),
        static_cast<const std::uint8_t*>(bytes),
        size);
  }
}

bool FailAt(Ed25519FailurePointForTest point) noexcept {
  return g_failure_point == point;
}

bool BytesAreZero(const void* bytes, std::size_t size) noexcept {
  if (bytes == nullptr) {
    return false;
  }
  const auto* current = static_cast<const std::uint8_t*>(bytes);
  std::uint8_t aggregate = 0U;
  for (std::size_t index = 0U; index < size; ++index) {
    aggregate = static_cast<std::uint8_t>(aggregate | current[index]);
  }
  return aggregate == 0U;
}

#define GC_WIPE_BYTES(label, bytes, size) \
  WipeOwned((label), (bytes), (size))
#define GC_INJECT_OR_GOTO(point, target) \
  if (FailAt((point))) {                    \
    goto target;                            \
  }
#else
__declspec(noinline) void WipeOwned(void* bytes, std::size_t size) noexcept {
  if (bytes != nullptr && size != 0U) {
    SecureZeroMemory(bytes, size);
  }
}

#define GC_WIPE_BYTES(label, bytes, size) WipeOwned((bytes), (size))
#define GC_INJECT_OR_GOTO(point, target) ((void)0)
#endif

template <std::size_t Size>
bool Equal(
    const std::array<std::uint8_t, Size>& left,
    const std::array<std::uint8_t, Size>& right) noexcept {
  std::uint8_t difference = 0U;
  for (std::size_t index = 0U; index < Size; ++index) {
    difference = static_cast<std::uint8_t>(
        difference | static_cast<std::uint8_t>(left[index] ^ right[index]));
  }
  return difference == 0U;
}

bool EqualBytes(
    const std::uint8_t* left,
    const std::uint8_t* right,
    std::size_t size) noexcept {
  if ((left == nullptr || right == nullptr) && size != 0U) {
    return false;
  }
  std::uint8_t difference = 0U;
  for (std::size_t index = 0U; index < size; ++index) {
    difference = static_cast<std::uint8_t>(
        difference | static_cast<std::uint8_t>(left[index] ^ right[index]));
  }
  return difference == 0U;
}

void BuildCanonicalPkcs8(
    const std::uint8_t* seed,
    std::array<std::uint8_t, kPkcs8Bytes>* encoded) noexcept {
  if (seed == nullptr || encoded == nullptr) {
    return;
  }
  for (std::size_t index = 0U; index < kPkcs8Prefix.size(); ++index) {
    (*encoded)[index] = kPkcs8Prefix[index];
  }
  for (std::size_t index = 0U; index < kSeedBytes; ++index) {
    (*encoded)[kPkcs8Prefix.size() + index] = seed[index];
  }
}

bool ParseCanonicalPkcs8(
    const std::uint8_t* encoded,
    std::size_t encoded_size,
    std::array<std::uint8_t, kSeedBytes>* seed) noexcept {
  if (seed == nullptr) {
    return false;
  }
  seed->fill(0U);
  if (encoded == nullptr || encoded_size != kPkcs8Bytes ||
      !EqualBytes(encoded, kPkcs8Prefix.data(), kPkcs8Prefix.size())) {
    GC_WIPE_BYTES(
        WipeLabel::ParsedSeed,
        seed->data(),
        seed->size());
    return false;
  }
  for (std::size_t index = 0U; index < seed->size(); ++index) {
    (*seed)[index] = encoded[kPkcs8Prefix.size() + index];
  }
  return true;
}

void BuildCanonicalSpki(
    const std::array<std::uint8_t, kPublicKeyBytes>& public_key,
    std::array<std::uint8_t, kSpkiBytes>* encoded) noexcept {
  if (encoded == nullptr) {
    return;
  }
  for (std::size_t index = 0U; index < kSpkiPrefix.size(); ++index) {
    (*encoded)[index] = kSpkiPrefix[index];
  }
  for (std::size_t index = 0U; index < public_key.size(); ++index) {
    (*encoded)[kSpkiPrefix.size() + index] = public_key[index];
  }
}

__declspec(noinline) void HashReduce(
    std::array<std::uint8_t, 32U>* reduced,
    const std::uint8_t* first,
    std::size_t first_size,
    const std::uint8_t* second,
    std::size_t second_size,
    const std::uint8_t* third,
    std::size_t third_size,
    WipeLabel digest_label) noexcept {
  std::array<std::uint8_t, 64U> digest{};
  crypto_sha512_ctx context{};
#if !defined(GOATCITADEL_PROVISIONER_TESTING)
  (void)digest_label;
#endif
  crypto_sha512_init(&context);
  if (first_size != 0U) {
    crypto_sha512_update(&context, first, first_size);
  }
  if (second_size != 0U) {
    crypto_sha512_update(&context, second, second_size);
  }
  if (third_size != 0U) {
    crypto_sha512_update(&context, third, third_size);
  }
  crypto_sha512_final(&context, digest.data());
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_last_sha512_context_wiped =
      g_last_sha512_context_wiped &&
      BytesAreZero(&context, sizeof(context));
#endif
  crypto_eddsa_reduce(reduced->data(), digest.data());
  GC_WIPE_BYTES(digest_label, digest.data(), digest.size());
}

__declspec(noinline) bool PureEd25519Sign(
    std::array<std::uint8_t, kSignatureBytes>* signature,
    const std::array<std::uint8_t, kSecretKeyBytes>& secret_key,
    const std::uint8_t* message,
    std::size_t message_size) noexcept {
  if (signature == nullptr ||
      (message == nullptr && message_size != 0U) ||
      message_size > kMaximumTestMessageBytes) {
    return false;
  }

  signature->fill(0U);
  std::array<std::uint8_t, 64U> expanded_scalar_prefix{};
  std::array<std::uint8_t, 32U> nonce{};
  std::array<std::uint8_t, 32U> canonical_r{};
  std::array<std::uint8_t, 32U> challenge{};
  const std::uint8_t* const safe_message =
      message_size == 0U ? &kEmptyMessageByte : message;
  bool success = false;

  crypto_sha512(
      expanded_scalar_prefix.data(),
      secret_key.data(),
      kSeedBytes);
  crypto_eddsa_trim_scalar(
      expanded_scalar_prefix.data(),
      expanded_scalar_prefix.data());
  GC_INJECT_OR_GOTO(
      Ed25519FailurePointForTest::AfterScalarExpansion,
      cleanup);

  HashReduce(
      &nonce,
      expanded_scalar_prefix.data() + 32U,
      32U,
      safe_message,
      message_size,
      nullptr,
      0U,
      WipeLabel::NonceDigest);
  GC_INJECT_OR_GOTO(
      Ed25519FailurePointForTest::AfterNonceReduction,
      cleanup);

  crypto_eddsa_scalarbase(canonical_r.data(), nonce.data());
  GC_INJECT_OR_GOTO(Ed25519FailurePointForTest::AfterScalarBase, cleanup);

  HashReduce(
      &challenge,
      canonical_r.data(),
      canonical_r.size(),
      secret_key.data() + kSeedBytes,
      kPublicKeyBytes,
      safe_message,
      message_size,
      WipeLabel::ChallengeDigest);
  GC_INJECT_OR_GOTO(
      Ed25519FailurePointForTest::AfterChallengeReduction,
      cleanup);

  for (std::size_t index = 0U; index < canonical_r.size(); ++index) {
    (*signature)[index] = canonical_r[index];
  }
  crypto_eddsa_mul_add(
      signature->data() + 32U,
      challenge.data(),
      expanded_scalar_prefix.data(),
      nonce.data());
  GC_INJECT_OR_GOTO(Ed25519FailurePointForTest::AfterMulAdd, cleanup);

  if (crypto_ed25519_check(
          signature->data(),
          secret_key.data() + kSeedBytes,
          safe_message,
          message_size) != 0) {
    goto cleanup;
  }
  GC_INJECT_OR_GOTO(Ed25519FailurePointForTest::AfterVerification, cleanup);
  success = true;

cleanup:
  GC_WIPE_BYTES(
      WipeLabel::ExpandedScalarPrefix,
      expanded_scalar_prefix.data(),
      expanded_scalar_prefix.size());
  GC_WIPE_BYTES(
      WipeLabel::NonceScalar,
      nonce.data(),
      nonce.size());
  GC_WIPE_BYTES(
      WipeLabel::CanonicalR,
      canonical_r.data(),
      canonical_r.size());
  GC_WIPE_BYTES(
      WipeLabel::ChallengeScalar,
      challenge.data(),
      challenge.size());
  if (!success) {
    GC_WIPE_BYTES(
        WipeLabel::PartialSignature,
        signature->data(),
        signature->size());
  }
  return success;
}

bool RunVector(
    const std::uint8_t* seed,
    std::size_t seed_size,
    const std::uint8_t* message,
    std::size_t message_size,
    InternalVectorResult* result) noexcept {
  if (result == nullptr) {
    return false;
  }
  SecureZeroMemory(result, sizeof(*result));
  if (seed == nullptr || seed_size != kSeedBytes ||
      (message == nullptr && message_size != 0U) ||
      message_size > kMaximumTestMessageBytes) {
    return false;
  }

#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_last_sha512_context_wiped = true;
#endif
  std::array<std::uint8_t, kSeedBytes> seed_copy{};
  std::array<std::uint8_t, kSeedBytes> parsed_seed{};
  std::array<std::uint8_t, kSecretKeyBytes> secret_key{};
  bool success = false;

  for (std::size_t index = 0U; index < seed_copy.size(); ++index) {
    seed_copy[index] = seed[index];
  }
  crypto_ed25519_key_pair(
      secret_key.data(),
      result->public_key.data(),
      seed_copy.data());
  GC_WIPE_BYTES(
      WipeLabel::SeedCopy,
      seed_copy.data(),
      seed_copy.size());
  if (!EqualBytes(secret_key.data(), seed, kSeedBytes) ||
      !EqualBytes(
          secret_key.data() + kSeedBytes,
          result->public_key.data(),
          kPublicKeyBytes)) {
    goto cleanup;
  }
  GC_INJECT_OR_GOTO(Ed25519FailurePointForTest::AfterKeyPair, cleanup);

  BuildCanonicalPkcs8(seed, &result->pkcs8);
  if (!ParseCanonicalPkcs8(
          result->pkcs8.data(),
          result->pkcs8.size(),
          &parsed_seed) ||
      !EqualBytes(parsed_seed.data(), seed, kSeedBytes)) {
    goto cleanup;
  }
  GC_INJECT_OR_GOTO(Ed25519FailurePointForTest::AfterPkcs8, cleanup);
  GC_WIPE_BYTES(
      WipeLabel::ParsedSeed,
      parsed_seed.data(),
      parsed_seed.size());

  BuildCanonicalSpki(result->public_key, &result->spki);
  GC_INJECT_OR_GOTO(Ed25519FailurePointForTest::AfterSpki, cleanup);

  if (!PureEd25519Sign(
          &result->signature,
          secret_key,
          message,
          message_size)) {
    goto cleanup;
  }
  success = true;

cleanup:
  GC_WIPE_BYTES(
      WipeLabel::ParsedSeed,
      parsed_seed.data(),
      parsed_seed.size());
  GC_WIPE_BYTES(
      WipeLabel::SecretKey,
      secret_key.data(),
      secret_key.size());
  if (!success) {
    GC_WIPE_BYTES(
        WipeLabel::PartialSignature,
        result->signature.data(),
        result->signature.size());
    GC_WIPE_BYTES(
        WipeLabel::FailedPublicKey,
        result->public_key.data(),
        result->public_key.size());
    GC_WIPE_BYTES(
        WipeLabel::FailedPkcs8,
        result->pkcs8.data(),
        result->pkcs8.size());
    GC_WIPE_BYTES(
        WipeLabel::FailedSpki,
        result->spki.data(),
        result->spki.size());
  }
  return success;
}

}  // namespace

__declspec(noinline) void WipeEd25519Owned(
    void* bytes,
    std::size_t size) noexcept {
  if (bytes != nullptr && size != 0U) {
    SecureZeroMemory(bytes, size);
  }
}

__declspec(noinline) bool ExpandEd25519SeedForProtectedSigning(
    const ProtectedEd25519SigningBridgeKey& bridge_key,
    const std::uint8_t seed[32U],
    std::uint8_t expanded_scalar_prefix[64U],
    std::uint8_t public_key[32U]) noexcept {
  (void)bridge_key;
  std::array<std::uint8_t, 32U> seed_copy{};
  std::array<std::uint8_t, 64U> expanded{};
  std::array<std::uint8_t, 32U> candidate_public_key{};
  std::uint8_t seed_nonzero = 0U;
  if (seed != nullptr) {
    for (std::size_t index = 0U; index < seed_copy.size(); ++index) {
      seed_copy[index] = seed[index];
      seed_nonzero = static_cast<std::uint8_t>(seed_nonzero | seed[index]);
    }
  }
  if (expanded_scalar_prefix != nullptr) {
    SecureZeroMemory(expanded_scalar_prefix, 64U);
  }
  if (public_key != nullptr) {
    SecureZeroMemory(public_key, 32U);
  }

  bool success = seed != nullptr && expanded_scalar_prefix != nullptr &&
                 public_key != nullptr && seed_nonzero != 0U;
  if (success) {
    crypto_sha512(expanded.data(), seed_copy.data(), seed_copy.size());
    crypto_eddsa_trim_scalar(expanded.data(), expanded.data());
    crypto_eddsa_scalarbase(candidate_public_key.data(), expanded.data());
    std::uint8_t public_nonzero = 0U;
    for (const std::uint8_t value : candidate_public_key) {
      public_nonzero = static_cast<std::uint8_t>(public_nonzero | value);
    }
    success = public_nonzero != 0U;
  }
  if (success) {
    for (std::size_t index = 0U; index < expanded.size(); ++index) {
      expanded_scalar_prefix[index] = expanded[index];
    }
    for (std::size_t index = 0U; index < candidate_public_key.size(); ++index) {
      public_key[index] = candidate_public_key[index];
    }
  }

  WipeEd25519Owned(seed_copy.data(), seed_copy.size());
  WipeEd25519Owned(expanded.data(), expanded.size());
  WipeEd25519Owned(candidate_public_key.data(), candidate_public_key.size());
  return success;
}

__declspec(noinline) void ReduceEd25519ScalarForProtectedSigning(
    const ProtectedEd25519SigningBridgeKey& bridge_key,
    const std::uint8_t digest[64U],
    std::uint8_t scalar[32U]) noexcept {
  (void)bridge_key;
  if (scalar == nullptr) {
    return;
  }
  SecureZeroMemory(scalar, 32U);
  if (digest != nullptr) {
    crypto_eddsa_reduce(scalar, digest);
  }
}

__declspec(noinline) void Ed25519ScalarBaseForProtectedSigning(
    const ProtectedEd25519SigningBridgeKey& bridge_key,
    const std::uint8_t scalar[32U],
    std::uint8_t point[32U]) noexcept {
  (void)bridge_key;
  if (point == nullptr) {
    return;
  }
  SecureZeroMemory(point, 32U);
  if (scalar != nullptr) {
    crypto_eddsa_scalarbase(point, scalar);
  }
}

__declspec(noinline) void Ed25519MulAddForProtectedSigning(
    const ProtectedEd25519SigningBridgeKey& bridge_key,
    std::uint8_t output[32U],
    const std::uint8_t challenge[32U],
    const std::uint8_t scalar[32U],
    const std::uint8_t nonce[32U]) noexcept {
  (void)bridge_key;
  if (output == nullptr) {
    return;
  }
  SecureZeroMemory(output, 32U);
  if (challenge != nullptr && scalar != nullptr && nonce != nullptr) {
    crypto_eddsa_mul_add(output, challenge, scalar, nonce);
  }
}

__declspec(noinline) bool CheckEd25519EquationForProtectedSigning(
    const ProtectedEd25519SigningBridgeKey& bridge_key,
    const std::uint8_t signature[64U],
    const std::uint8_t public_key[32U],
    const std::uint8_t reduced_challenge[32U]) noexcept {
  (void)bridge_key;
  return signature != nullptr && public_key != nullptr &&
         reduced_challenge != nullptr &&
         crypto_eddsa_check_equation(
             signature, public_key, reduced_challenge) == 0;
}

__declspec(noinline) bool DeriveEd25519KeyMaterial(
    const std::uint8_t* seed,
    std::size_t seed_size,
    Ed25519DerivedKeyMaterial* output) noexcept {
  if (output == nullptr) {
    return false;
  }
  SecureZeroMemory(output, sizeof(*output));
  if (seed == nullptr || seed_size != kSeedBytes) {
    return false;
  }

  std::array<std::uint8_t, kSeedBytes> seed_copy{};
  std::array<std::uint8_t, kSeedBytes> parsed_seed{};
  std::array<std::uint8_t, kSecretKeyBytes> secret_key{};
  Ed25519DerivedKeyMaterial candidate{};
  std::uint8_t seed_nonzero = 0U;
  for (std::size_t index = 0U; index < seed_copy.size(); ++index) {
    seed_copy[index] = seed[index];
    seed_nonzero = static_cast<std::uint8_t>(seed_nonzero | seed[index]);
  }
  bool success = seed_nonzero != 0U;
  if (success) {
    crypto_ed25519_key_pair(
        secret_key.data(), candidate.public_key.data(), seed_copy.data());
    std::uint8_t public_nonzero = 0U;
    for (const std::uint8_t value : candidate.public_key) {
      public_nonzero = static_cast<std::uint8_t>(public_nonzero | value);
    }
    success = public_nonzero != 0U &&
              EqualBytes(secret_key.data(), seed, kSeedBytes) &&
              EqualBytes(
                  secret_key.data() + kSeedBytes,
                  candidate.public_key.data(),
                  kPublicKeyBytes);
  }
  if (success) {
    BuildCanonicalPkcs8(secret_key.data(), &candidate.pkcs8);
    BuildCanonicalSpki(candidate.public_key, &candidate.spki);
    success = ParseCanonicalPkcs8(
                  candidate.pkcs8.data(), candidate.pkcs8.size(), &parsed_seed) &&
              EqualBytes(parsed_seed.data(), seed, kSeedBytes);
  }
  if (success) {
    *output = candidate;
  } else {
    SecureZeroMemory(output, sizeof(*output));
  }
  WipeEd25519Owned(seed_copy.data(), seed_copy.size());
  WipeEd25519Owned(secret_key.data(), secret_key.size());
  WipeEd25519Owned(parsed_seed.data(), parsed_seed.size());
  WipeEd25519Owned(&candidate, sizeof(candidate));
  return success;
}

bool RunKnownAnswerSelfTest() noexcept {
  InternalVectorResult first{};
  InternalVectorResult second{};
  std::array<std::uint8_t, kSignatureBytes> tampered{};
  bool success = RunVector(
      kRfc8032Test1Seed.data(),
      kRfc8032Test1Seed.size(),
      nullptr,
      0U,
      &first);
  if (success) {
    success = Equal(first.public_key, kRfc8032Test1Public) &&
              Equal(first.signature, kRfc8032Test1Signature) &&
              Equal(first.pkcs8, kRfc8032Test1Pkcs8) &&
              Equal(first.spki, kRfc8032Test1Spki);
  }
  if (success) {
    success = RunVector(
        kRfc8032Test1Seed.data(),
        kRfc8032Test1Seed.size(),
        nullptr,
        0U,
        &second) &&
        Equal(first.signature, second.signature) &&
        Equal(first.pkcs8, second.pkcs8) &&
        Equal(first.spki, second.spki);
  }
  if (success) {
    tampered = first.signature;
    tampered[63U] ^= 0x01U;
    success = crypto_ed25519_check(
                  tampered.data(),
                  first.public_key.data(),
                  &kEmptyMessageByte,
                  0U) != 0;
  }
  GC_WIPE_BYTES(
      WipeLabel::PartialSignature,
      tampered.data(),
      tampered.size());
  GC_WIPE_BYTES(
      WipeLabel::KnownAnswerArtifacts,
      &first,
      sizeof(first));
  GC_WIPE_BYTES(
      WipeLabel::KnownAnswerArtifacts,
      &second,
      sizeof(second));
  return success;
}

#if defined(GOATCITADEL_PROVISIONER_TESTING)

void SetEd25519WipeObserverForTest(
    Ed25519WipeObserverForTest observer) noexcept {
  g_wipe_observer = observer;
}

void SetEd25519FailurePointForTest(
    Ed25519FailurePointForTest point) noexcept {
  g_failure_point = point;
}

void ResetEd25519TestState() noexcept {
  g_wipe_observer = nullptr;
  g_failure_point = Ed25519FailurePointForTest::None;
  g_last_sha512_context_wiped = true;
}

bool RunEd25519VectorForTest(
    const std::uint8_t* seed,
    std::size_t seed_size,
    const std::uint8_t* message,
    std::size_t message_size,
    Ed25519VectorResultForTest* result) noexcept {
  if (result == nullptr) {
    return false;
  }
  InternalVectorResult internal{};
  if (!RunVector(seed, seed_size, message, message_size, &internal)) {
    SecureZeroMemory(result, sizeof(*result));
    return false;
  }
  result->public_key = internal.public_key;
  result->signature = internal.signature;
  result->pkcs8 = internal.pkcs8;
  result->spki = internal.spki;
  GC_WIPE_BYTES(
      WipeLabel::KnownAnswerArtifacts,
      &internal,
      sizeof(internal));
  return true;
}

bool ParseCanonicalPkcs8ForTest(
    const std::uint8_t* encoded,
    std::size_t encoded_size,
    std::array<std::uint8_t, kSeedBytes>* seed) noexcept {
  return ParseCanonicalPkcs8(encoded, encoded_size, seed);
}

bool RunFixedInteropForTest(
    const std::uint8_t* signature,
    std::size_t signature_size,
    std::array<std::uint8_t, kPublicKeyBytes>* public_key,
    std::array<std::uint8_t, kSignatureBytes>* native_signature) noexcept {
  if (public_key == nullptr || native_signature == nullptr) {
    return false;
  }
  public_key->fill(0U);
  native_signature->fill(0U);
  if (signature == nullptr || signature_size != kSignatureBytes ||
      !EqualBytes(
          signature,
          kRfc8032Test1Signature.data(),
          kRfc8032Test1Signature.size())) {
    return false;
  }
  if (crypto_ed25519_check(
          signature,
          kRfc8032Test1Public.data(),
          &kEmptyMessageByte,
          0U) != 0) {
    return false;
  }
  InternalVectorResult internal{};
  if (!RunVector(
          kRfc8032Test1Seed.data(),
          kRfc8032Test1Seed.size(),
          nullptr,
          0U,
          &internal) ||
      !Equal(internal.public_key, kRfc8032Test1Public) ||
      !Equal(internal.signature, kRfc8032Test1Signature)) {
    GC_WIPE_BYTES(
        WipeLabel::KnownAnswerArtifacts,
        &internal,
        sizeof(internal));
    return false;
  }
  *public_key = internal.public_key;
  *native_signature = internal.signature;
  GC_WIPE_BYTES(
      WipeLabel::KnownAnswerArtifacts,
      &internal,
      sizeof(internal));
  return true;
}

bool WasLastSha512ContextWipedForTest() noexcept {
  return g_last_sha512_context_wiped;
}

#endif

#undef GC_WIPE_BYTES
#undef GC_INJECT_OR_GOTO

}  // namespace goatcitadel::remote_worker_provisioner
