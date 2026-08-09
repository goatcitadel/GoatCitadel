#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace goatcitadel::remote_worker_provisioner {

bool RunKnownAnswerSelfTest() noexcept;

struct Ed25519DerivedKeyMaterial {
  std::array<std::uint8_t, 32U> public_key{};
  std::array<std::uint8_t, 48U> pkcs8{};
  std::array<std::uint8_t, 44U> spki{};
};

class ProtectedSigningLease;
__declspec(noinline) bool SignProtectedArtifact(
    ProtectedSigningLease* lease,
    std::array<std::uint8_t, 64U>* candidate_signature) noexcept;

class ProtectedEd25519SigningBridgeKey final {
 public:
  ProtectedEd25519SigningBridgeKey(
      const ProtectedEd25519SigningBridgeKey&) = delete;
  ProtectedEd25519SigningBridgeKey& operator=(
      const ProtectedEd25519SigningBridgeKey&) = delete;

 private:
  ProtectedEd25519SigningBridgeKey() noexcept = default;
  ~ProtectedEd25519SigningBridgeKey() noexcept = default;

  friend bool SignProtectedArtifact(
      ProtectedSigningLease* lease,
      std::array<std::uint8_t, 64U>* candidate_signature) noexcept;
};

__declspec(noinline) bool DeriveEd25519KeyMaterial(
    const std::uint8_t* seed,
    std::size_t seed_size,
    Ed25519DerivedKeyMaterial* output) noexcept;

__declspec(noinline) void WipeEd25519Owned(
    void* bytes,
    std::size_t size) noexcept;

// Narrow composition boundary for the protected-artifact
// signer. Only SignProtectedArtifact can construct the required passkey. These
// functions do not accept a message, artifact, callback, path, handle, or
// reusable signing authority; ed25519_runtime.cpp remains the sole first-party
// owner of vendored Monocypher calls.
__declspec(noinline) bool ExpandEd25519SeedForProtectedSigning(
    const ProtectedEd25519SigningBridgeKey& bridge_key,
    const std::uint8_t seed[32U],
    std::uint8_t expanded_scalar_prefix[64U],
    std::uint8_t public_key[32U]) noexcept;

__declspec(noinline) void ReduceEd25519ScalarForProtectedSigning(
    const ProtectedEd25519SigningBridgeKey& bridge_key,
    const std::uint8_t digest[64U],
    std::uint8_t scalar[32U]) noexcept;

__declspec(noinline) void Ed25519ScalarBaseForProtectedSigning(
    const ProtectedEd25519SigningBridgeKey& bridge_key,
    const std::uint8_t scalar[32U],
    std::uint8_t point[32U]) noexcept;

__declspec(noinline) void Ed25519MulAddForProtectedSigning(
    const ProtectedEd25519SigningBridgeKey& bridge_key,
    std::uint8_t output[32U],
    const std::uint8_t challenge[32U],
    const std::uint8_t scalar[32U],
    const std::uint8_t nonce[32U]) noexcept;

__declspec(noinline) bool CheckEd25519EquationForProtectedSigning(
    const ProtectedEd25519SigningBridgeKey& bridge_key,
    const std::uint8_t signature[64U],
    const std::uint8_t public_key[32U],
    const std::uint8_t reduced_challenge[32U]) noexcept;

#if defined(GOATCITADEL_PROVISIONER_TESTING)

enum class Ed25519FailurePointForTest : std::uint32_t {
  None = 0U,
  AfterKeyPair = 1U,
  AfterPkcs8 = 2U,
  AfterSpki = 3U,
  AfterScalarExpansion = 4U,
  AfterNonceReduction = 5U,
  AfterScalarBase = 6U,
  AfterChallengeReduction = 7U,
  AfterMulAdd = 8U,
  AfterVerification = 9U,
};

enum class Ed25519WipeLabelForTest : std::uint32_t {
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

using Ed25519WipeObserverForTest = void (*)(
    Ed25519WipeLabelForTest label,
    const std::uint8_t* bytes,
    std::size_t size) noexcept;

struct Ed25519VectorResultForTest {
  std::array<std::uint8_t, 32U> public_key{};
  std::array<std::uint8_t, 64U> signature{};
  std::array<std::uint8_t, 48U> pkcs8{};
  std::array<std::uint8_t, 44U> spki{};
};

void SetEd25519WipeObserverForTest(
    Ed25519WipeObserverForTest observer) noexcept;
void SetEd25519FailurePointForTest(
    Ed25519FailurePointForTest point) noexcept;
void ResetEd25519TestState() noexcept;

bool RunEd25519VectorForTest(
    const std::uint8_t* seed,
    std::size_t seed_size,
    const std::uint8_t* message,
    std::size_t message_size,
    Ed25519VectorResultForTest* result) noexcept;

bool ParseCanonicalPkcs8ForTest(
    const std::uint8_t* encoded,
    std::size_t encoded_size,
    std::array<std::uint8_t, 32U>* seed) noexcept;

bool RunFixedInteropForTest(
    const std::uint8_t* signature,
    std::size_t signature_size,
    std::array<std::uint8_t, 32U>* public_key,
    std::array<std::uint8_t, 64U>* native_signature) noexcept;

bool WasLastSha512ContextWipedForTest() noexcept;

#endif

}  // namespace goatcitadel::remote_worker_provisioner
