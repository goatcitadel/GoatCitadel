#include "local_transport.hpp"

#include <aclapi.h>
#include <bcrypt.h>
#include <ntsecapi.h>
#include <winsvc.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <new>
#include <utility>

#include "protocol.hpp"
#if defined(GOATCITADEL_PROVISIONER_CUSTODY)
#include "protected_operations.hpp"
#endif

#if defined(_M_ARM64)
// The pinned ARM64 VCRuntime memory routines consult this private four-byte
// selector before taking an optional newer-OS unaligned fast path.  Its normal
// owner also initializes the complete VCRT lifecycle (FLS, locks, and heap-
// backed per-thread data), which this custom-entry-point helper intentionally
// does not use.  Define the selector as zero to retain the conservative memory
// path without granting that process-wide CRT authority.
static_assert(sizeof(int) == sizeof(std::int32_t));
extern "C" {
int __arm64_safe_unaligned_memory_access = 0;
}
#endif

namespace goatcitadel::remote_worker_provisioner {
namespace {

constexpr std::array<std::uint8_t, 4U> kGcpaMagic = {'G', 'C', 'P', 'A'};
constexpr std::uint8_t kGcpaFlags = 0U;
constexpr std::uint8_t kGcpaSchema = 1U;
constexpr std::uint32_t kPipeBufferBytes = 8U * 1024U;
constexpr std::uint64_t kClientPipeWaitMilliseconds = 10U * 1000U;
constexpr std::uint64_t kClientWorkMilliseconds = 30U * 1000U;
constexpr std::uint64_t kProtectedRecoveryMilliseconds = 10U * 1000U;
constexpr std::uint64_t kCancellationGraceMilliseconds = 5U * 1000U;
constexpr std::uint64_t kHelloReadMilliseconds = 2U * 1000U;
constexpr std::uint64_t kAuthenticationMilliseconds = 5U * 1000U;
constexpr std::uint64_t kRequestReadMilliseconds = 10U * 1000U;
constexpr std::uint64_t kResultWriteMilliseconds = 10U * 1000U;
constexpr std::uint64_t kAcceptMilliseconds = 60U * 1000U;
constexpr DWORD kCancellationFailFastExit = 0x47504308U;
constexpr DWORD kPipeGrantedMask = 0x0012008BU;
constexpr DWORD kProtectedReadMask = 0x001200A9U;
constexpr DWORD kProtectedFullMask = 0x001F01FFU;
constexpr std::size_t kHashObjectMaximumBytes = 1024U;
constexpr std::uint64_t kMaximumContractSafeInteger =
    UINT64_C(9007199254740991);
constexpr wchar_t kSystemRootObjectPath[] = L"\\\\?\\GLOBALROOT\\SystemRoot";
constexpr wchar_t kProgramDataComponent[] = L"ProgramData";
constexpr wchar_t kGoatCitadelComponent[] = L"GoatCitadel";
constexpr wchar_t kProvisionerRootComponent[] = L"RemoteWorkerProvisioner";
constexpr wchar_t kBinComponent[] = L"bin";
constexpr wchar_t kServiceExecutableName[] = L"GoatCitadelRemoteWorkerProvisioner.exe";
constexpr wchar_t kClientExecutableName[] =
    L"GoatCitadelRemoteWorkerProvisionerClient.exe";
constexpr char kAuthenticatedRequestDomain[] =
    "goatcitadel.remote-worker.provisioner.gcpa.request.v1";
constexpr char kRuntimePopV2OperationDomain[] =
    "goatcitadel.remote-worker-pop-v2.operation.v1";
static_assert(sizeof(kRuntimePopV2OperationDomain) == 46U);

#if defined(_M_X64)
constexpr std::uint16_t kLocalPeMachine = kMachineX64;
#elif defined(_M_ARM64)
constexpr std::uint16_t kLocalPeMachine = kMachineArm64;
#else
#error Unsupported provisioner architecture.
#endif

struct RandomRegistry final {
  volatile LONG held = 0;
  std::array<Byte16, 8U> values16{};
  std::array<Byte32, 8U> values32{};
  std::size_t count16 = 0U;
  std::size_t count32 = 0U;
};

RandomRegistry g_random_registry{};

bool IsAllZero(const std::uint8_t* bytes, std::size_t length) noexcept {
  if (bytes == nullptr) {
    return true;
  }
  std::uint8_t aggregate = 0U;
  for (std::size_t index = 0U; index < length; ++index) {
    aggregate = static_cast<std::uint8_t>(aggregate | bytes[index]);
  }
  return aggregate == 0U;
}

bool BytesEqual(
    const std::uint8_t* left,
    const std::uint8_t* right,
    std::size_t length) noexcept {
  if (left == nullptr || right == nullptr) {
    return false;
  }
  std::uint8_t difference = 0U;
  for (std::size_t index = 0U; index < length; ++index) {
    difference = static_cast<std::uint8_t>(
        difference | static_cast<std::uint8_t>(left[index] ^ right[index]));
  }
  return difference == 0U;
}

std::uint16_t ReadU16(const std::uint8_t* bytes) noexcept {
  return static_cast<std::uint16_t>(
      static_cast<std::uint16_t>(bytes[0]) |
      static_cast<std::uint16_t>(static_cast<std::uint16_t>(bytes[1]) << 8U));
}

std::uint32_t ReadU32(const std::uint8_t* bytes) noexcept {
  return static_cast<std::uint32_t>(
      static_cast<std::uint32_t>(bytes[0]) |
      (static_cast<std::uint32_t>(bytes[1]) << 8U) |
      (static_cast<std::uint32_t>(bytes[2]) << 16U) |
      (static_cast<std::uint32_t>(bytes[3]) << 24U));
}

std::uint64_t ReadU64(const std::uint8_t* bytes) noexcept {
  std::uint64_t value = 0U;
  for (std::size_t index = 0U; index < 8U; ++index) {
    value |= static_cast<std::uint64_t>(bytes[index]) << (index * 8U);
  }
  return value;
}

void WriteU16(std::uint8_t* bytes, std::uint16_t value) noexcept {
  bytes[0] = static_cast<std::uint8_t>(value & 0xFFU);
  bytes[1] = static_cast<std::uint8_t>((value >> 8U) & 0xFFU);
}

void WriteU32(std::uint8_t* bytes, std::uint32_t value) noexcept {
  bytes[0] = static_cast<std::uint8_t>(value & 0xFFU);
  bytes[1] = static_cast<std::uint8_t>((value >> 8U) & 0xFFU);
  bytes[2] = static_cast<std::uint8_t>((value >> 16U) & 0xFFU);
  bytes[3] = static_cast<std::uint8_t>((value >> 24U) & 0xFFU);
}

void WriteU64(std::uint8_t* bytes, std::uint64_t value) noexcept {
  for (std::size_t index = 0U; index < 8U; ++index) {
    bytes[index] = static_cast<std::uint8_t>(
        (value >> (index * 8U)) & UINT64_C(0xFF));
  }
}

bool AddSize(std::size_t left, std::size_t right, std::size_t* total) noexcept {
  if (total == nullptr || right > std::numeric_limits<std::size_t>::max() - left) {
    return false;
  }
  *total = left + right;
  return true;
}

bool WriteGcpaHeader(
    GcpaKind kind,
    std::uint32_t payload_length,
    std::uint8_t* output,
    std::size_t output_capacity) noexcept {
  if (output == nullptr || output_capacity < kGcpaHeaderBytes) {
    return false;
  }
  output[0] = kGcpaMagic[0];
  output[1] = kGcpaMagic[1];
  output[2] = kGcpaMagic[2];
  output[3] = kGcpaMagic[3];
  WriteU16(output + 4U, kGcpaVersion);
  output[6] = static_cast<std::uint8_t>(kind);
  output[7] = kGcpaFlags;
  WriteU32(output + 8U, kGcpaRequestId);
  WriteU32(output + 12U, payload_length);
  return true;
}

bool HasGcpaHeader(
    const std::uint8_t* frame,
    std::size_t frame_length,
    GcpaKind expected_kind,
    std::uint32_t expected_payload_length) noexcept {
  if (frame == nullptr || frame_length !=
          kGcpaHeaderBytes + static_cast<std::size_t>(expected_payload_length)) {
    return false;
  }
  return frame[0] == kGcpaMagic[0] && frame[1] == kGcpaMagic[1] &&
         frame[2] == kGcpaMagic[2] && frame[3] == kGcpaMagic[3] &&
         ReadU16(frame + 4U) == kGcpaVersion &&
         frame[6] == static_cast<std::uint8_t>(expected_kind) &&
         frame[7] == kGcpaFlags && ReadU32(frame + 8U) == kGcpaRequestId &&
         ReadU32(frame + 12U) == expected_payload_length;
}

class Sha256Hasher final {
 public:
  Sha256Hasher() noexcept = default;
  Sha256Hasher(const Sha256Hasher&) = delete;
  Sha256Hasher& operator=(const Sha256Hasher&) = delete;

  ~Sha256Hasher() noexcept { Close(); }

  bool Open() noexcept {
    if (algorithm_ != nullptr || hash_ != nullptr) {
      return false;
    }
    if (BCryptOpenAlgorithmProvider(
            &algorithm_, BCRYPT_SHA256_ALGORITHM, nullptr, 0U) < 0) {
      algorithm_ = nullptr;
      return false;
    }
    DWORD object_length = 0U;
    DWORD copied = 0U;
    if (BCryptGetProperty(
            algorithm_,
            BCRYPT_OBJECT_LENGTH,
            reinterpret_cast<PUCHAR>(&object_length),
            static_cast<ULONG>(sizeof(object_length)),
            &copied,
            0U) < 0 ||
        copied != sizeof(object_length) || object_length == 0U ||
        object_length > object_.size()) {
      Close();
      return false;
    }
    DWORD hash_length = 0U;
    copied = 0U;
    if (BCryptGetProperty(
            algorithm_,
            BCRYPT_HASH_LENGTH,
            reinterpret_cast<PUCHAR>(&hash_length),
            static_cast<ULONG>(sizeof(hash_length)),
            &copied,
            0U) < 0 ||
        copied != sizeof(hash_length) || hash_length != 32U) {
      Close();
      return false;
    }
    if (BCryptCreateHash(
            algorithm_,
            &hash_,
            object_.data(),
            object_length,
            nullptr,
            0U,
            0U) < 0) {
      hash_ = nullptr;
      Close();
      return false;
    }
    return true;
  }

  bool Update(const std::uint8_t* bytes, std::size_t length) noexcept {
    if (hash_ == nullptr || (length != 0U && bytes == nullptr) ||
        length > static_cast<std::size_t>(std::numeric_limits<ULONG>::max())) {
      return false;
    }
    if (length == 0U) {
      return true;
    }
    return BCryptHashData(
               hash_,
               const_cast<PUCHAR>(bytes),
               static_cast<ULONG>(length),
               0U) >= 0;
  }

  bool Finish(Byte32* output) noexcept {
    if (hash_ == nullptr || output == nullptr) {
      return false;
    }
    if (BCryptFinishHash(
            hash_, output->data(), static_cast<ULONG>(output->size()), 0U) < 0) {
      return false;
    }
    BCryptDestroyHash(hash_);
    hash_ = nullptr;
    return true;
  }

 private:
  void Close() noexcept {
    if (hash_ != nullptr) {
      BCryptDestroyHash(hash_);
      hash_ = nullptr;
    }
    if (algorithm_ != nullptr) {
      BCryptCloseAlgorithmProvider(algorithm_, 0U);
      algorithm_ = nullptr;
    }
    SecureZeroMemory(object_.data(), object_.size());
  }

  BCRYPT_ALG_HANDLE algorithm_ = nullptr;
  BCRYPT_HASH_HANDLE hash_ = nullptr;
  std::array<std::uint8_t, kHashObjectMaximumBytes> object_{};
};

bool HashU8(Sha256Hasher* hash, std::uint8_t value) noexcept {
  return hash != nullptr && hash->Update(&value, 1U);
}

bool HashU16(Sha256Hasher* hash, std::uint16_t value) noexcept {
  std::array<std::uint8_t, 2U> bytes{};
  WriteU16(bytes.data(), value);
  return hash != nullptr && hash->Update(bytes.data(), bytes.size());
}

bool HashU32(Sha256Hasher* hash, std::uint32_t value) noexcept {
  std::array<std::uint8_t, 4U> bytes{};
  WriteU32(bytes.data(), value);
  return hash != nullptr && hash->Update(bytes.data(), bytes.size());
}

bool HashU64(Sha256Hasher* hash, std::uint64_t value) noexcept {
  std::array<std::uint8_t, 8U> bytes{};
  WriteU64(bytes.data(), value);
  return hash != nullptr && hash->Update(bytes.data(), bytes.size());
}

bool HashSid(Sha256Hasher* hash, const SidProjection& sid) noexcept {
  if (hash == nullptr || sid.length == 0U || sid.length > sid.bytes.size() ||
      !IsValidSid(const_cast<std::uint8_t*>(sid.bytes.data())) ||
      GetLengthSid(const_cast<std::uint8_t*>(sid.bytes.data())) != sid.length) {
    return false;
  }
  return HashU16(hash, sid.length) &&
         hash->Update(sid.bytes.data(), sid.length);
}

bool HashImage(Sha256Hasher* hash, const ImageProjection& image) noexcept {
  return hash != nullptr && HashU64(hash, image.volume_serial_number) &&
         hash->Update(image.file_id.data(), image.file_id.size()) &&
         HashU64(hash, image.file_size) &&
         hash->Update(image.sha256.data(), image.sha256.size());
}

bool HashToken(Sha256Hasher* hash, const TokenProjection& token) noexcept {
  return hash != nullptr && HashSid(hash, token.user) &&
         HashSid(hash, token.logon) &&
         HashU32(hash, token.logon_sid_attributes) &&
         HashU32(hash, token.authentication_id_low) &&
         HashU32(hash, static_cast<std::uint32_t>(token.authentication_id_high)) &&
         HashU32(hash, token.session_id) && HashU32(hash, token.elevation_type) &&
         HashU32(hash, token.integrity_rid) &&
         HashU32(hash, token.administrators_sid_attributes) &&
         HashU8(hash, token.has_restricted_sids ? 1U : 0U) &&
         HashU8(hash, 0U) && HashU16(hash, 0U);
}

bool GenerateRandom(std::uint8_t* output, std::size_t length) noexcept {
  if (output == nullptr || length == 0U ||
      length > static_cast<std::size_t>(std::numeric_limits<ULONG>::max())) {
    return false;
  }
  SecureZeroMemory(output, length);
  if (BCryptGenRandom(
          nullptr,
          output,
          static_cast<ULONG>(length),
          BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0 ||
      IsAllZero(output, length)) {
    SecureZeroMemory(output, length);
    return false;
  }
  return true;
}

template <std::size_t Size, std::size_t Capacity>
bool RegisterUniqueRandom(
    std::array<std::uint8_t, Size>* value,
    std::array<std::array<std::uint8_t, Size>, Capacity>* values,
    std::size_t* count) noexcept {
  if (value == nullptr || values == nullptr || count == nullptr ||
      InterlockedCompareExchange(&g_random_registry.held, 1, 0) != 0) {
    return false;
  }
  bool accepted = *count < values->size();
  for (std::size_t index = 0U; accepted && index < *count; ++index) {
    if (BytesEqual(
            value->data(), (*values)[index].data(), value->size())) {
      accepted = false;
    }
  }
  if (accepted) {
    (*values)[*count] = *value;
    ++(*count);
  }
  InterlockedExchange(&g_random_registry.held, 0);
  if (!accepted) {
    SecureZeroMemory(value->data(), value->size());
  }
  return accepted;
}

bool IsKnownGcpaError(std::uint32_t code) noexcept {
  return code == static_cast<std::uint32_t>(GcpaErrorCode::ProtocolInvalid) ||
         code == static_cast<std::uint32_t>(GcpaErrorCode::OperationUnavailable) ||
         code == static_cast<std::uint32_t>(GcpaErrorCode::IoFailed);
}

}  // namespace

bool GenerateRandom16(Byte16* output) noexcept {
  return output != nullptr && GenerateRandom(output->data(), output->size()) &&
         RegisterUniqueRandom(
             output, &g_random_registry.values16, &g_random_registry.count16);
}

bool GenerateRandom32(Byte32* output) noexcept {
  return output != nullptr && GenerateRandom(output->data(), output->size()) &&
         RegisterUniqueRandom(
             output, &g_random_registry.values32, &g_random_registry.count32);
}

#if defined(GOATCITADEL_PROVISIONER_TESTING)
void ResetRandomRegistryForTest() noexcept {
  if (InterlockedCompareExchange(&g_random_registry.held, 1, 0) != 0) {
    return;
  }
  g_random_registry.values16 = {};
  g_random_registry.values32 = {};
  g_random_registry.count16 = 0U;
  g_random_registry.count32 = 0U;
  InterlockedExchange(&g_random_registry.held, 0);
}

bool RegisterRandom16ForTest(const Byte16& value) noexcept {
  Byte16 copy = value;
  return !IsAllZero(copy.data(), copy.size()) &&
         RegisterUniqueRandom(
             &copy, &g_random_registry.values16, &g_random_registry.count16);
}

bool RegisterRandom32ForTest(const Byte32& value) noexcept {
  Byte32 copy = value;
  return !IsAllZero(copy.data(), copy.size()) &&
         RegisterUniqueRandom(
             &copy, &g_random_registry.values32, &g_random_registry.count32);
}
#endif

bool ComputeSha256(
    const std::uint8_t* bytes,
    std::size_t length,
    Byte32* output) noexcept {
  if (output == nullptr || (length != 0U && bytes == nullptr)) {
    return false;
  }
  Sha256Hasher hash;
  return hash.Open() && hash.Update(bytes, length) && hash.Finish(output);
}

bool DeriveRuntimePopV2OperationId(
    const std::uint8_t* authenticated_caller_sid,
    std::uint16_t authenticated_caller_sid_length,
    const Byte32& expected_state_sha256,
    std::uint64_t expected_generation,
    const Byte32& expected_keyset_receipt_sha256,
    const std::uint8_t* canonical_preimage,
    std::size_t canonical_preimage_length,
    Byte16* output) noexcept {
  if (output == nullptr) return false;
  output->fill(0U);
  if (authenticated_caller_sid == nullptr ||
      authenticated_caller_sid_length == 0U ||
      authenticated_caller_sid_length > SECURITY_MAX_SID_SIZE ||
      IsAllZero(expected_state_sha256.data(), expected_state_sha256.size()) ||
      expected_generation == 0U ||
      expected_generation > kMaximumContractSafeInteger ||
      IsAllZero(
          expected_keyset_receipt_sha256.data(),
          expected_keyset_receipt_sha256.size()) ||
      canonical_preimage == nullptr ||
      canonical_preimage_length != kRemoteWorkerPopV2PreimageBytes) {
    return false;
  }
  std::array<std::uint8_t, SECURITY_MAX_SID_SIZE> caller_sid{};
  std::memcpy(
      caller_sid.data(),
      authenticated_caller_sid,
      authenticated_caller_sid_length);
  if (IsValidSid(caller_sid.data()) == FALSE ||
      GetLengthSid(caller_sid.data()) != authenticated_caller_sid_length) {
    return false;
  }
  const std::array<std::uint8_t, 2U> sid_length = {
      static_cast<std::uint8_t>(authenticated_caller_sid_length & 0xffU),
      static_cast<std::uint8_t>(authenticated_caller_sid_length >> 8U),
  };
  Byte32 digest{};
  Sha256Hasher hash;
  const bool valid = hash.Open() &&
      hash.Update(
          reinterpret_cast<const std::uint8_t*>(kRuntimePopV2OperationDomain),
          sizeof(kRuntimePopV2OperationDomain)) &&
      hash.Update(sid_length.data(), sid_length.size()) &&
      hash.Update(caller_sid.data(), authenticated_caller_sid_length) &&
      hash.Update(expected_state_sha256.data(), expected_state_sha256.size()) &&
      HashU64(&hash, expected_generation) &&
      hash.Update(
          expected_keyset_receipt_sha256.data(),
          expected_keyset_receipt_sha256.size()) &&
      hash.Update(canonical_preimage, canonical_preimage_length) &&
      hash.Finish(&digest) && !IsAllZero(digest.data(), output->size());
  if (valid) {
    std::memcpy(output->data(), digest.data(), output->size());
  }
  SecureZeroMemory(digest.data(), digest.size());
  return valid;
}

bool ComputeAuthenticatedRequestBinding(
    const AuthenticatedRequestBindingInput& input,
    Byte32* output) noexcept {
  if (output == nullptr || input.service_image == nullptr ||
      input.client_image == nullptr || input.client_primary == nullptr ||
      input.pipe_identification == nullptr || input.service_start_nonce == nullptr ||
      input.connection_nonce == nullptr || input.client_nonce == nullptr ||
      input.operation_id == nullptr || input.body_sha256 == nullptr ||
      input.expected_state_sha256 == nullptr || input.service_pid == 0U ||
      input.client_pid == 0U || input.service_creation_file_time == 0U ||
      input.client_creation_file_time == 0U || input.schema != kGcpaSchema ||
      IsAllZero(input.service_start_nonce->data(), input.service_start_nonce->size()) ||
      IsAllZero(input.connection_nonce->data(), input.connection_nonce->size()) ||
      IsAllZero(input.client_nonce->data(), input.client_nonce->size()) ||
      IsAllZero(input.operation_id->data(), input.operation_id->size())) {
    return false;
  }

  Sha256Hasher hash;
  return hash.Open() &&
         hash.Update(
             reinterpret_cast<const std::uint8_t*>(kAuthenticatedRequestDomain),
             sizeof(kAuthenticatedRequestDomain)) &&
         HashImage(&hash, *input.service_image) &&
         HashImage(&hash, *input.client_image) &&
         HashToken(&hash, *input.client_primary) &&
         HashToken(&hash, *input.pipe_identification) &&
         HashU32(&hash, input.service_pid) &&
         HashU64(&hash, input.service_creation_file_time) &&
         HashU32(&hash, input.client_pid) &&
         HashU64(&hash, input.client_creation_file_time) &&
         hash.Update(input.service_start_nonce->data(), input.service_start_nonce->size()) &&
         hash.Update(input.connection_nonce->data(), input.connection_nonce->size()) &&
         hash.Update(input.client_nonce->data(), input.client_nonce->size()) &&
         hash.Update(input.operation_id->data(), input.operation_id->size()) &&
         HashU8(&hash, input.opcode) && HashU8(&hash, input.schema) &&
         HashU16(&hash, 0U) &&
         hash.Update(input.body_sha256->data(), input.body_sha256->size()) &&
         hash.Update(
             input.expected_state_sha256->data(),
             input.expected_state_sha256->size()) &&
         hash.Finish(output);
}

bool FreezeCurrentMessageBudget(
    std::uint32_t total_available,
    std::uint32_t current_message_left,
    std::size_t phase_maximum,
    std::size_t* frozen_budget) noexcept {
  if (frozen_budget == nullptr || total_available == 0U ||
      current_message_left == 0U || total_available != current_message_left ||
      static_cast<std::size_t>(total_available) > phase_maximum) {
    return false;
  }
  *frozen_budget = static_cast<std::size_t>(total_available);
  return true;
}

bool FrozenFrameLengthIsExact(
    std::size_t frozen_budget,
    std::size_t fixed_payload_prefix,
    std::uint32_t variable_body_length) noexcept {
  std::size_t payload_length = 0U;
  std::size_t total_length = 0U;
  return AddSize(
             fixed_payload_prefix,
             static_cast<std::size_t>(variable_body_length),
             &payload_length) &&
         AddSize(kGcpaHeaderBytes, payload_length, &total_length) &&
         total_length == frozen_budget;
}

bool EncodeGcpaClientHello(
    const Byte32& client_nonce,
    std::uint8_t* output,
    std::size_t output_capacity,
    std::size_t* output_length) noexcept {
  constexpr std::size_t kFrameBytes =
      kGcpaHeaderBytes + kGcpaClientHelloPayloadBytes;
  if (output_length == nullptr || output == nullptr || output_capacity < kFrameBytes ||
      IsAllZero(client_nonce.data(), client_nonce.size()) ||
      !WriteGcpaHeader(
          GcpaKind::ClientHello,
          static_cast<std::uint32_t>(kGcpaClientHelloPayloadBytes),
          output,
          output_capacity)) {
    return false;
  }
  std::memcpy(output + kGcpaHeaderBytes, client_nonce.data(), client_nonce.size());
  *output_length = kFrameBytes;
  return true;
}

bool DecodeGcpaClientHello(
    const std::uint8_t* frame,
    std::size_t frame_length,
    Byte32* client_nonce) noexcept {
  if (client_nonce == nullptr ||
      !HasGcpaHeader(
          frame,
          frame_length,
          GcpaKind::ClientHello,
          static_cast<std::uint32_t>(kGcpaClientHelloPayloadBytes))) {
    return false;
  }
  std::memcpy(client_nonce->data(), frame + kGcpaHeaderBytes, client_nonce->size());
  return !IsAllZero(client_nonce->data(), client_nonce->size());
}

bool EncodeGcpaServerHello(
    const GcpaServerHelloFields& fields,
    std::uint8_t* output,
    std::size_t output_capacity,
    std::size_t* output_length) noexcept {
  constexpr std::size_t kFrameBytes =
      kGcpaHeaderBytes + kGcpaServerHelloPayloadBytes;
  if (output_length == nullptr || output == nullptr || output_capacity < kFrameBytes ||
      IsAllZero(fields.service_start_nonce.data(), fields.service_start_nonce.size()) ||
      IsAllZero(fields.connection_nonce.data(), fields.connection_nonce.size()) ||
      IsAllZero(fields.client_nonce.data(), fields.client_nonce.size()) ||
      fields.recognized_operation_bitmap != kGcpaRecognizedOpcodeBitmap ||
      fields.callable_operation_bitmap != kGcpaCallableOpcodeBitmap ||
      !WriteGcpaHeader(
          GcpaKind::ServerHello,
          static_cast<std::uint32_t>(kGcpaServerHelloPayloadBytes),
          output,
          output_capacity)) {
    return false;
  }
  std::uint8_t* payload = output + kGcpaHeaderBytes;
  std::memcpy(payload + 0U, fields.service_start_nonce.data(), 32U);
  std::memcpy(payload + 32U, fields.connection_nonce.data(), 32U);
  std::memcpy(payload + 64U, fields.client_nonce.data(), 32U);
  WriteU64(payload + 96U, fields.recognized_operation_bitmap);
  WriteU64(payload + 104U, fields.callable_operation_bitmap);
  *output_length = kFrameBytes;
  return true;
}

bool DecodeGcpaServerHello(
    const std::uint8_t* frame,
    std::size_t frame_length,
    GcpaServerHelloFields* fields) noexcept {
  if (fields == nullptr ||
      !HasGcpaHeader(
          frame,
          frame_length,
          GcpaKind::ServerHello,
          static_cast<std::uint32_t>(kGcpaServerHelloPayloadBytes))) {
    return false;
  }
  *fields = GcpaServerHelloFields{};
  const std::uint8_t* payload = frame + kGcpaHeaderBytes;
  std::memcpy(fields->service_start_nonce.data(), payload + 0U, 32U);
  std::memcpy(fields->connection_nonce.data(), payload + 32U, 32U);
  std::memcpy(fields->client_nonce.data(), payload + 64U, 32U);
  fields->recognized_operation_bitmap = ReadU64(payload + 96U);
  fields->callable_operation_bitmap = ReadU64(payload + 104U);
  return !IsAllZero(fields->service_start_nonce.data(), 32U) &&
         !IsAllZero(fields->connection_nonce.data(), 32U) &&
         !IsAllZero(fields->client_nonce.data(), 32U) &&
         fields->recognized_operation_bitmap == kGcpaRecognizedOpcodeBitmap &&
         fields->callable_operation_bitmap == kGcpaCallableOpcodeBitmap;
}

bool EncodeGcpaClientRequest(
    const GcpaClientRequestFields& fields,
    std::uint8_t* output,
    std::size_t output_capacity,
    std::size_t* output_length) noexcept {
  std::size_t payload_length = 0U;
  std::size_t frame_length = 0U;
  Byte32 actual_body_hash{};
  if (output == nullptr || output_length == nullptr ||
      fields.body_length > kOrdinaryMaximumBytes ||
      (fields.body_length != 0U && fields.body == nullptr) ||
      fields.schema != kGcpaSchema ||
      IsAllZero(fields.service_start_nonce.data(), 32U) ||
      IsAllZero(fields.connection_nonce.data(), 32U) ||
      IsAllZero(fields.client_nonce.data(), 32U) ||
      IsAllZero(fields.operation_id.data(), 16U) ||
      !ComputeSha256(fields.body, fields.body_length, &actual_body_hash) ||
      !BytesEqual(actual_body_hash.data(), fields.body_sha256.data(), 32U) ||
      !AddSize(
          kGcpaClientRequestPrefixBytes,
          static_cast<std::size_t>(fields.body_length),
          &payload_length) ||
      !AddSize(kGcpaHeaderBytes, payload_length, &frame_length) ||
      payload_length > static_cast<std::size_t>(std::numeric_limits<std::uint32_t>::max()) ||
      output_capacity < frame_length ||
      !WriteGcpaHeader(
          GcpaKind::ClientRequest,
          static_cast<std::uint32_t>(payload_length),
          output,
          output_capacity)) {
    return false;
  }
  std::uint8_t* payload = output + kGcpaHeaderBytes;
  std::memcpy(payload + 0U, fields.service_start_nonce.data(), 32U);
  std::memcpy(payload + 32U, fields.connection_nonce.data(), 32U);
  std::memcpy(payload + 64U, fields.client_nonce.data(), 32U);
  std::memcpy(payload + 96U, fields.operation_id.data(), 16U);
  payload[112U] = fields.opcode;
  payload[113U] = fields.schema;
  WriteU16(payload + 114U, 0U);
  WriteU32(payload + 116U, fields.body_length);
  std::memcpy(payload + 120U, fields.body_sha256.data(), 32U);
  std::memcpy(payload + 152U, fields.expected_state_sha256.data(), 32U);
  if (fields.body_length != 0U) {
    std::memcpy(payload + 184U, fields.body, fields.body_length);
  }
  *output_length = frame_length;
  return true;
}

bool DecodeGcpaClientRequest(
    const std::uint8_t* frame,
    std::size_t frame_length,
    GcpaClientRequestFields* fields) noexcept {
  if (frame == nullptr || fields == nullptr ||
      frame_length < kGcpaHeaderBytes + kGcpaClientRequestPrefixBytes ||
      frame[0] != kGcpaMagic[0] || frame[1] != kGcpaMagic[1] ||
      frame[2] != kGcpaMagic[2] || frame[3] != kGcpaMagic[3] ||
      ReadU16(frame + 4U) != kGcpaVersion ||
      frame[6] != static_cast<std::uint8_t>(GcpaKind::ClientRequest) ||
      frame[7] != kGcpaFlags || ReadU32(frame + 8U) != kGcpaRequestId ||
      ReadU32(frame + 12U) != frame_length - kGcpaHeaderBytes) {
    return false;
  }
  const std::uint8_t* payload = frame + kGcpaHeaderBytes;
  const std::uint32_t body_length = ReadU32(payload + 116U);
  if (body_length > kOrdinaryMaximumBytes || ReadU16(payload + 114U) != 0U ||
      payload[113U] != kGcpaSchema ||
      !FrozenFrameLengthIsExact(
          frame_length, kGcpaClientRequestPrefixBytes, body_length)) {
    return false;
  }
  *fields = GcpaClientRequestFields{};
  std::memcpy(fields->service_start_nonce.data(), payload + 0U, 32U);
  std::memcpy(fields->connection_nonce.data(), payload + 32U, 32U);
  std::memcpy(fields->client_nonce.data(), payload + 64U, 32U);
  std::memcpy(fields->operation_id.data(), payload + 96U, 16U);
  fields->opcode = payload[112U];
  fields->schema = payload[113U];
  fields->body_length = body_length;
  std::memcpy(fields->body_sha256.data(), payload + 120U, 32U);
  std::memcpy(fields->expected_state_sha256.data(), payload + 152U, 32U);
  fields->body = body_length == 0U ? nullptr : payload + 184U;
  Byte32 actual_body_hash{};
  return !IsAllZero(fields->service_start_nonce.data(), 32U) &&
         !IsAllZero(fields->connection_nonce.data(), 32U) &&
         !IsAllZero(fields->client_nonce.data(), 32U) &&
         !IsAllZero(fields->operation_id.data(), 16U) &&
         ComputeSha256(fields->body, fields->body_length, &actual_body_hash) &&
         BytesEqual(actual_body_hash.data(), fields->body_sha256.data(), 32U);
}

bool EncodeGcpaServerResult(
    const Byte16& operation_id,
    const Byte32& authenticated_request_binding,
    const std::uint8_t* result,
    std::uint32_t result_length,
    std::uint8_t* output,
    std::size_t output_capacity,
    std::size_t* output_length) noexcept {
  std::size_t payload_length = 0U;
  std::size_t frame_length = 0U;
  Byte32 result_hash{};
  if (output == nullptr || output_length == nullptr ||
      result_length > kSecretMaximumBytes ||
      (result_length != 0U && result == nullptr) ||
      IsAllZero(operation_id.data(), operation_id.size()) ||
      IsAllZero(
          authenticated_request_binding.data(),
          authenticated_request_binding.size()) ||
      !ComputeSha256(result, result_length, &result_hash) ||
      !AddSize(
          kGcpaServerResultPrefixBytes,
          static_cast<std::size_t>(result_length),
          &payload_length) ||
      !AddSize(kGcpaHeaderBytes, payload_length, &frame_length) ||
      output_capacity < frame_length ||
      !WriteGcpaHeader(
          GcpaKind::ServerResult,
          static_cast<std::uint32_t>(payload_length),
          output,
          output_capacity)) {
    return false;
  }
  std::uint8_t* payload = output + kGcpaHeaderBytes;
  std::memcpy(payload + 0U, operation_id.data(), 16U);
  std::memcpy(payload + 16U, authenticated_request_binding.data(), 32U);
  std::memcpy(payload + 48U, result_hash.data(), 32U);
  WriteU32(payload + 80U, result_length);
  if (result_length != 0U) {
    std::memcpy(payload + 84U, result, result_length);
  }
  *output_length = frame_length;
  return true;
}

bool EncodeGcpaError(
    GcpaErrorCode error_code,
    const Byte16& operation_id,
    const Byte32& authenticated_request_binding,
    std::uint8_t* output,
    std::size_t output_capacity,
    std::size_t* output_length) noexcept {
  constexpr std::size_t kFrameBytes = kGcpaHeaderBytes + kGcpaErrorPayloadBytes;
  const std::uint32_t code = static_cast<std::uint32_t>(error_code);
  const bool zero_id = IsAllZero(operation_id.data(), operation_id.size());
  const bool zero_binding = IsAllZero(
      authenticated_request_binding.data(),
      authenticated_request_binding.size());
  if (output == nullptr || output_length == nullptr || output_capacity < kFrameBytes ||
      !IsKnownGcpaError(code) || zero_id != zero_binding ||
      (zero_id && error_code != GcpaErrorCode::ProtocolInvalid) ||
      !WriteGcpaHeader(
          GcpaKind::Error,
          static_cast<std::uint32_t>(kGcpaErrorPayloadBytes),
          output,
          output_capacity)) {
    return false;
  }
  std::uint8_t* payload = output + kGcpaHeaderBytes;
  WriteU32(payload + 0U, code);
  std::memcpy(payload + 4U, operation_id.data(), 16U);
  std::memcpy(payload + 20U, authenticated_request_binding.data(), 32U);
  *output_length = kFrameBytes;
  return true;
}

bool DecodeGcpaServerResponse(
    const std::uint8_t* frame,
    std::size_t frame_length,
    GcpaServerResponseFields* fields) noexcept {
  if (frame == nullptr || fields == nullptr || frame_length < kGcpaHeaderBytes ||
      frame[0] != kGcpaMagic[0] || frame[1] != kGcpaMagic[1] ||
      frame[2] != kGcpaMagic[2] || frame[3] != kGcpaMagic[3] ||
      ReadU16(frame + 4U) != kGcpaVersion || frame[7] != kGcpaFlags ||
      ReadU32(frame + 8U) != kGcpaRequestId ||
      ReadU32(frame + 12U) != frame_length - kGcpaHeaderBytes) {
    return false;
  }
  *fields = GcpaServerResponseFields{};
  const std::uint8_t* payload = frame + kGcpaHeaderBytes;
  if (frame[6] == static_cast<std::uint8_t>(GcpaKind::Error)) {
    if (frame_length != kGcpaHeaderBytes + kGcpaErrorPayloadBytes) {
      return false;
    }
    const std::uint32_t code = ReadU32(payload + 0U);
    if (!IsKnownGcpaError(code)) {
      return false;
    }
    fields->kind = GcpaKind::Error;
    fields->error_code = static_cast<GcpaErrorCode>(code);
    std::memcpy(fields->operation_id.data(), payload + 4U, 16U);
    std::memcpy(fields->authenticated_request_binding.data(), payload + 20U, 32U);
    const bool zero_id = IsAllZero(fields->operation_id.data(), 16U);
    const bool zero_binding = IsAllZero(
        fields->authenticated_request_binding.data(), 32U);
    return zero_id == zero_binding &&
           (!zero_id || fields->error_code == GcpaErrorCode::ProtocolInvalid);
  }
  if (frame[6] != static_cast<std::uint8_t>(GcpaKind::ServerResult) ||
      frame_length < kGcpaHeaderBytes + kGcpaServerResultPrefixBytes) {
    return false;
  }
  const std::uint32_t result_length = ReadU32(payload + 80U);
  if (result_length > kSecretMaximumBytes ||
      !FrozenFrameLengthIsExact(
          frame_length, kGcpaServerResultPrefixBytes, result_length)) {
    return false;
  }
  fields->kind = GcpaKind::ServerResult;
  std::memcpy(fields->operation_id.data(), payload + 0U, 16U);
  std::memcpy(fields->authenticated_request_binding.data(), payload + 16U, 32U);
  std::memcpy(fields->result_sha256.data(), payload + 48U, 32U);
  fields->result_length = result_length;
  fields->result = result_length == 0U ? nullptr : payload + 84U;
  Byte32 actual_result_hash{};
  return !IsAllZero(fields->operation_id.data(), 16U) &&
         !IsAllZero(fields->authenticated_request_binding.data(), 32U) &&
         ComputeSha256(fields->result, fields->result_length, &actual_result_hash) &&
         BytesEqual(actual_result_hash.data(), fields->result_sha256.data(), 32U);
}

namespace {

constexpr std::size_t kMaximumProtectedPathCharacters = 512U;
constexpr std::size_t kMaximumTokenQueryBytes = 64U * 1024U;
constexpr std::uint64_t kMaximumProtectedExecutableBytes = 64U * 1024U * 1024U;
constexpr std::uint64_t kServiceStateMagic = UINT64_C(0x4750434157314153);

struct FixedPath final {
  std::array<wchar_t, kMaximumProtectedPathCharacters> value{};
  std::size_t length = 0U;
};

struct HeldLayout final {
  HANDLE system_root = nullptr;
  HANDLE volume_root = nullptr;
  HANDLE program_data = nullptr;
  HANDLE goatcitadel = nullptr;
  HANDLE provisioner_root = nullptr;
  HANDLE bin = nullptr;
  HANDLE service_image = nullptr;
  HANDLE client_image = nullptr;
  FILE_ID_INFO system_root_id{};
  FILE_ID_INFO volume_root_id{};
  FILE_ID_INFO program_data_id{};
  FILE_ID_INFO goatcitadel_id{};
  FILE_ID_INFO provisioner_root_id{};
  FILE_ID_INFO bin_id{};
  FILE_ID_INFO service_image_id{};
  FILE_ID_INFO client_image_id{};
  FixedPath extended_volume_root{};
  FixedPath dos_volume_root{};
  FixedPath service_path_extended{};
  FixedPath service_path_dos{};
  FixedPath client_path_extended{};
  FixedPath client_path_dos{};
  ImageProjection service_projection{};
  ImageProjection client_projection{};
};

struct ProcessEvidence final {
  HANDLE process = nullptr;
  HANDLE token = nullptr;
  std::uint32_t pid = 0U;
  std::uint64_t creation_file_time = 0U;
  TokenProjection token_projection{};
};

struct ServiceStateInternal final {
  std::uint64_t magic = kServiceStateMagic;
  ServiceTransportContext context{};
  Byte32 service_start_nonce{};
  Byte32 expected_client_sha256{};
  HeldLayout layout{};
  HANDLE pipe = nullptr;
  HANDLE accept_event = nullptr;
  OVERLAPPED accept_overlapped{};
  bool accept_pending = false;
  bool accept_completed = false;
  bool images_validated = false;
  bool pipe_armed = false;
  bool run_started = false;
  ProcessEvidence client{};
  TokenProjection pipe_identification{};
  Byte32 connection_nonce{};
  Byte32 client_nonce{};
  Byte16 operation_id{};
  Byte32 request_binding{};
#if defined(GOATCITADEL_PROVISIONER_CUSTODY)
  ProtectedOperationsState protected_operations{};
  bool protected_recovery_verified = false;
#endif
  std::array<std::uint8_t, kGcpaMaximumRequestFrameBytes> frame{};
};

static_assert(
    sizeof(ServiceStateInternal) <= kServiceTransportStateBytes,
    "ServiceTransportState storage is too small.");
static_assert(
    alignof(ServiceStateInternal) <= alignof(ServiceTransportState),
    "ServiceTransportState alignment is too small.");

class ScopedHandle final {
 public:
  ScopedHandle() noexcept = default;
  explicit ScopedHandle(HANDLE handle) noexcept : handle_(handle) {}
  ~ScopedHandle() noexcept { Reset(); }
  ScopedHandle(const ScopedHandle&) = delete;
  ScopedHandle& operator=(const ScopedHandle&) = delete;

  HANDLE get() const noexcept { return handle_; }
  HANDLE Release() noexcept {
    const HANDLE handle = handle_;
    handle_ = nullptr;
    return handle;
  }
  void Reset(HANDLE handle = nullptr) noexcept {
    if (handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE) {
      CloseHandle(handle_);
    }
    handle_ = handle;
  }

 private:
  HANDLE handle_ = nullptr;
};

class ScopedServiceHandle final {
 public:
  ScopedServiceHandle() noexcept = default;
  explicit ScopedServiceHandle(SC_HANDLE handle) noexcept : handle_(handle) {}
  ~ScopedServiceHandle() noexcept {
    if (handle_ != nullptr) {
      CloseServiceHandle(handle_);
    }
  }
  ScopedServiceHandle(const ScopedServiceHandle&) = delete;
  ScopedServiceHandle& operator=(const ScopedServiceHandle&) = delete;
  SC_HANDLE get() const noexcept { return handle_; }

 private:
  SC_HANDLE handle_ = nullptr;
};

struct SidBuffer final {
  std::array<std::uint8_t, SECURITY_MAX_SID_SIZE> bytes{};
  DWORD length = 0U;
};

bool MakeNtSid(
    const std::uint32_t* subauthorities,
    std::size_t count,
    SidBuffer* output) noexcept {
  if (subauthorities == nullptr || output == nullptr || count == 0U ||
      count > 15U || 8U + (count * 4U) > output->bytes.size()) {
    return false;
  }
  output->bytes.fill(0U);
  output->bytes[0] = SID_REVISION;
  output->bytes[1] = static_cast<std::uint8_t>(count);
  output->bytes[7] = 5U;
  for (std::size_t index = 0U; index < count; ++index) {
    WriteU32(output->bytes.data() + 8U + (index * 4U), subauthorities[index]);
  }
  output->length = static_cast<DWORD>(8U + (count * 4U));
  return IsValidSid(output->bytes.data()) != FALSE &&
         GetLengthSid(output->bytes.data()) == output->length;
}

bool MakeLocalSystemSid(SidBuffer* output) noexcept {
  constexpr std::array<std::uint32_t, 1U> kParts = {18U};
  return MakeNtSid(kParts.data(), kParts.size(), output);
}

bool MakeAdministratorsSid(SidBuffer* output) noexcept {
  constexpr std::array<std::uint32_t, 2U> kParts = {32U, 544U};
  return MakeNtSid(kParts.data(), kParts.size(), output);
}

bool MakeProvisionerServiceSid(SidBuffer* output) noexcept {
  constexpr std::array<std::uint32_t, 6U> kParts = {
      80U,
      UINT32_C(1765223994),
      UINT32_C(2719708455),
      UINT32_C(3112291649),
      UINT32_C(2938929260),
      UINT32_C(976374647),
  };
  return MakeNtSid(kParts.data(), kParts.size(), output);
}

bool MakeTrustedInstallerSid(SidBuffer* output) noexcept {
  constexpr std::array<std::uint32_t, 6U> kParts = {
      80U,
      UINT32_C(956008885),
      UINT32_C(3418522649),
      UINT32_C(1831038044),
      UINT32_C(1853292631),
      UINT32_C(2271478464),
  };
  return MakeNtSid(kParts.data(), kParts.size(), output);
}

bool EqualSidBytes(PSID left, PSID right) noexcept {
  return left != nullptr && right != nullptr && IsValidSid(left) != FALSE &&
         IsValidSid(right) != FALSE && EqualSid(left, right) != FALSE;
}

bool AppendLiteral(FixedPath* path, const wchar_t* literal) noexcept {
  if (path == nullptr || literal == nullptr || path->length >= path->value.size()) {
    return false;
  }
  for (std::size_t index = 0U; literal[index] != L'\0'; ++index) {
    if (path->length + 1U >= path->value.size()) {
      return false;
    }
    path->value[path->length++] = literal[index];
  }
  path->value[path->length] = L'\0';
  return true;
}

bool AppendComponent(FixedPath* path, const wchar_t* component) noexcept {
  if (path == nullptr || component == nullptr) {
    return false;
  }
  if (path->length != 0U && path->value[path->length - 1U] != L'\\' &&
      !AppendLiteral(path, L"\\")) {
    return false;
  }
  return AppendLiteral(path, component);
}

bool CopyPath(const FixedPath& source, FixedPath* destination) noexcept {
  if (destination == nullptr || source.length >= destination->value.size()) {
    return false;
  }
  *destination = source;
  destination->value[destination->length] = L'\0';
  return true;
}

bool EqualOrdinalPath(const wchar_t* left, const wchar_t* right) noexcept {
  return left != nullptr && right != nullptr &&
         CompareStringOrdinal(left, -1, right, -1, TRUE) == CSTR_EQUAL;
}

bool QueryFileId(HANDLE handle, FILE_ID_INFO* output) noexcept {
  return handle != nullptr && handle != INVALID_HANDLE_VALUE && output != nullptr &&
         GetFileInformationByHandleEx(
             handle, FileIdInfo, output, static_cast<DWORD>(sizeof(*output))) != FALSE;
}

bool SameFileId(const FILE_ID_INFO& left, const FILE_ID_INFO& right) noexcept {
  return left.VolumeSerialNumber == right.VolumeSerialNumber &&
         BytesEqual(left.FileId.Identifier, right.FileId.Identifier, 16U);
}

bool IsDirectoryHandle(HANDLE handle, bool permit_reparse) noexcept {
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  if (handle == nullptr || handle == INVALID_HANDLE_VALUE ||
      GetFileInformationByHandleEx(
          handle,
          FileAttributeTagInfo,
          &attributes,
          static_cast<DWORD>(sizeof(attributes))) == FALSE ||
      (attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0U) {
    return false;
  }
  return permit_reparse ||
         ((attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0U &&
          attributes.ReparseTag == 0U);
}

bool QueryFinalPath(HANDLE handle, FixedPath* output) noexcept {
  if (handle == nullptr || handle == INVALID_HANDLE_VALUE || output == nullptr) {
    return false;
  }
  output->value.fill(L'\0');
  const DWORD length = GetFinalPathNameByHandleW(
      handle,
      output->value.data(),
      static_cast<DWORD>(output->value.size()),
      FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (length == 0U || length >= output->value.size()) {
    return false;
  }
  output->length = static_cast<std::size_t>(length);
  output->value[output->length] = L'\0';
  return true;
}

bool QuerySecurity(
    HANDLE handle,
    PSID* owner,
    PACL* dacl,
    PSECURITY_DESCRIPTOR* descriptor,
    SECURITY_DESCRIPTOR_CONTROL* control,
    bool* dacl_defaulted) noexcept {
  if (handle == nullptr || handle == INVALID_HANDLE_VALUE || owner == nullptr ||
      dacl == nullptr || descriptor == nullptr || control == nullptr ||
      dacl_defaulted == nullptr) {
    return false;
  }
  *owner = nullptr;
  *dacl = nullptr;
  *descriptor = nullptr;
  const DWORD status = GetSecurityInfo(
      handle,
      SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      owner,
      nullptr,
      dacl,
      nullptr,
      descriptor);
  if (status != ERROR_SUCCESS || *descriptor == nullptr || *owner == nullptr ||
      *dacl == nullptr || IsValidSecurityDescriptor(*descriptor) == FALSE) {
    if (*descriptor != nullptr) {
      LocalFree(*descriptor);
      *descriptor = nullptr;
    }
    return false;
  }
  DWORD revision = 0U;
  BOOL present = FALSE;
  BOOL defaulted = TRUE;
  PACL descriptor_dacl = nullptr;
  if (GetSecurityDescriptorControl(*descriptor, control, &revision) == FALSE ||
      revision != SECURITY_DESCRIPTOR_REVISION ||
      GetSecurityDescriptorDacl(
          *descriptor, &present, &descriptor_dacl, &defaulted) == FALSE ||
      present == FALSE || descriptor_dacl == nullptr || descriptor_dacl != *dacl ||
      IsValidAcl(*dacl) == FALSE) {
    LocalFree(*descriptor);
    *descriptor = nullptr;
    return false;
  }
  *dacl_defaulted = defaulted != FALSE;
  return true;
}

bool ValidateExactProtectedDacl(HANDLE handle) noexcept {
  SidBuffer system{};
  SidBuffer service{};
  SidBuffer administrators{};
  PSID owner = nullptr;
  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_DESCRIPTOR_CONTROL control = 0U;
  bool defaulted = true;
  if (!MakeLocalSystemSid(&system) || !MakeProvisionerServiceSid(&service) ||
      !MakeAdministratorsSid(&administrators) ||
      !QuerySecurity(
          handle, &owner, &dacl, &descriptor, &control, &defaulted)) {
    return false;
  }
  bool valid = !defaulted && EqualSidBytes(owner, system.bytes.data()) &&
               (control & SE_DACL_PROTECTED) != 0U && dacl->AceCount == 3U;
  const std::array<PSID, 3U> expected_sids = {
      system.bytes.data(), service.bytes.data(), administrators.bytes.data()};
  const std::array<DWORD, 3U> expected_masks = {
      kProtectedFullMask, kProtectedReadMask, kProtectedReadMask};
  for (DWORD index = 0U; valid && index < 3U; ++index) {
    void* raw_ace = nullptr;
    if (GetAce(dacl, index, &raw_ace) == FALSE || raw_ace == nullptr) {
      valid = false;
      break;
    }
    const auto* header = static_cast<const ACE_HEADER*>(raw_ace);
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE ||
        header->AceFlags != 0U ||
        header->AceSize < sizeof(ACCESS_ALLOWED_ACE)) {
      valid = false;
      break;
    }
    const auto* ace = static_cast<const ACCESS_ALLOWED_ACE*>(raw_ace);
    PSID sid = const_cast<DWORD*>(&ace->SidStart);
    valid = ace->Mask == expected_masks[index] &&
            EqualSidBytes(sid, expected_sids[index]) &&
            header->AceSize ==
                sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + GetLengthSid(sid);
  }
  LocalFree(descriptor);
  return valid;
}

bool IsTrustedAncestorSid(
    PSID sid,
    const SidBuffer& system,
    const SidBuffer& trusted_installer,
    const SidBuffer& administrators,
    const SidBuffer& service) noexcept {
  return EqualSidBytes(sid, const_cast<std::uint8_t*>(system.bytes.data())) ||
         EqualSidBytes(
             sid, const_cast<std::uint8_t*>(trusted_installer.bytes.data())) ||
         EqualSidBytes(
             sid, const_cast<std::uint8_t*>(administrators.bytes.data())) ||
         EqualSidBytes(sid, const_cast<std::uint8_t*>(service.bytes.data()));
}

bool ValidateAncestorDacl(HANDLE handle, bool goatcitadel_level) noexcept {
  SidBuffer system{};
  SidBuffer trusted_installer{};
  SidBuffer administrators{};
  SidBuffer service{};
  PSID owner = nullptr;
  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_DESCRIPTOR_CONTROL control = 0U;
  bool defaulted = false;
  if (!MakeLocalSystemSid(&system) ||
      !MakeTrustedInstallerSid(&trusted_installer) ||
      !MakeAdministratorsSid(&administrators) ||
      !MakeProvisionerServiceSid(&service) ||
      !QuerySecurity(
          handle, &owner, &dacl, &descriptor, &control, &defaulted)) {
    return false;
  }
  bool valid = EqualSidBytes(owner, system.bytes.data()) ||
               EqualSidBytes(owner, trusted_installer.bytes.data());
  DWORD forbidden = FILE_DELETE_CHILD | WRITE_DAC | WRITE_OWNER |
                    GENERIC_WRITE | GENERIC_ALL;
  if (goatcitadel_level) {
    forbidden |= FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA |
                 FILE_WRITE_ATTRIBUTES | DELETE;
  }
  for (DWORD index = 0U; valid && index < dacl->AceCount; ++index) {
    void* raw_ace = nullptr;
    if (GetAce(dacl, index, &raw_ace) == FALSE || raw_ace == nullptr) {
      valid = false;
      break;
    }
    const auto* header = static_cast<const ACE_HEADER*>(raw_ace);
    if ((header->AceFlags & INHERIT_ONLY_ACE) != 0U) {
      continue;
    }
    if (header->AceType == ACCESS_DENIED_ACE_TYPE) {
      continue;
    }
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE ||
        header->AceSize < sizeof(ACCESS_ALLOWED_ACE)) {
      valid = false;
      break;
    }
    const auto* ace = static_cast<const ACCESS_ALLOWED_ACE*>(raw_ace);
    PSID sid = const_cast<DWORD*>(&ace->SidStart);
    if (IsValidSid(sid) == FALSE ||
        header->AceSize !=
            sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + GetLengthSid(sid)) {
      valid = false;
      break;
    }
    if (!IsTrustedAncestorSid(
            sid, system, trusted_installer, administrators, service) &&
        (ace->Mask & forbidden) != 0U) {
      valid = false;
    }
  }
  LocalFree(descriptor);
  return valid;
}

bool OpenDirectory(
    const FixedPath& path,
    HANDLE* output,
    FILE_ID_INFO* identity) noexcept {
  if (output == nullptr || identity == nullptr || path.length == 0U) {
    return false;
  }
  ScopedHandle handle(CreateFileW(
      path.value.data(),
      FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
      FILE_SHARE_READ,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
      nullptr));
  if (handle.get() == INVALID_HANDLE_VALUE ||
      !IsDirectoryHandle(handle.get(), false) ||
      !QueryFileId(handle.get(), identity)) {
    return false;
  }
  FixedPath final_path{};
  if (!QueryFinalPath(handle.get(), &final_path) ||
      !EqualOrdinalPath(final_path.value.data(), path.value.data())) {
    return false;
  }
  *output = handle.Release();
  return true;
}

bool ValidateOnlyUnnamedDataStream(const FixedPath& path) noexcept {
  WIN32_FIND_STREAM_DATA data{};
  HANDLE find = FindFirstStreamW(
      path.value.data(), FindStreamInfoStandard, &data, 0U);
  if (find == INVALID_HANDLE_VALUE) {
    return false;
  }
  const bool first_is_default =
      CompareStringOrdinal(data.cStreamName, -1, L"::$DATA", -1, FALSE) == CSTR_EQUAL;
  WIN32_FIND_STREAM_DATA second{};
  SetLastError(NO_ERROR);
  const BOOL has_second = FindNextStreamW(find, &second);
  const DWORD next_error = GetLastError();
  const BOOL closed = FindClose(find);
  return first_is_default && has_second == FALSE && next_error == ERROR_HANDLE_EOF &&
         closed != FALSE;
}

bool HashHeldFile(
    HANDLE handle,
    std::uint64_t expected_size,
    Byte32* digest) noexcept {
  if (handle == nullptr || handle == INVALID_HANDLE_VALUE || digest == nullptr ||
      expected_size > kMaximumProtectedExecutableBytes) {
    return false;
  }
  LARGE_INTEGER zero{};
  if (SetFilePointerEx(handle, zero, nullptr, FILE_BEGIN) == FALSE) {
    return false;
  }
  Sha256Hasher hash;
  if (!hash.Open()) {
    return false;
  }
  std::array<std::uint8_t, 64U * 1024U> buffer{};
  std::uint64_t remaining = expected_size;
  while (remaining != 0U) {
    const DWORD requested = remaining > buffer.size()
                                ? static_cast<DWORD>(buffer.size())
                                : static_cast<DWORD>(remaining);
    DWORD received = 0U;
    if (ReadFile(handle, buffer.data(), requested, &received, nullptr) == FALSE ||
        received == 0U || received > requested || !hash.Update(buffer.data(), received)) {
      SecureZeroMemory(buffer.data(), buffer.size());
      return false;
    }
    remaining -= received;
  }
  std::uint8_t trailing = 0U;
  DWORD received = 0U;
  if (ReadFile(handle, &trailing, 1U, &received, nullptr) == FALSE || received != 0U) {
    SecureZeroMemory(buffer.data(), buffer.size());
    return false;
  }
  SecureZeroMemory(buffer.data(), buffer.size());
  return hash.Finish(digest);
}

bool OpenProtectedExecutable(
    const FixedPath& path,
    HANDLE* output,
    FILE_ID_INFO* identity,
    ImageProjection* projection) noexcept {
  if (output == nullptr || identity == nullptr || projection == nullptr ||
      path.length == 0U) {
    return false;
  }
  ScopedHandle handle(CreateFileW(
      path.value.data(),
      GENERIC_READ | READ_CONTROL | SYNCHRONIZE,
      FILE_SHARE_READ,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr));
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  FILE_STANDARD_INFO standard{};
  if (handle.get() == INVALID_HANDLE_VALUE ||
      GetFileInformationByHandleEx(
          handle.get(),
          FileAttributeTagInfo,
          &attributes,
          static_cast<DWORD>(sizeof(attributes))) == FALSE ||
      GetFileInformationByHandleEx(
          handle.get(),
          FileStandardInfo,
          &standard,
          static_cast<DWORD>(sizeof(standard))) == FALSE ||
      (attributes.FileAttributes &
       (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT |
        FILE_ATTRIBUTE_SPARSE_FILE | FILE_ATTRIBUTE_COMPRESSED |
        FILE_ATTRIBUTE_ENCRYPTED | FILE_ATTRIBUTE_OFFLINE |
        FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS | FILE_ATTRIBUTE_RECALL_ON_OPEN |
        FILE_ATTRIBUTE_DEVICE)) != 0U ||
      attributes.ReparseTag != 0U || standard.Directory != FALSE ||
      standard.NumberOfLinks != 1U || standard.EndOfFile.QuadPart < 0 ||
      !QueryFileId(handle.get(), identity) ||
      !ValidateExactProtectedDacl(handle.get()) ||
      !ValidateOnlyUnnamedDataStream(path)) {
    return false;
  }
  FixedPath final_path{};
  if (!QueryFinalPath(handle.get(), &final_path) ||
      !EqualOrdinalPath(final_path.value.data(), path.value.data())) {
    return false;
  }
  projection->volume_serial_number = identity->VolumeSerialNumber;
  std::memcpy(
      projection->file_id.data(), identity->FileId.Identifier, projection->file_id.size());
  projection->file_size = static_cast<std::uint64_t>(standard.EndOfFile.QuadPart);
  if (!HashHeldFile(handle.get(), projection->file_size, &projection->sha256)) {
    return false;
  }
  *output = handle.Release();
  return true;
}

void CloseLayout(HeldLayout* layout) noexcept {
  if (layout == nullptr) {
    return;
  }
  HANDLE* handles[] = {
      &layout->client_image,
      &layout->service_image,
      &layout->bin,
      &layout->provisioner_root,
      &layout->goatcitadel,
      &layout->program_data,
      &layout->volume_root,
      &layout->system_root,
  };
  for (HANDLE* handle : handles) {
    if (*handle != nullptr && *handle != INVALID_HANDLE_VALUE) {
      CloseHandle(*handle);
    }
    *handle = nullptr;
  }
}

bool ResolveSystemVolume(HeldLayout* layout) noexcept {
  if (layout == nullptr) {
    return false;
  }
  ScopedHandle system_root(CreateFileW(
      kSystemRootObjectPath,
      FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
      FILE_SHARE_READ,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
      nullptr));
  FixedPath resolved_system_root{};
  if (system_root.get() == INVALID_HANDLE_VALUE ||
      !IsDirectoryHandle(system_root.get(), false) ||
      !QueryFileId(system_root.get(), &layout->system_root_id) ||
      !QueryFinalPath(system_root.get(), &resolved_system_root) ||
      resolved_system_root.length < 7U || resolved_system_root.value[0] != L'\\' ||
      resolved_system_root.value[1] != L'\\' || resolved_system_root.value[2] != L'?' ||
      resolved_system_root.value[3] != L'\\' || resolved_system_root.value[5] != L':' ||
      resolved_system_root.value[6] != L'\\') {
    return false;
  }
  wchar_t drive = resolved_system_root.value[4];
  if (drive >= L'a' && drive <= L'z') {
    drive = static_cast<wchar_t>(drive - L'a' + L'A');
  }
  if (drive < L'A' || drive > L'Z') {
    return false;
  }
  layout->extended_volume_root.value = {};
  layout->extended_volume_root.value[0] = L'\\';
  layout->extended_volume_root.value[1] = L'\\';
  layout->extended_volume_root.value[2] = L'?';
  layout->extended_volume_root.value[3] = L'\\';
  layout->extended_volume_root.value[4] = drive;
  layout->extended_volume_root.value[5] = L':';
  layout->extended_volume_root.value[6] = L'\\';
  layout->extended_volume_root.length = 7U;
  layout->dos_volume_root.value = {};
  layout->dos_volume_root.value[0] = drive;
  layout->dos_volume_root.value[1] = L':';
  layout->dos_volume_root.value[2] = L'\\';
  layout->dos_volume_root.length = 3U;

  ScopedHandle volume(CreateFileW(
      layout->extended_volume_root.value.data(),
      FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
      FILE_SHARE_READ,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
      nullptr));
  if (volume.get() == INVALID_HANDLE_VALUE || !IsDirectoryHandle(volume.get(), false) ||
      !QueryFileId(volume.get(), &layout->volume_root_id) ||
      layout->volume_root_id.VolumeSerialNumber !=
          layout->system_root_id.VolumeSerialNumber ||
      !ValidateAncestorDacl(volume.get(), false)) {
    return false;
  }
  layout->system_root = system_root.Release();
  layout->volume_root = volume.Release();
  return true;
}

bool ComposeProtectedExecutablePaths(HeldLayout* layout) noexcept {
  if (layout == nullptr ||
      !CopyPath(layout->extended_volume_root, &layout->service_path_extended) ||
      !CopyPath(layout->dos_volume_root, &layout->service_path_dos) ||
      !AppendComponent(&layout->service_path_extended, kProgramDataComponent) ||
      !AppendComponent(&layout->service_path_extended, kGoatCitadelComponent) ||
      !AppendComponent(&layout->service_path_extended, kProvisionerRootComponent) ||
      !AppendComponent(&layout->service_path_extended, kBinComponent) ||
      !AppendComponent(&layout->service_path_extended, kServiceExecutableName) ||
      !AppendComponent(&layout->service_path_dos, kProgramDataComponent) ||
      !AppendComponent(&layout->service_path_dos, kGoatCitadelComponent) ||
      !AppendComponent(&layout->service_path_dos, kProvisionerRootComponent) ||
      !AppendComponent(&layout->service_path_dos, kBinComponent) ||
      !AppendComponent(&layout->service_path_dos, kServiceExecutableName) ||
      !CopyPath(layout->extended_volume_root, &layout->client_path_extended) ||
      !CopyPath(layout->dos_volume_root, &layout->client_path_dos) ||
      !AppendComponent(&layout->client_path_extended, kProgramDataComponent) ||
      !AppendComponent(&layout->client_path_extended, kGoatCitadelComponent) ||
      !AppendComponent(&layout->client_path_extended, kProvisionerRootComponent) ||
      !AppendComponent(&layout->client_path_extended, kBinComponent) ||
      !AppendComponent(&layout->client_path_extended, kClientExecutableName) ||
      !AppendComponent(&layout->client_path_dos, kProgramDataComponent) ||
      !AppendComponent(&layout->client_path_dos, kGoatCitadelComponent) ||
      !AppendComponent(&layout->client_path_dos, kProvisionerRootComponent) ||
      !AppendComponent(&layout->client_path_dos, kBinComponent) ||
      !AppendComponent(&layout->client_path_dos, kClientExecutableName)) {
    return false;
  }
  return true;
}

bool CompleteProtectedLayout(HeldLayout* layout) noexcept {
  if (layout == nullptr || layout->system_root == nullptr ||
      layout->volume_root == nullptr || !ComposeProtectedExecutablePaths(layout)) {
    return false;
  }
  FixedPath path{};
  if (!CopyPath(layout->extended_volume_root, &path) ||
      !AppendComponent(&path, kProgramDataComponent) ||
      !OpenDirectory(path, &layout->program_data, &layout->program_data_id) ||
      layout->program_data_id.VolumeSerialNumber !=
          layout->volume_root_id.VolumeSerialNumber ||
      !ValidateAncestorDacl(layout->program_data, false) ||
      !AppendComponent(&path, kGoatCitadelComponent) ||
      !OpenDirectory(path, &layout->goatcitadel, &layout->goatcitadel_id) ||
      layout->goatcitadel_id.VolumeSerialNumber !=
          layout->volume_root_id.VolumeSerialNumber ||
      !ValidateAncestorDacl(layout->goatcitadel, true) ||
      !AppendComponent(&path, kProvisionerRootComponent) ||
      !OpenDirectory(path, &layout->provisioner_root, &layout->provisioner_root_id) ||
      layout->provisioner_root_id.VolumeSerialNumber !=
          layout->volume_root_id.VolumeSerialNumber ||
      !ValidateExactProtectedDacl(layout->provisioner_root) ||
      !AppendComponent(&path, kBinComponent) ||
      !OpenDirectory(path, &layout->bin, &layout->bin_id) ||
      layout->bin_id.VolumeSerialNumber != layout->volume_root_id.VolumeSerialNumber ||
      !ValidateExactProtectedDacl(layout->bin) ||
      !OpenProtectedExecutable(
          layout->service_path_extended,
          &layout->service_image,
          &layout->service_image_id,
          &layout->service_projection) ||
      !OpenProtectedExecutable(
          layout->client_path_extended,
          &layout->client_image,
          &layout->client_image_id,
          &layout->client_projection) ||
      layout->service_image_id.VolumeSerialNumber !=
          layout->volume_root_id.VolumeSerialNumber ||
      layout->client_image_id.VolumeSerialNumber !=
          layout->volume_root_id.VolumeSerialNumber) {
    return false;
  }
  return true;
}

bool RevalidateHeldLayout(const HeldLayout& layout) noexcept {
  const std::array<std::pair<HANDLE, const FILE_ID_INFO*>, 8U> held = {{
      {layout.system_root, &layout.system_root_id},
      {layout.volume_root, &layout.volume_root_id},
      {layout.program_data, &layout.program_data_id},
      {layout.goatcitadel, &layout.goatcitadel_id},
      {layout.provisioner_root, &layout.provisioner_root_id},
      {layout.bin, &layout.bin_id},
      {layout.service_image, &layout.service_image_id},
      {layout.client_image, &layout.client_image_id},
  }};
  for (const auto& item : held) {
    FILE_ID_INFO current{};
    if (!QueryFileId(item.first, &current) || !SameFileId(current, *item.second)) {
      return false;
    }
  }
  return true;
}

ServiceStateInternal* InternalState(ServiceTransportState* state) noexcept {
  if (state == nullptr) {
    return nullptr;
  }
  auto* internal = reinterpret_cast<ServiceStateInternal*>(state->storage.data());
  return internal->magic == kServiceStateMagic ? internal : nullptr;
}

void CloseProcessEvidence(ProcessEvidence* evidence) noexcept {
  if (evidence == nullptr) {
    return;
  }
  if (evidence->token != nullptr && evidence->token != INVALID_HANDLE_VALUE) {
    CloseHandle(evidence->token);
  }
  if (evidence->process != nullptr && evidence->process != INVALID_HANDLE_VALUE) {
    CloseHandle(evidence->process);
  }
  evidence->token = nullptr;
  evidence->process = nullptr;
}

}  // namespace

ServiceTransportResult ResolveProtectedServiceBinaryPath(
    ServiceTransportState* state,
    wchar_t* quoted_path,
    std::size_t quoted_path_capacity,
    std::size_t* quoted_path_length) noexcept {
  if (state == nullptr || quoted_path == nullptr || quoted_path_length == nullptr ||
      quoted_path_capacity < 4U) {
    return ServiceTransportResult::ProtectedImage;
  }
  if (CloseServiceTransport(state) != ServiceTransportResult::Success) {
    return ServiceTransportResult::CancellationOrReversion;
  }
  auto* internal = new (state->storage.data()) ServiceStateInternal{};
  if (!ResolveSystemVolume(&internal->layout) ||
      !ComposeProtectedExecutablePaths(&internal->layout)) {
    return CloseServiceTransport(state) == ServiceTransportResult::Success
               ? ServiceTransportResult::ProtectedImage
               : ServiceTransportResult::CancellationOrReversion;
  }
  const FixedPath& path = internal->layout.service_path_dos;
  if (path.length + 3U > quoted_path_capacity) {
    return CloseServiceTransport(state) == ServiceTransportResult::Success
               ? ServiceTransportResult::ProtectedImage
               : ServiceTransportResult::CancellationOrReversion;
  }
  quoted_path[0] = L'"';
  std::memcpy(
      quoted_path + 1U, path.value.data(), path.length * sizeof(wchar_t));
  quoted_path[path.length + 1U] = L'"';
  quoted_path[path.length + 2U] = L'\0';
  *quoted_path_length = path.length + 2U;
  return ServiceTransportResult::Success;
}

namespace {

bool CopySidProjection(PSID sid, SidProjection* output) noexcept {
  if (sid == nullptr || output == nullptr || IsValidSid(sid) == FALSE) {
    return false;
  }
  const DWORD length = GetLengthSid(sid);
  if (length == 0U || length > output->bytes.size()) {
    return false;
  }
  *output = SidProjection{};
  output->length = static_cast<std::uint16_t>(length);
  std::memcpy(output->bytes.data(), sid, length);
  return GetLengthSid(output->bytes.data()) == output->length;
}

bool QueryTokenInformationFixed(
    HANDLE token,
    TOKEN_INFORMATION_CLASS information_class,
    std::uint8_t* buffer,
    std::size_t capacity,
    DWORD minimum_size,
    DWORD* returned_size) noexcept {
  if (token == nullptr || token == INVALID_HANDLE_VALUE || buffer == nullptr ||
      returned_size == nullptr || capacity > MAXDWORD) {
    return false;
  }
  DWORD required = 0U;
  SecureZeroMemory(buffer, capacity);
  if (GetTokenInformation(
          token,
          information_class,
          buffer,
          static_cast<DWORD>(capacity),
          &required) == FALSE ||
      required < minimum_size || required > capacity) {
    return false;
  }
  *returned_size = required;
  return true;
}

bool IsSidPointerInside(
    PSID sid,
    const std::uint8_t* buffer,
    std::size_t buffer_size) noexcept {
  if (sid == nullptr || buffer == nullptr || IsValidSid(sid) == FALSE) {
    return false;
  }
  const std::uintptr_t start = reinterpret_cast<std::uintptr_t>(buffer);
  const std::uintptr_t end = start + buffer_size;
  const std::uintptr_t address = reinterpret_cast<std::uintptr_t>(sid);
  const DWORD sid_length = GetLengthSid(sid);
  return end >= start && address >= start && address <= end &&
         sid_length <= end - address;
}

bool QueryTokenScalar(
    HANDLE token,
    TOKEN_INFORMATION_CLASS information_class,
    void* output,
    DWORD output_size) noexcept {
  if (output == nullptr || output_size == 0U) {
    return false;
  }
  DWORD returned = 0U;
  return GetTokenInformation(
             token, information_class, output, output_size, &returned) != FALSE &&
         returned == output_size;
}

bool CaptureClientTokenProjection(
    HANDLE token,
    TOKEN_TYPE required_type,
    SECURITY_IMPERSONATION_LEVEL required_level,
    bool require_non_appcontainer,
    TokenProjection* output) noexcept {
  if (token == nullptr || token == INVALID_HANDLE_VALUE || output == nullptr) {
    return false;
  }
  TOKEN_TYPE type = TokenPrimary;
  if (!QueryTokenScalar(token, TokenType, &type, sizeof(type)) ||
      type != required_type) {
    return false;
  }
  if (required_type == TokenImpersonation) {
    SECURITY_IMPERSONATION_LEVEL level = SecurityAnonymous;
    if (!QueryTokenScalar(
            token, TokenImpersonationLevel, &level, sizeof(level)) ||
        level != required_level) {
      return false;
    }
  }
  if (IsTokenRestricted(token) != FALSE) {
    return false;
  }
  DWORD is_appcontainer = 0U;
  if (require_non_appcontainer &&
      (!QueryTokenScalar(
           token, TokenIsAppContainer, &is_appcontainer, sizeof(is_appcontainer)) ||
       is_appcontainer != 0U)) {
    return false;
  }

  alignas(16) std::array<std::uint8_t, kMaximumTokenQueryBytes> buffer{};
  DWORD returned = 0U;
  if (!QueryTokenInformationFixed(
          token,
          TokenUser,
          buffer.data(),
          buffer.size(),
          sizeof(TOKEN_USER),
          &returned)) {
    return false;
  }
  const auto* token_user = reinterpret_cast<const TOKEN_USER*>(buffer.data());
  if (!IsSidPointerInside(token_user->User.Sid, buffer.data(), returned)) {
    return false;
  }
  TokenProjection projection{};
  if (!CopySidProjection(token_user->User.Sid, &projection.user)) {
    return false;
  }

  if (!QueryTokenInformationFixed(
          token,
          TokenGroups,
          buffer.data(),
          buffer.size(),
          sizeof(TOKEN_GROUPS),
          &returned)) {
    return false;
  }
  const auto* groups = reinterpret_cast<const TOKEN_GROUPS*>(buffer.data());
  const std::size_t groups_header = offsetof(TOKEN_GROUPS, Groups);
  if (groups->GroupCount >
      (returned - groups_header) / sizeof(SID_AND_ATTRIBUTES)) {
    return false;
  }
  SidBuffer administrators{};
  if (!MakeAdministratorsSid(&administrators)) {
    return false;
  }
  std::size_t logon_count = 0U;
  std::size_t administrators_count = 0U;
  for (DWORD index = 0U; index < groups->GroupCount; ++index) {
    const SID_AND_ATTRIBUTES& group = groups->Groups[index];
    if (!IsSidPointerInside(group.Sid, buffer.data(), returned)) {
      return false;
    }
    if ((group.Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID) {
      ++logon_count;
      if ((group.Attributes & SE_GROUP_ENABLED) == 0U ||
          (group.Attributes & SE_GROUP_USE_FOR_DENY_ONLY) != 0U ||
          !CopySidProjection(group.Sid, &projection.logon)) {
        return false;
      }
      projection.logon_sid_attributes = group.Attributes;
    }
    if (EqualSidBytes(group.Sid, administrators.bytes.data())) {
      ++administrators_count;
      if ((group.Attributes & SE_GROUP_ENABLED) == 0U ||
          (group.Attributes & SE_GROUP_USE_FOR_DENY_ONLY) != 0U) {
        return false;
      }
      projection.administrators_sid_attributes = group.Attributes;
    }
  }
  if (logon_count != 1U || administrators_count != 1U) {
    return false;
  }

  TOKEN_STATISTICS statistics{};
  DWORD session_id = UINT32_MAX;
  TOKEN_ELEVATION_TYPE elevation = TokenElevationTypeDefault;
  if (!QueryTokenScalar(
          token, TokenStatistics, &statistics, sizeof(statistics)) ||
      !QueryTokenScalar(token, TokenSessionId, &session_id, sizeof(session_id)) ||
      !QueryTokenScalar(
          token, TokenElevationType, &elevation, sizeof(elevation)) ||
      elevation != TokenElevationTypeFull) {
    return false;
  }
  projection.authentication_id_low = statistics.AuthenticationId.LowPart;
  projection.authentication_id_high = statistics.AuthenticationId.HighPart;
  projection.session_id = session_id;
  projection.elevation_type = static_cast<std::uint32_t>(elevation);

  if (!QueryTokenInformationFixed(
          token,
          TokenIntegrityLevel,
          buffer.data(),
          buffer.size(),
          sizeof(TOKEN_MANDATORY_LABEL),
          &returned)) {
    return false;
  }
  const auto* integrity =
      reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(buffer.data());
  if (!IsSidPointerInside(integrity->Label.Sid, buffer.data(), returned)) {
    return false;
  }
  const UCHAR subauthority_count = *GetSidSubAuthorityCount(integrity->Label.Sid);
  if (subauthority_count == 0U) {
    return false;
  }
  projection.integrity_rid =
      *GetSidSubAuthority(integrity->Label.Sid, subauthority_count - 1U);
  if (projection.integrity_rid != SECURITY_MANDATORY_HIGH_RID) {
    return false;
  }

  if (!QueryTokenInformationFixed(
          token,
          TokenRestrictedSids,
          buffer.data(),
          buffer.size(),
          sizeof(TOKEN_GROUPS),
          &returned)) {
    return false;
  }
  const auto* restricted = reinterpret_cast<const TOKEN_GROUPS*>(buffer.data());
  if (restricted->GroupCount != 0U) {
    return false;
  }
  projection.has_restricted_sids = false;
  *output = projection;
  return true;
}

bool TokenProjectionsEqual(
    const TokenProjection& left,
    const TokenProjection& right) noexcept {
  return left.user.length == right.user.length &&
         left.logon.length == right.logon.length &&
         BytesEqual(left.user.bytes.data(), right.user.bytes.data(), left.user.length) &&
         BytesEqual(left.logon.bytes.data(), right.logon.bytes.data(), left.logon.length) &&
         left.logon_sid_attributes == right.logon_sid_attributes &&
         left.authentication_id_low == right.authentication_id_low &&
         left.authentication_id_high == right.authentication_id_high &&
         left.session_id == right.session_id &&
         left.elevation_type == right.elevation_type &&
         left.integrity_rid == right.integrity_rid &&
         left.administrators_sid_attributes ==
             right.administrators_sid_attributes &&
         left.has_restricted_sids == right.has_restricted_sids;
}

bool QueryProcessCreationTime(
    HANDLE process,
    std::uint64_t* creation_file_time) noexcept {
  if (process == nullptr || process == INVALID_HANDLE_VALUE ||
      creation_file_time == nullptr) {
    return false;
  }
  FILETIME creation{};
  FILETIME exit{};
  FILETIME kernel{};
  FILETIME user{};
  if (GetProcessTimes(process, &creation, &exit, &kernel, &user) == FALSE) {
    return false;
  }
  *creation_file_time =
      (static_cast<std::uint64_t>(creation.dwHighDateTime) << 32U) |
      static_cast<std::uint64_t>(creation.dwLowDateTime);
  return *creation_file_time != 0U;
}

bool QueryProcessPath(HANDLE process, FixedPath* path) noexcept {
  if (process == nullptr || process == INVALID_HANDLE_VALUE || path == nullptr) {
    return false;
  }
  path->value.fill(L'\0');
  DWORD length = static_cast<DWORD>(path->value.size());
  if (QueryFullProcessImageNameW(
          process, 0U, path->value.data(), &length) == FALSE ||
      length == 0U || length >= path->value.size()) {
    return false;
  }
  path->length = length;
  path->value[path->length] = L'\0';
  return true;
}

bool IsProcessAlive(HANDLE process) noexcept {
  return process != nullptr && process != INVALID_HANDLE_VALUE &&
         WaitForSingleObject(process, 0U) == WAIT_TIMEOUT;
}

bool CaptureClientProcessEvidence(
    HANDLE process,
    std::uint32_t pid,
    const FixedPath& expected_path,
    ProcessEvidence* output) noexcept {
  if (process == nullptr || process == INVALID_HANDLE_VALUE || pid == 0U ||
      output == nullptr || !IsProcessAlive(process)) {
    return false;
  }
  FixedPath before{};
  FixedPath after{};
  std::uint64_t creation = 0U;
  ScopedHandle token;
  HANDLE raw_token = nullptr;
  if (!QueryProcessPath(process, &before) ||
      !EqualOrdinalPath(before.value.data(), expected_path.value.data()) ||
      !QueryProcessCreationTime(process, &creation) ||
      OpenProcessToken(process, TOKEN_QUERY, &raw_token) == FALSE) {
    return false;
  }
  token.Reset(raw_token);
  TokenProjection projection{};
  if (!CaptureClientTokenProjection(
          token.get(),
          TokenPrimary,
          SecurityAnonymous,
          true,
          &projection) ||
      !QueryProcessPath(process, &after) ||
      !EqualOrdinalPath(before.value.data(), after.value.data()) ||
      !EqualOrdinalPath(after.value.data(), expected_path.value.data()) ||
      !IsProcessAlive(process)) {
    return false;
  }
  output->process = process;
  output->token = token.Release();
  output->pid = pid;
  output->creation_file_time = creation;
  output->token_projection = projection;
  return true;
}

bool ValidateServiceProcessToken(HANDLE token) noexcept {
  if (token == nullptr || token == INVALID_HANDLE_VALUE ||
      IsTokenRestricted(token) != FALSE) {
    return false;
  }
  TOKEN_TYPE type = TokenImpersonation;
  DWORD session_id = UINT32_MAX;
  DWORD is_appcontainer = 1U;
  if (!QueryTokenScalar(token, TokenType, &type, sizeof(type)) ||
      type != TokenPrimary ||
      !QueryTokenScalar(token, TokenSessionId, &session_id, sizeof(session_id)) ||
      session_id != 0U ||
      !QueryTokenScalar(
          token, TokenIsAppContainer, &is_appcontainer, sizeof(is_appcontainer)) ||
      is_appcontainer != 0U) {
    return false;
  }
  alignas(16) std::array<std::uint8_t, kMaximumTokenQueryBytes> buffer{};
  DWORD returned = 0U;
  SidBuffer system{};
  SidBuffer service{};
  if (!MakeLocalSystemSid(&system) || !MakeProvisionerServiceSid(&service) ||
      !QueryTokenInformationFixed(
          token,
          TokenUser,
          buffer.data(),
          buffer.size(),
          sizeof(TOKEN_USER),
          &returned)) {
    return false;
  }
  const auto* user = reinterpret_cast<const TOKEN_USER*>(buffer.data());
  if (!IsSidPointerInside(user->User.Sid, buffer.data(), returned) ||
      !EqualSidBytes(user->User.Sid, system.bytes.data())) {
    return false;
  }
  if (!QueryTokenInformationFixed(
          token,
          TokenGroups,
          buffer.data(),
          buffer.size(),
          sizeof(TOKEN_GROUPS),
          &returned)) {
    return false;
  }
  const auto* groups = reinterpret_cast<const TOKEN_GROUPS*>(buffer.data());
  const std::size_t groups_header = offsetof(TOKEN_GROUPS, Groups);
  if (groups->GroupCount >
      (returned - groups_header) / sizeof(SID_AND_ATTRIBUTES)) {
    return false;
  }
  std::size_t service_count = 0U;
  for (DWORD index = 0U; index < groups->GroupCount; ++index) {
    const SID_AND_ATTRIBUTES& group = groups->Groups[index];
    if (!IsSidPointerInside(group.Sid, buffer.data(), returned)) {
      return false;
    }
    if (EqualSidBytes(group.Sid, service.bytes.data())) {
      ++service_count;
      if ((group.Attributes & (SE_GROUP_ENABLED | SE_GROUP_OWNER)) !=
              (SE_GROUP_ENABLED | SE_GROUP_OWNER) ||
          (group.Attributes & SE_GROUP_USE_FOR_DENY_ONLY) != 0U) {
        return false;
      }
    }
  }
  return service_count == 1U;
}

bool CaptureServiceProcessEvidence(
    HANDLE process,
    std::uint32_t pid,
    const FixedPath& expected_path,
    ProcessEvidence* output) noexcept {
  if (process == nullptr || process == INVALID_HANDLE_VALUE || pid == 0U ||
      output == nullptr || !IsProcessAlive(process)) {
    return false;
  }
  FixedPath before{};
  FixedPath after{};
  std::uint64_t creation = 0U;
  ScopedHandle token;
  HANDLE raw_token = nullptr;
  if (!QueryProcessPath(process, &before) ||
      !EqualOrdinalPath(before.value.data(), expected_path.value.data()) ||
      !QueryProcessCreationTime(process, &creation) ||
      OpenProcessToken(process, TOKEN_QUERY, &raw_token) == FALSE) {
    return false;
  }
  token.Reset(raw_token);
  if (!ValidateServiceProcessToken(token.get()) ||
      !QueryProcessPath(process, &after) ||
      !EqualOrdinalPath(before.value.data(), after.value.data()) ||
      !EqualOrdinalPath(after.value.data(), expected_path.value.data()) ||
      !IsProcessAlive(process)) {
    return false;
  }
  output->process = process;
  output->token = token.Release();
  output->pid = pid;
  output->creation_file_time = creation;
  return true;
}

bool IsExactLocalSystemAccount(const wchar_t* value) noexcept {
  return value != nullptr &&
         CompareStringOrdinal(value, -1, L"LocalSystem", -1, FALSE) == CSTR_EQUAL;
}

bool WideRangeInsideBuffer(
    const wchar_t* value,
    const std::uint8_t* buffer,
    std::size_t buffer_bytes,
    std::size_t characters) noexcept {
  if (value == nullptr || buffer == nullptr ||
      characters > std::numeric_limits<std::size_t>::max() / sizeof(wchar_t)) {
    return false;
  }
  const std::uintptr_t start = reinterpret_cast<std::uintptr_t>(buffer);
  const std::uintptr_t end = start + buffer_bytes;
  const std::uintptr_t address = reinterpret_cast<std::uintptr_t>(value);
  const std::size_t required = characters * sizeof(wchar_t);
  return end >= start && address >= start && address <= end &&
         required <= end - address;
}

bool IsExactQuotedPath(const wchar_t* value, const FixedPath& path) noexcept {
  if (value == nullptr || value[0] != L'"') {
    return false;
  }
  for (std::size_t index = 0U; index < path.length; ++index) {
    if (value[index + 1U] != path.value[index]) {
      return false;
    }
  }
  return value[path.length + 1U] == L'"' &&
         value[path.length + 2U] == L'\0';
}

bool QueryExactService(
    SC_HANDLE service,
    const FixedPath& service_path,
    std::uint32_t* pid) noexcept {
  if (service == nullptr || pid == nullptr) {
    return false;
  }
  SERVICE_STATUS_PROCESS status{};
  DWORD returned = 0U;
  if (QueryServiceStatusEx(
          service,
          SC_STATUS_PROCESS_INFO,
          reinterpret_cast<LPBYTE>(&status),
          sizeof(status),
          &returned) == FALSE ||
      returned != sizeof(status) || status.dwServiceType != SERVICE_WIN32_OWN_PROCESS ||
      status.dwCurrentState != SERVICE_RUNNING || status.dwProcessId == 0U ||
      status.dwServiceFlags != 0U) {
    return false;
  }
  alignas(16) std::array<std::uint8_t, 8192U> config_buffer{};
  DWORD required = 0U;
  if (QueryServiceConfigW(
          service,
          reinterpret_cast<QUERY_SERVICE_CONFIGW*>(config_buffer.data()),
          static_cast<DWORD>(config_buffer.size()),
          &required) == FALSE ||
      required < sizeof(QUERY_SERVICE_CONFIGW) || required > config_buffer.size()) {
    return false;
  }
  const auto* config =
      reinterpret_cast<const QUERY_SERVICE_CONFIGW*>(config_buffer.data());
  constexpr std::size_t kLocalSystemCharacters = 12U;
  if (!WideRangeInsideBuffer(
          config->lpBinaryPathName,
          config_buffer.data(),
          required,
          service_path.length + 3U) ||
      !WideRangeInsideBuffer(
          config->lpServiceStartName,
          config_buffer.data(),
          required,
          kLocalSystemCharacters) ||
      (config->lpLoadOrderGroup != nullptr &&
       !WideRangeInsideBuffer(
           config->lpLoadOrderGroup, config_buffer.data(), required, 1U)) ||
      (config->lpDependencies != nullptr &&
       !WideRangeInsideBuffer(
           config->lpDependencies, config_buffer.data(), required, 1U))) {
    return false;
  }
  if (config->dwServiceType != SERVICE_WIN32_OWN_PROCESS ||
      config->dwStartType != SERVICE_DEMAND_START ||
      config->dwErrorControl != SERVICE_ERROR_NORMAL ||
      !IsExactQuotedPath(config->lpBinaryPathName, service_path) ||
      !IsExactLocalSystemAccount(config->lpServiceStartName) ||
      (config->lpLoadOrderGroup != nullptr && config->lpLoadOrderGroup[0] != L'\0') ||
      (config->lpDependencies != nullptr && config->lpDependencies[0] != L'\0')) {
    return false;
  }
  *pid = status.dwProcessId;
  return true;
}

bool AuthenticateServerBeforeHello(
    HANDLE pipe,
    HeldLayout* layout,
    ProcessEvidence* server,
    ProcessEvidence* client) noexcept {
  if (pipe == nullptr || pipe == INVALID_HANDLE_VALUE || layout == nullptr ||
      server == nullptr || client == nullptr || !RevalidateHeldLayout(*layout)) {
    return false;
  }
  ULONG pipe_server_pid = 0U;
  if (GetNamedPipeServerProcessId(pipe, &pipe_server_pid) == FALSE ||
      pipe_server_pid == 0U) {
    return false;
  }
  ScopedServiceHandle scm(OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT));
  if (scm.get() == nullptr) {
    return false;
  }
  ScopedServiceHandle service_handle(OpenServiceW(
      scm.get(),
      kProvisionerTransportServiceName,
      SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS | READ_CONTROL));
  std::uint32_t first_pid = 0U;
  if (service_handle.get() == nullptr ||
      !QueryExactService(service_handle.get(), layout->service_path_dos, &first_pid) ||
      first_pid != pipe_server_pid) {
    return false;
  }
  ScopedHandle process(OpenProcess(
      PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
      FALSE,
      first_pid));
  ProcessEvidence service_evidence{};
  if (process.get() == nullptr ||
      !CaptureServiceProcessEvidence(
          process.get(), first_pid, layout->service_path_dos, &service_evidence)) {
    return false;
  }
  process.Release();
  std::uint32_t second_pid = 0U;
  std::uint64_t second_creation = 0U;
  if (!QueryExactService(
          service_handle.get(), layout->service_path_dos, &second_pid) ||
      second_pid != first_pid ||
      !QueryProcessCreationTime(service_evidence.process, &second_creation) ||
      second_creation != service_evidence.creation_file_time ||
      !IsProcessAlive(service_evidence.process)) {
    CloseProcessEvidence(&service_evidence);
    return false;
  }

  ProcessEvidence client_evidence{};
  if (!CaptureClientProcessEvidence(
          GetCurrentProcess(),
          GetCurrentProcessId(),
          layout->client_path_dos,
          &client_evidence)) {
    CloseProcessEvidence(&service_evidence);
    return false;
  }
  client_evidence.process = nullptr;
  if (!RevalidateHeldLayout(*layout)) {
    CloseProcessEvidence(&service_evidence);
    CloseProcessEvidence(&client_evidence);
    return false;
  }
  *server = service_evidence;
  *client = client_evidence;
  return true;
}

bool RevertAndProveNoThreadToken() noexcept {
  if (RevertToSelf() == FALSE) {
    return false;
  }
  HANDLE ambient = nullptr;
  SetLastError(NO_ERROR);
  if (OpenThreadToken(
          GetCurrentThread(), TOKEN_QUERY, FALSE, &ambient) != FALSE) {
    CloseHandle(ambient);
    return false;
  }
  return GetLastError() == ERROR_NO_TOKEN;
}

bool ValidateInteractiveLogon(const TokenProjection& projection) noexcept {
#if defined(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX)
  LUID authentication_id{};
  authentication_id.LowPart = projection.authentication_id_low;
  authentication_id.HighPart = projection.authentication_id_high;
  PSECURITY_LOGON_SESSION_DATA data = nullptr;
  const NTSTATUS status = LsaGetLogonSessionData(&authentication_id, &data);
  if (status < 0 || data == nullptr) {
    if (data != nullptr) {
      LsaFreeReturnBuffer(data);
    }
    return false;
  }
  const bool valid_size =
      data->Size >= offsetof(SECURITY_LOGON_SESSION_DATA, Sid) + sizeof(data->Sid);
  const DWORD active_console_session = WTSGetActiveConsoleSessionId();
  const bool valid = valid_size &&
                     data->LogonId.LowPart == authentication_id.LowPart &&
                     data->LogonId.HighPart == authentication_id.HighPart &&
                     data->Sid != nullptr && IsValidSid(data->Sid) != FALSE &&
                     EqualSidBytes(
                         data->Sid,
                         const_cast<std::uint8_t*>(projection.user.bytes.data())) &&
                     active_console_session != UINT32_MAX &&
                     data->Session == projection.session_id &&
                     data->Session == active_console_session &&
                     data->LogonType == Interactive;
  const NTSTATUS free_status = LsaFreeReturnBuffer(data);
  return valid && free_status >= 0;
#else
  static_cast<void>(projection);
  return false;
#endif
}

enum class CallerAuthenticationResult : std::uint8_t {
  Success,
  AuthenticationFailure,
  ReversionFailure,
};

CallerAuthenticationResult AuthenticateClientAfterHello(
    ServiceStateInternal* state) noexcept {
  if (state == nullptr || state->pipe == nullptr || !state->images_validated ||
      !RevalidateHeldLayout(state->layout) ||
      !BytesEqual(
          state->layout.client_projection.sha256.data(),
          state->expected_client_sha256.data(),
          state->expected_client_sha256.size())) {
    return CallerAuthenticationResult::AuthenticationFailure;
  }
  ULONG client_pid = 0U;
  if (GetNamedPipeClientProcessId(state->pipe, &client_pid) == FALSE ||
      client_pid == 0U) {
    return CallerAuthenticationResult::AuthenticationFailure;
  }
  ScopedHandle process(OpenProcess(
      PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
      FALSE,
      client_pid));
  ProcessEvidence evidence{};
  if (process.get() == nullptr ||
      !CaptureClientProcessEvidence(
          process.get(), client_pid, state->layout.client_path_dos, &evidence)) {
    return CallerAuthenticationResult::AuthenticationFailure;
  }
  process.Release();

  if (ImpersonateNamedPipeClient(state->pipe) == FALSE) {
    CloseProcessEvidence(&evidence);
    return CallerAuthenticationResult::AuthenticationFailure;
  }
  HANDLE pipe_token = nullptr;
  TokenProjection pipe_projection{};
  const bool token_opened = OpenThreadToken(
      GetCurrentThread(), TOKEN_QUERY, FALSE, &pipe_token) != FALSE;
  bool captured = false;
  if (token_opened) {
    captured = CaptureClientTokenProjection(
        pipe_token,
        TokenImpersonation,
        SecurityIdentification,
        false,
        &pipe_projection);
    CloseHandle(pipe_token);
  }
  const bool reverted = RevertAndProveNoThreadToken();
  if (!reverted) {
    CloseProcessEvidence(&evidence);
    return CallerAuthenticationResult::ReversionFailure;
  }
  if (!captured || !TokenProjectionsEqual(evidence.token_projection, pipe_projection) ||
      !ValidateInteractiveLogon(pipe_projection) ||
      !RevalidateHeldLayout(state->layout) || !IsProcessAlive(evidence.process)) {
    CloseProcessEvidence(&evidence);
    return CallerAuthenticationResult::AuthenticationFailure;
  }
  state->client = evidence;
  state->pipe_identification = pipe_projection;
  return CallerAuthenticationResult::Success;
}

}  // namespace

ServiceTransportResult ValidateServiceTransportImages(
    const ServiceTransportContext& context,
    ServiceTransportState* state) noexcept {
  ServiceStateInternal* internal = InternalState(state);
  if (internal == nullptr || context.stop_event == nullptr ||
      context.stop_event == INVALID_HANDLE_VALUE || context.service_start_nonce == nullptr ||
      context.expected_client_sha256 == nullptr ||
      IsAllZero(context.service_start_nonce->data(), context.service_start_nonce->size()) ||
      IsAllZero(
          context.expected_client_sha256->data(),
          context.expected_client_sha256->size()) ||
      internal->images_validated || internal->pipe_armed ||
      WaitForSingleObject(context.stop_event, 0U) != WAIT_TIMEOUT) {
    return ServiceTransportResult::ProtectedImage;
  }
  internal->context = context;
  internal->service_start_nonce = *context.service_start_nonce;
  internal->expected_client_sha256 = *context.expected_client_sha256;
  if (!CompleteProtectedLayout(&internal->layout) ||
      !BytesEqual(
          internal->layout.client_projection.sha256.data(),
          internal->expected_client_sha256.data(),
          internal->expected_client_sha256.size())) {
    return ServiceTransportResult::ProtectedImage;
  }
  FixedPath first_process_path{};
  FixedPath second_process_path{};
  if (!QueryProcessPath(GetCurrentProcess(), &first_process_path) ||
      !EqualOrdinalPath(
          first_process_path.value.data(),
          internal->layout.service_path_dos.value.data()) ||
      !RevalidateHeldLayout(internal->layout) ||
      !QueryProcessPath(GetCurrentProcess(), &second_process_path) ||
      !EqualOrdinalPath(
          first_process_path.value.data(), second_process_path.value.data())) {
    return ServiceTransportResult::ProtectedImage;
  }
  internal->images_validated = true;
  return ServiceTransportResult::Success;
}

ServiceTransportResult RecoverProtectedServiceState(
    ServiceTransportState* state,
    std::uint64_t startup_deadline_ms) noexcept {
  ServiceStateInternal* internal = InternalState(state);
  if (internal == nullptr || !internal->images_validated || internal->pipe_armed ||
      internal->context.stop_event == nullptr ||
      internal->context.stop_event == INVALID_HANDLE_VALUE ||
      startup_deadline_ms == 0U || !RevalidateHeldLayout(internal->layout)) {
    return ServiceTransportResult::CustodyOrJournal;
  }
  const DWORD initial_stop =
      WaitForSingleObject(internal->context.stop_event, 0U);
  if (initial_stop == WAIT_OBJECT_0) {
    return ServiceTransportResult::CancellationOrReversion;
  }
  if (initial_stop != WAIT_TIMEOUT) {
    return ServiceTransportResult::CustodyOrJournal;
  }
  const std::uint64_t recovery_start = GetTickCount64();
  if (recovery_start >= startup_deadline_ms) {
    return ServiceTransportResult::Deadline;
  }
#if defined(GOATCITADEL_PROVISIONER_CUSTODY)
  const std::uint64_t bounded_recovery_deadline =
      recovery_start > UINT64_MAX - kProtectedRecoveryMilliseconds
          ? startup_deadline_ms
          : (startup_deadline_ms <
                     recovery_start + kProtectedRecoveryMilliseconds
                 ? startup_deadline_ms
                 : recovery_start + kProtectedRecoveryMilliseconds);
  if (internal->protected_recovery_verified ||
      !InitializeProtectedOperations(
          internal->layout.extended_volume_root.value.data(),
          internal->layout.extended_volume_root.length,
          &internal->protected_operations,
          bounded_recovery_deadline,
          internal->context.stop_event)) {
    CloseProtectedOperations(&internal->protected_operations);
    internal->protected_recovery_verified = false;
    return ServiceTransportResult::CustodyOrJournal;
  }
  const DWORD final_stop =
      WaitForSingleObject(internal->context.stop_event, 0U);
  if (final_stop == WAIT_OBJECT_0) {
    CloseProtectedOperations(&internal->protected_operations);
    return ServiceTransportResult::CancellationOrReversion;
  }
  const bool recovery_deadline_expired =
      GetTickCount64() >= bounded_recovery_deadline;
  const bool layout_valid = RevalidateHeldLayout(internal->layout);
  if (final_stop != WAIT_TIMEOUT || recovery_deadline_expired || !layout_valid) {
    CloseProtectedOperations(&internal->protected_operations);
    if (final_stop != WAIT_TIMEOUT || !layout_valid) {
      return ServiceTransportResult::CustodyOrJournal;
    }
    return ServiceTransportResult::Deadline;
  }
  internal->protected_recovery_verified = true;
#endif
  return ServiceTransportResult::Success;
}

namespace {

bool BuildPipeSecurityAttributes(
    SECURITY_ATTRIBUTES* attributes,
    SECURITY_DESCRIPTOR* descriptor,
    std::array<std::uint8_t, 512U>* acl_storage) noexcept {
  if (attributes == nullptr || descriptor == nullptr || acl_storage == nullptr) {
    return false;
  }
  SidBuffer system{};
  SidBuffer service{};
  SidBuffer administrators{};
  if (!MakeLocalSystemSid(&system) || !MakeProvisionerServiceSid(&service) ||
      !MakeAdministratorsSid(&administrators)) {
    return false;
  }
  const DWORD acl_bytes = static_cast<DWORD>(
      sizeof(ACL) +
      3U * (sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD)) + system.length +
      service.length + administrators.length);
  if (acl_bytes > acl_storage->size()) {
    return false;
  }
  acl_storage->fill(0U);
  PACL acl = reinterpret_cast<PACL>(acl_storage->data());
  if (InitializeAcl(acl, acl_bytes, ACL_REVISION) == FALSE ||
      AddAccessAllowedAceEx(
          acl, ACL_REVISION, 0U, kPipeGrantedMask, system.bytes.data()) == FALSE ||
      AddAccessAllowedAceEx(
          acl, ACL_REVISION, 0U, kPipeGrantedMask, service.bytes.data()) == FALSE ||
      AddAccessAllowedAceEx(
          acl,
          ACL_REVISION,
          0U,
          kPipeGrantedMask,
          administrators.bytes.data()) == FALSE ||
      acl->AceCount != 3U ||
      InitializeSecurityDescriptor(descriptor, SECURITY_DESCRIPTOR_REVISION) == FALSE ||
      SetSecurityDescriptorOwner(descriptor, system.bytes.data(), FALSE) == FALSE ||
      SetSecurityDescriptorDacl(descriptor, TRUE, acl, FALSE) == FALSE ||
      SetSecurityDescriptorControl(
          descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED) == FALSE ||
      IsValidSecurityDescriptor(descriptor) == FALSE) {
    return false;
  }
  attributes->nLength = sizeof(*attributes);
  attributes->lpSecurityDescriptor = descriptor;
  attributes->bInheritHandle = FALSE;
  return true;
}

std::uint64_t AddDeadline(
    std::uint64_t start,
    std::uint64_t duration) noexcept {
  return start > UINT64_MAX - duration ? UINT64_MAX : start + duration;
}

std::uint64_t MinimumDeadline(
    std::uint64_t left,
    std::uint64_t right) noexcept {
  if (left == 0U) {
    return right;
  }
  if (right == 0U) {
    return left;
  }
  return left < right ? left : right;
}

DWORD DeadlineWaitMilliseconds(std::uint64_t deadline) noexcept {
  const std::uint64_t now = GetTickCount64();
  if (deadline == 0U || now >= deadline) {
    return 0U;
  }
  const std::uint64_t remaining = deadline - now;
  return remaining >= static_cast<std::uint64_t>(MAXDWORD)
             ? MAXDWORD - 1U
             : static_cast<DWORD>(remaining);
}

enum class IoResult : std::uint8_t {
  Success,
  Deadline,
  Stop,
  BrokenPipe,
  MoreData,
  Failed,
  CancellationFailed,
};

[[noreturn]] void FailFastClientCancellation() noexcept {
  TerminateProcess(GetCurrentProcess(), kCancellationFailFastExit);
  ExitProcess(kCancellationFailFastExit);
}

bool ObserveTerminalOverlapped(
    HANDLE handle,
    OVERLAPPED* overlapped,
    HANDLE event,
    std::uint64_t grace_deadline,
    bool client_fail_fast) noexcept {
  for (;;) {
    DWORD transferred = 0U;
    if (GetOverlappedResult(handle, overlapped, &transferred, FALSE) != FALSE) {
      return true;
    }
    const DWORD error = GetLastError();
    if (error == ERROR_OPERATION_ABORTED) {
      return true;
    }
    if (error != ERROR_IO_INCOMPLETE) {
      return false;
    }
    const DWORD wait_ms = DeadlineWaitMilliseconds(grace_deadline);
    if (wait_ms == 0U || WaitForSingleObject(event, wait_ms) != WAIT_OBJECT_0) {
      if (client_fail_fast) {
        FailFastClientCancellation();
      }
      return false;
    }
  }
}

IoResult CancelAndObserve(
    HANDLE handle,
    OVERLAPPED* overlapped,
    HANDLE event,
    bool client_fail_fast,
    IoResult winning_result) noexcept {
  SetLastError(NO_ERROR);
  const BOOL cancel_result = CancelIoEx(handle, overlapped);
  const DWORD cancel_error = cancel_result != FALSE ? ERROR_SUCCESS : GetLastError();
  if (cancel_result == FALSE && cancel_error != ERROR_NOT_FOUND) {
    if (client_fail_fast) {
      FailFastClientCancellation();
    }
    return IoResult::CancellationFailed;
  }
  const std::uint64_t grace_deadline =
      AddDeadline(GetTickCount64(), kCancellationGraceMilliseconds);
  if (!ObserveTerminalOverlapped(
          handle, overlapped, event, grace_deadline, client_fail_fast)) {
    return IoResult::CancellationFailed;
  }
  return winning_result;
}

IoResult CompletePendingIo(
    HANDLE handle,
    OVERLAPPED* overlapped,
    HANDLE event,
    HANDLE stop_event,
    std::uint64_t deadline,
    bool client_fail_fast,
    DWORD* transferred) noexcept {
  if (transferred == nullptr) {
    return IoResult::Failed;
  }
  if (stop_event != nullptr &&
      WaitForSingleObject(stop_event, 0U) == WAIT_OBJECT_0) {
    return CancelAndObserve(
        handle, overlapped, event, client_fail_fast, IoResult::Stop);
  }
  std::array<HANDLE, 2U> waits = {event, stop_event};
  const DWORD count = stop_event == nullptr ? 1U : 2U;
  const DWORD wait_ms = DeadlineWaitMilliseconds(deadline);
  if (wait_ms == 0U) {
    return CancelAndObserve(
        handle, overlapped, event, client_fail_fast, IoResult::Deadline);
  }
  const DWORD wait_result = WaitForMultipleObjects(count, waits.data(), FALSE, wait_ms);
  if (wait_result == WAIT_TIMEOUT) {
    return CancelAndObserve(
        handle, overlapped, event, client_fail_fast, IoResult::Deadline);
  }
  if (count == 2U && wait_result == WAIT_OBJECT_0 + 1U) {
    return CancelAndObserve(
        handle, overlapped, event, client_fail_fast, IoResult::Stop);
  }
  if (wait_result != WAIT_OBJECT_0) {
    return CancelAndObserve(
        handle, overlapped, event, client_fail_fast, IoResult::CancellationFailed);
  }
  if (stop_event != nullptr &&
      WaitForSingleObject(stop_event, 0U) == WAIT_OBJECT_0) {
    return CancelAndObserve(
        handle, overlapped, event, client_fail_fast, IoResult::Stop);
  }
  if (DeadlineWaitMilliseconds(deadline) == 0U) {
    return CancelAndObserve(
        handle, overlapped, event, client_fail_fast, IoResult::Deadline);
  }
  if (GetOverlappedResult(handle, overlapped, transferred, FALSE) != FALSE) {
    return IoResult::Success;
  }
  const DWORD error = GetLastError();
  if (error == ERROR_BROKEN_PIPE) {
    return IoResult::BrokenPipe;
  }
  if (error == ERROR_MORE_DATA) {
    return IoResult::MoreData;
  }
  return error == ERROR_OPERATION_ABORTED ? IoResult::CancellationFailed
                                           : IoResult::Failed;
}

IoResult OverlappedRead(
    HANDLE handle,
    std::uint8_t* buffer,
    DWORD requested,
    HANDLE stop_event,
    std::uint64_t deadline,
    bool client_fail_fast,
    DWORD* transferred) noexcept {
  if (handle == nullptr || handle == INVALID_HANDLE_VALUE || buffer == nullptr ||
      requested == 0U || transferred == nullptr) {
    return IoResult::Failed;
  }
  ScopedHandle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (event.get() == nullptr) {
    return IoResult::Failed;
  }
  OVERLAPPED overlapped{};
  overlapped.hEvent = event.get();
  *transferred = 0U;
  if (stop_event != nullptr &&
      WaitForSingleObject(stop_event, 0U) == WAIT_OBJECT_0) {
    return IoResult::Stop;
  }
  if (DeadlineWaitMilliseconds(deadline) == 0U) {
    return IoResult::Deadline;
  }
  SetLastError(NO_ERROR);
  if (ReadFile(handle, buffer, requested, transferred, &overlapped) != FALSE) {
    if (stop_event != nullptr &&
        WaitForSingleObject(stop_event, 0U) == WAIT_OBJECT_0) {
      return IoResult::Stop;
    }
    return DeadlineWaitMilliseconds(deadline) == 0U ? IoResult::Deadline
                                                     : IoResult::Success;
  }
  const DWORD error = GetLastError();
  if (error == ERROR_BROKEN_PIPE) {
    return IoResult::BrokenPipe;
  }
  if (error == ERROR_MORE_DATA) {
    return IoResult::MoreData;
  }
  if (error != ERROR_IO_PENDING) {
    return IoResult::Failed;
  }
  return CompletePendingIo(
      handle,
      &overlapped,
      event.get(),
      stop_event,
      deadline,
      client_fail_fast,
      transferred);
}

IoResult OverlappedWriteMessage(
    HANDLE handle,
    const std::uint8_t* buffer,
    std::size_t length,
    HANDLE stop_event,
    std::uint64_t deadline,
    bool client_fail_fast) noexcept {
  if (handle == nullptr || handle == INVALID_HANDLE_VALUE || buffer == nullptr ||
      length == 0U || length > MAXDWORD) {
    return IoResult::Failed;
  }
  ScopedHandle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (event.get() == nullptr) {
    return IoResult::Failed;
  }
  OVERLAPPED overlapped{};
  overlapped.hEvent = event.get();
  DWORD transferred = 0U;
  if (stop_event != nullptr &&
      WaitForSingleObject(stop_event, 0U) == WAIT_OBJECT_0) {
    return IoResult::Stop;
  }
  if (DeadlineWaitMilliseconds(deadline) == 0U) {
    return IoResult::Deadline;
  }
  SetLastError(NO_ERROR);
  if (WriteFile(
          handle,
          buffer,
          static_cast<DWORD>(length),
          &transferred,
          &overlapped) != FALSE) {
    if (stop_event != nullptr &&
        WaitForSingleObject(stop_event, 0U) == WAIT_OBJECT_0) {
      return IoResult::Stop;
    }
    if (DeadlineWaitMilliseconds(deadline) == 0U) {
      return IoResult::Deadline;
    }
    return transferred == length ? IoResult::Success : IoResult::Failed;
  }
  if (GetLastError() != ERROR_IO_PENDING) {
    return IoResult::Failed;
  }
  const IoResult result = CompletePendingIo(
      handle,
      &overlapped,
      event.get(),
      stop_event,
      deadline,
      client_fail_fast,
      &transferred);
  return result == IoResult::Success && transferred != length ? IoResult::Failed
                                                               : result;
}

IoResult ReadSingleMessage(
    HANDLE pipe,
    std::uint8_t* buffer,
    std::size_t capacity,
    HANDLE stop_event,
    std::uint64_t deadline,
    std::size_t* received) noexcept {
  if (received == nullptr || capacity == 0U || capacity > MAXDWORD) {
    return IoResult::Failed;
  }
  DWORD transferred = 0U;
  const IoResult result = OverlappedRead(
      pipe,
      buffer,
      static_cast<DWORD>(capacity),
      stop_event,
      deadline,
      false,
      &transferred);
  if (result != IoResult::Success) {
    return result;
  }
  if (transferred == 0U || transferred > capacity) {
    return IoResult::Failed;
  }
  *received = transferred;
  return IoResult::Success;
}

bool PeekFrozenBudget(
    HANDLE pipe,
    std::size_t phase_maximum,
    std::uint64_t deadline,
    std::size_t* frozen_budget) noexcept {
  if (pipe == nullptr || pipe == INVALID_HANDLE_VALUE || frozen_budget == nullptr) {
    return false;
  }
  for (;;) {
    DWORD total_available = 0U;
    DWORD current_message_left = 0U;
    if (PeekNamedPipe(
            pipe,
            nullptr,
            0U,
            nullptr,
            &total_available,
            &current_message_left) == FALSE) {
      return false;
    }
    if (total_available != 0U || current_message_left != 0U) {
      return FreezeCurrentMessageBudget(
          total_available,
          current_message_left,
          phase_maximum,
          frozen_budget);
    }
    if (DeadlineWaitMilliseconds(deadline) == 0U) {
      return false;
    }
    Sleep(1U);
  }
}

bool ReadFrozenClientMessage(
    HANDLE pipe,
    std::uint8_t* buffer,
    std::size_t capacity,
    std::uint64_t deadline,
    std::size_t* received) noexcept {
  if (buffer == nullptr || received == nullptr) {
    return false;
  }
  std::size_t frozen_budget = 0U;
  if (!PeekFrozenBudget(pipe, capacity, deadline, &frozen_budget)) {
    return false;
  }
  std::size_t offset = 0U;
  std::size_t exact_frame_length = 0U;
  while (offset < frozen_budget) {
    std::size_t target = kGcpaHeaderBytes;
    if (offset >= kGcpaHeaderBytes) {
      target = exact_frame_length;
    }
    if (target == 0U || target > frozen_budget || offset >= target) {
      return false;
    }
    const std::size_t remaining_to_target = target - offset;
    const std::size_t remaining_budget = frozen_budget - offset;
    const DWORD request = static_cast<DWORD>(
        remaining_to_target < remaining_budget ? remaining_to_target
                                                : remaining_budget);
    DWORD transferred = 0U;
    const IoResult result = OverlappedRead(
        pipe,
        buffer + offset,
        request,
        nullptr,
        deadline,
        true,
        &transferred);
    if (result != IoResult::Success || transferred == 0U || transferred > request) {
      return false;
    }
    offset += transferred;
    if (offset == kGcpaHeaderBytes) {
      if (buffer[0] != kGcpaMagic[0] || buffer[1] != kGcpaMagic[1] ||
          buffer[2] != kGcpaMagic[2] || buffer[3] != kGcpaMagic[3] ||
          ReadU16(buffer + 4U) != kGcpaVersion || buffer[7] != kGcpaFlags ||
          ReadU32(buffer + 8U) != kGcpaRequestId ||
          !AddSize(
              kGcpaHeaderBytes,
              static_cast<std::size_t>(ReadU32(buffer + 12U)),
              &exact_frame_length) ||
          exact_frame_length != frozen_budget || exact_frame_length > capacity) {
        return false;
      }
    }
  }
  if (offset != frozen_budget || exact_frame_length != frozen_budget) {
    return false;
  }
  DWORD total_available = UINT32_MAX;
  DWORD current_message_left = UINT32_MAX;
  if (PeekNamedPipe(
          pipe,
          nullptr,
          0U,
          nullptr,
          &total_available,
          &current_message_left) == FALSE ||
      total_available != 0U || current_message_left != 0U) {
    return false;
  }
  *received = offset;
  return true;
}

bool PipeHasNoBufferedBytes(HANDLE pipe) noexcept {
  DWORD total_available = UINT32_MAX;
  DWORD current_message_left = UINT32_MAX;
  return pipe != nullptr && pipe != INVALID_HANDLE_VALUE &&
         PeekNamedPipe(
             pipe,
             nullptr,
             0U,
             nullptr,
             &total_available,
             &current_message_left) != FALSE &&
         total_available == 0U && current_message_left == 0U;
}

bool RefreshClientEvidenceMatches(
    const ProcessEvidence& evidence,
    const FixedPath& expected_path) noexcept {
  if (!IsProcessAlive(evidence.process)) {
    return false;
  }
  std::uint64_t creation = 0U;
  FixedPath before{};
  FixedPath after{};
  HANDLE raw_token = nullptr;
  ScopedHandle token;
  TokenProjection projection{};
  return QueryProcessCreationTime(evidence.process, &creation) &&
         creation == evidence.creation_file_time &&
         QueryProcessPath(evidence.process, &before) &&
         EqualOrdinalPath(before.value.data(), expected_path.value.data()) &&
         OpenProcessToken(evidence.process, TOKEN_QUERY, &raw_token) != FALSE &&
         (token.Reset(raw_token), true) &&
         CaptureClientTokenProjection(
             token.get(), TokenPrimary, SecurityAnonymous, true, &projection) &&
         TokenProjectionsEqual(projection, evidence.token_projection) &&
         QueryProcessPath(evidence.process, &after) &&
         EqualOrdinalPath(before.value.data(), after.value.data()) &&
         IsProcessAlive(evidence.process);
}

bool RefreshServiceEvidenceMatches(
    const ProcessEvidence& evidence,
    const FixedPath& expected_path) noexcept {
  if (!IsProcessAlive(evidence.process)) {
    return false;
  }
  std::uint64_t creation = 0U;
  FixedPath before{};
  FixedPath after{};
  HANDLE raw_token = nullptr;
  ScopedHandle token;
  return QueryProcessCreationTime(evidence.process, &creation) &&
         creation == evidence.creation_file_time &&
         QueryProcessPath(evidence.process, &before) &&
         EqualOrdinalPath(before.value.data(), expected_path.value.data()) &&
         OpenProcessToken(evidence.process, TOKEN_QUERY, &raw_token) != FALSE &&
         (token.Reset(raw_token), true) && ValidateServiceProcessToken(token.get()) &&
         QueryProcessPath(evidence.process, &after) &&
         EqualOrdinalPath(before.value.data(), after.value.data()) &&
         IsProcessAlive(evidence.process);
}

ServiceTransportResult IoToServiceResult(
    IoResult result,
    ServiceTransportResult ordinary_failure) noexcept {
  switch (result) {
    case IoResult::Success:
      return ServiceTransportResult::Success;
    case IoResult::Deadline:
      return ServiceTransportResult::Deadline;
    case IoResult::Stop:
      return ServiceTransportResult::Success;
    case IoResult::CancellationFailed:
      return ServiceTransportResult::CancellationOrReversion;
    case IoResult::BrokenPipe:
    case IoResult::MoreData:
    case IoResult::Failed:
      return ordinary_failure;
  }
  return ordinary_failure;
}

}  // namespace

ServiceTransportResult ArmServiceTransport(
    ServiceTransportState* state) noexcept {
  ServiceStateInternal* internal = InternalState(state);
  if (internal == nullptr || !internal->images_validated || internal->pipe_armed ||
      internal->context.stop_event == nullptr ||
      WaitForSingleObject(internal->context.stop_event, 0U) != WAIT_TIMEOUT ||
      !RevalidateHeldLayout(internal->layout)) {
    return ServiceTransportResult::PipeReadiness;
  }
#if defined(GOATCITADEL_PROVISIONER_CUSTODY)
  if (!internal->protected_recovery_verified ||
      !internal->protected_operations.ready) {
    return ServiceTransportResult::CustodyOrJournal;
  }
#endif
  SECURITY_ATTRIBUTES attributes{};
  SECURITY_DESCRIPTOR descriptor{};
  std::array<std::uint8_t, 512U> acl_storage{};
  if (!BuildPipeSecurityAttributes(&attributes, &descriptor, &acl_storage)) {
    return ServiceTransportResult::PipeReadiness;
  }
  ScopedHandle pipe(CreateNamedPipeW(
      kProvisionerPipeName,
      PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
      PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT |
          PIPE_REJECT_REMOTE_CLIENTS,
      1U,
      kPipeBufferBytes,
      kPipeBufferBytes,
      0U,
      &attributes));
  if (pipe.get() == INVALID_HANDLE_VALUE) {
    return ServiceTransportResult::PipeReadiness;
  }
  ScopedHandle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (event.get() == nullptr) {
    return ServiceTransportResult::PipeReadiness;
  }
  internal->accept_overlapped = OVERLAPPED{};
  internal->accept_overlapped.hEvent = event.get();
  SetLastError(NO_ERROR);
  const BOOL connected = ConnectNamedPipe(pipe.get(), &internal->accept_overlapped);
  if (connected != FALSE) {
    internal->accept_completed = true;
  } else {
    const DWORD error = GetLastError();
    if (error == ERROR_IO_PENDING) {
      internal->accept_pending = true;
    } else if (error == ERROR_PIPE_CONNECTED) {
      internal->accept_completed = true;
    } else {
      return ServiceTransportResult::PipeReadiness;
    }
  }
  internal->pipe = pipe.Release();
  internal->accept_event = event.Release();
  internal->pipe_armed = true;
  return ServiceTransportResult::Success;
}

bool SetServiceTransportRunningDeadline(
    ServiceTransportState* state,
    std::uint64_t running_deadline_ms) noexcept {
  ServiceStateInternal* internal = InternalState(state);
  if (internal == nullptr || !internal->pipe_armed || internal->run_started ||
      running_deadline_ms <= GetTickCount64()) {
    return false;
  }
  internal->context.running_deadline_ms = running_deadline_ms;
  return true;
}

ServiceTransportResult RunServiceTransport(
    ServiceTransportState* state) noexcept {
  ServiceStateInternal* internal = InternalState(state);
  if (internal == nullptr || !internal->pipe_armed || internal->run_started ||
      internal->context.running_deadline_ms <= GetTickCount64()) {
    return ServiceTransportResult::PipeReadiness;
  }
  internal->run_started = true;

  const std::uint64_t accept_deadline = MinimumDeadline(
      internal->context.running_deadline_ms,
      AddDeadline(GetTickCount64(), kAcceptMilliseconds));
  if (internal->accept_pending) {
    DWORD ignored = 0U;
    const IoResult accept_result = CompletePendingIo(
        internal->pipe,
        &internal->accept_overlapped,
        internal->accept_event,
        internal->context.stop_event,
        accept_deadline,
        false,
        &ignored);
    internal->accept_pending = false;
    if (accept_result == IoResult::Deadline || accept_result == IoResult::Stop) {
      return ServiceTransportResult::Success;
    }
    if (accept_result == IoResult::CancellationFailed) {
      return ServiceTransportResult::CancellationOrReversion;
    }
    if (accept_result != IoResult::Success) {
      return ServiceTransportResult::PipeReadiness;
    }
    internal->accept_completed = true;
  }
  if (!internal->accept_completed) {
    return ServiceTransportResult::PipeReadiness;
  }

  const std::uint64_t aggregate_deadline = MinimumDeadline(
      internal->context.running_deadline_ms,
      AddDeadline(GetTickCount64(), kClientWorkMilliseconds));
  const std::uint64_t hello_deadline = MinimumDeadline(
      aggregate_deadline,
      AddDeadline(GetTickCount64(), kHelloReadMilliseconds));
  std::size_t frame_length = 0U;
  IoResult io = ReadSingleMessage(
      internal->pipe,
      internal->frame.data(),
      kGcpaHeaderBytes + kGcpaClientHelloPayloadBytes,
      internal->context.stop_event,
      hello_deadline,
      &frame_length);
  if (io != IoResult::Success) {
    return IoToServiceResult(io, ServiceTransportResult::ProtocolInvalid);
  }
  if (!DecodeGcpaClientHello(
          internal->frame.data(), frame_length, &internal->client_nonce)) {
    return ServiceTransportResult::ProtocolInvalid;
  }

  const std::uint64_t authentication_deadline = MinimumDeadline(
      aggregate_deadline,
      AddDeadline(GetTickCount64(), kAuthenticationMilliseconds));
  if (DeadlineWaitMilliseconds(authentication_deadline) == 0U) {
    return ServiceTransportResult::Deadline;
  }
  const CallerAuthenticationResult authentication =
      AuthenticateClientAfterHello(internal);
  if (authentication == CallerAuthenticationResult::ReversionFailure) {
    return ServiceTransportResult::CancellationOrReversion;
  }
  if (authentication != CallerAuthenticationResult::Success) {
    return ServiceTransportResult::CallerAuthentication;
  }
  if (WaitForSingleObject(internal->context.stop_event, 0U) == WAIT_OBJECT_0) {
    return ServiceTransportResult::Success;
  }
  if (DeadlineWaitMilliseconds(authentication_deadline) == 0U) {
    return ServiceTransportResult::Deadline;
  }
  if (!GenerateRandom32(&internal->connection_nonce) ||
      BytesEqual(
          internal->connection_nonce.data(),
          internal->service_start_nonce.data(),
          internal->connection_nonce.size())) {
    return ServiceTransportResult::ProtocolInvalid;
  }
  GcpaServerHelloFields hello{};
  hello.service_start_nonce = internal->service_start_nonce;
  hello.connection_nonce = internal->connection_nonce;
  hello.client_nonce = internal->client_nonce;
  hello.recognized_operation_bitmap = kGcpaRecognizedOpcodeBitmap;
  hello.callable_operation_bitmap = kGcpaCallableOpcodeBitmap;
  if (!EncodeGcpaServerHello(
          hello,
          internal->frame.data(),
          internal->frame.size(),
          &frame_length)) {
    return ServiceTransportResult::ProtocolInvalid;
  }
  io = OverlappedWriteMessage(
      internal->pipe,
      internal->frame.data(),
      frame_length,
      internal->context.stop_event,
      authentication_deadline,
      false);
  if (io != IoResult::Success) {
    return IoToServiceResult(io, ServiceTransportResult::CallerAuthentication);
  }

  const std::uint64_t request_deadline = MinimumDeadline(
      aggregate_deadline,
      AddDeadline(GetTickCount64(), kRequestReadMilliseconds));
  io = ReadSingleMessage(
      internal->pipe,
      internal->frame.data(),
      internal->frame.size(),
      internal->context.stop_event,
      request_deadline,
      &frame_length);
  if (io != IoResult::Success) {
    return IoToServiceResult(io, ServiceTransportResult::ProtocolInvalid);
  }
  GcpaClientRequestFields request{};
  if (!DecodeGcpaClientRequest(
          internal->frame.data(), frame_length, &request) ||
      !BytesEqual(
          request.service_start_nonce.data(),
          internal->service_start_nonce.data(),
          request.service_start_nonce.size()) ||
      !BytesEqual(
          request.connection_nonce.data(),
          internal->connection_nonce.data(),
          request.connection_nonce.size()) ||
      !BytesEqual(
          request.client_nonce.data(),
          internal->client_nonce.data(),
          request.client_nonce.size()) ||
      request.schema != 1U) {
    return ServiceTransportResult::ProtocolInvalid;
  }
  CreateKeysetRequest create_request{};
  SignAdmissionEvidenceRequest sign_request{};
  SignRuntimePopV2Request pop_v2_request{};
  RevokeKeysetRequest revoke_request{};
  const bool exact_callable_request =
      (request.opcode == static_cast<std::uint8_t>(Opcode::Inspect) &&
       request.body_length == 0U &&
       IsAllZero(request.expected_state_sha256.data(), 32U)) ||
      (request.opcode == static_cast<std::uint8_t>(Opcode::CreateKeyset) &&
       DecodeCreateKeysetRequest(
           request.body, request.body_length, &create_request) &&
       BytesEqual(
           request.operation_id.data(), create_request.operation_id.data(), 16U) &&
       BytesEqual(
           request.expected_state_sha256.data(),
           create_request.expected_state_sha256.data(),
           32U)) ||
      (request.opcode ==
           static_cast<std::uint8_t>(Opcode::SignAdmissionEvidence) &&
       DecodeSignAdmissionEvidenceRequest(
           request.body, request.body_length, &sign_request) &&
       BytesEqual(
           request.operation_id.data(), sign_request.operation_id.data(),
           16U) &&
       BytesEqual(
           request.expected_state_sha256.data(),
           sign_request.expected_state_sha256.data(),
           32U)) ||
      (request.opcode ==
           static_cast<std::uint8_t>(Opcode::SignRuntimePopV2) &&
       DecodeSignRuntimePopV2Request(
           request.body, request.body_length, &pop_v2_request) &&
       BytesEqual(
           request.operation_id.data(), pop_v2_request.operation_id.data(),
           16U) &&
       BytesEqual(
           request.expected_state_sha256.data(),
           pop_v2_request.expected_state_sha256.data(),
           32U)) ||
      (request.opcode == static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset) &&
       DecodeRevokeKeysetRequest(
           request.body, request.body_length, &revoke_request) &&
       BytesEqual(
           request.operation_id.data(), revoke_request.operation_id.data(), 16U) &&
       BytesEqual(
           request.expected_state_sha256.data(),
           revoke_request.expected_state_sha256.data(),
           32U));
  if (!exact_callable_request &&
      (request.opcode == static_cast<std::uint8_t>(Opcode::Inspect) ||
       request.opcode == static_cast<std::uint8_t>(Opcode::CreateKeyset) ||
        request.opcode ==
            static_cast<std::uint8_t>(Opcode::SignAdmissionEvidence) ||
        request.opcode ==
            static_cast<std::uint8_t>(Opcode::SignRuntimePopV2) ||
        request.opcode == static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset))) {
    return ServiceTransportResult::ProtocolInvalid;
  }
  internal->operation_id = request.operation_id;
  std::uint64_t service_creation = 0U;
  if (!QueryProcessCreationTime(GetCurrentProcess(), &service_creation)) {
    return ServiceTransportResult::CallerAuthentication;
  }
  AuthenticatedRequestBindingInput binding_input{};
  binding_input.service_image = &internal->layout.service_projection;
  binding_input.client_image = &internal->layout.client_projection;
  binding_input.client_primary = &internal->client.token_projection;
  binding_input.pipe_identification = &internal->pipe_identification;
  binding_input.service_pid = GetCurrentProcessId();
  binding_input.service_creation_file_time = service_creation;
  binding_input.client_pid = internal->client.pid;
  binding_input.client_creation_file_time = internal->client.creation_file_time;
  binding_input.service_start_nonce = &internal->service_start_nonce;
  binding_input.connection_nonce = &internal->connection_nonce;
  binding_input.client_nonce = &internal->client_nonce;
  binding_input.operation_id = &internal->operation_id;
  binding_input.opcode = request.opcode;
  binding_input.schema = request.schema;
  binding_input.body_sha256 = &request.body_sha256;
  binding_input.expected_state_sha256 = &request.expected_state_sha256;
  if (!ComputeAuthenticatedRequestBinding(
          binding_input, &internal->request_binding)) {
    return ServiceTransportResult::ProtocolInvalid;
  }

  GcpaErrorCode error_code = GcpaErrorCode::ProtocolInvalid;
  bool send_result = false;
  std::array<std::uint8_t, kCreateKeysetResultBytes> operation_result{};
  std::uint32_t operation_result_length = 0U;
#if defined(GOATCITADEL_PROVISIONER_CUSTODY)
  if (request.opcode == static_cast<std::uint8_t>(Opcode::Inspect) &&
      request.body_length == 0U) {
    if (!BuildProtectedInspect(
            internal->protected_operations,
            kLocalPeMachine,
            &operation_result)) {
      return ServiceTransportResult::CustodyOrJournal;
    }
    operation_result_length = kProtectedInspectPayloadBytes;
    send_result = true;
  } else if (request.opcode == static_cast<std::uint8_t>(Opcode::CreateKeyset) ||
             request.opcode ==
                  static_cast<std::uint8_t>(Opcode::SignAdmissionEvidence) ||
             request.opcode ==
                  static_cast<std::uint8_t>(Opcode::SignRuntimePopV2) ||
             request.opcode == static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset)) {
    const std::uint64_t operation_budget_ms =
        request.opcode == static_cast<std::uint8_t>(Opcode::CreateKeyset)
            ? 10000U
            : 5000U;
    const ProtectedOperationResult operation = ExecuteProtectedOperation(
        &internal->protected_operations,
        request.opcode,
        request.body,
        request.body_length,
        internal->client.token_projection.user.bytes.data(),
        internal->client.token_projection.user.length,
        internal->request_binding,
        MinimumDeadline(
            aggregate_deadline,
            MinimumDeadline(
                internal->context.running_deadline_ms,
                AddDeadline(GetTickCount64(), operation_budget_ms))),
        internal->context.stop_event,
        &operation_result,
        &operation_result_length);
    if (operation == ProtectedOperationResult::CustodyOrJournal) {
      return ServiceTransportResult::CustodyOrJournal;
    }
    if (operation == ProtectedOperationResult::ProtocolInvalid) {
      return ServiceTransportResult::ProtocolInvalid;
    }
    send_result = true;
  } else if (IsRecognizedOpcode(request.opcode) &&
             request.opcode != static_cast<std::uint8_t>(Opcode::Inspect)) {
    error_code = GcpaErrorCode::OperationUnavailable;
  }
#else
  if (request.opcode == static_cast<std::uint8_t>(Opcode::Inspect) &&
      request.body_length == 0U) {
    RequestHeader header{};
    header.opcode = request.opcode;
    const Response response = DecideRequest(
        HeaderStatus::Valid, header, true, true, kLocalPeMachine);
    if (response.size != kHeaderBytes + kInspectPayloadBytes) {
      return ServiceTransportResult::ProtocolInvalid;
    }
    std::memcpy(
        operation_result.data(),
        response.bytes.data() + kHeaderBytes,
        kInspectPayloadBytes);
    operation_result_length = kInspectPayloadBytes;
    send_result = true;
  } else if (IsRecognizedOpcode(request.opcode)) {
    error_code = GcpaErrorCode::OperationUnavailable;
  }
#endif

  if (!RefreshClientEvidenceMatches(
          internal->client, internal->layout.client_path_dos) ||
      !RevalidateHeldLayout(internal->layout)) {
    return ServiceTransportResult::CallerAuthentication;
  }
  const std::uint64_t result_deadline = MinimumDeadline(
      aggregate_deadline,
      AddDeadline(GetTickCount64(), kResultWriteMilliseconds));
  if (send_result) {
    if (!EncodeGcpaServerResult(
            internal->operation_id,
            internal->request_binding,
            operation_result.data(),
            operation_result_length,
            internal->frame.data(),
            internal->frame.size(),
            &frame_length)) {
      return ServiceTransportResult::ProtocolInvalid;
    }
  } else if (!EncodeGcpaError(
                 error_code,
                 internal->operation_id,
                 internal->request_binding,
                 internal->frame.data(),
                 internal->frame.size(),
                 &frame_length)) {
    return ServiceTransportResult::ProtocolInvalid;
  }
  io = OverlappedWriteMessage(
      internal->pipe,
      internal->frame.data(),
      frame_length,
      internal->context.stop_event,
      result_deadline,
      false);
  if (io != IoResult::Success) {
    return IoToServiceResult(io, ServiceTransportResult::ProtocolInvalid);
  }

  std::uint8_t trailing = 0U;
  DWORD received = 0U;
  io = OverlappedRead(
      internal->pipe,
      &trailing,
      1U,
      internal->context.stop_event,
      aggregate_deadline,
      false,
      &received);
  if ((io == IoResult::BrokenPipe || io == IoResult::Success) && received == 0U) {
    return ServiceTransportResult::Success;
  }
  return IoToServiceResult(io, ServiceTransportResult::ProtocolInvalid);
}

ServiceTransportResult CloseServiceTransport(
    ServiceTransportState* state) noexcept {
  ServiceStateInternal* internal = InternalState(state);
  if (internal == nullptr) {
    return ServiceTransportResult::Success;
  }
  ServiceTransportResult cleanup_result = ServiceTransportResult::Success;
  if (internal->accept_pending && internal->pipe != nullptr &&
      internal->accept_event != nullptr) {
    const IoResult cancellation_result = CancelAndObserve(
        internal->pipe,
        &internal->accept_overlapped,
        internal->accept_event,
        false,
        IoResult::Stop);
    if (cancellation_result != IoResult::Stop) {
      cleanup_result = ServiceTransportResult::CancellationOrReversion;
    }
    internal->accept_pending = false;
  }
  if (internal->pipe != nullptr && internal->pipe != INVALID_HANDLE_VALUE) {
    SetLastError(NO_ERROR);
    if (DisconnectNamedPipe(internal->pipe) == FALSE &&
        GetLastError() != ERROR_PIPE_NOT_CONNECTED) {
      cleanup_result = ServiceTransportResult::CancellationOrReversion;
    }
    if (CloseHandle(internal->pipe) == FALSE) {
      cleanup_result = ServiceTransportResult::CancellationOrReversion;
    }
    internal->pipe = nullptr;
  }
  if (internal->accept_event != nullptr &&
      internal->accept_event != INVALID_HANDLE_VALUE) {
    if (CloseHandle(internal->accept_event) == FALSE) {
      cleanup_result = ServiceTransportResult::CancellationOrReversion;
    }
    internal->accept_event = nullptr;
  }
  CloseProcessEvidence(&internal->client);
#if defined(GOATCITADEL_PROVISIONER_CUSTODY)
  CloseProtectedOperations(&internal->protected_operations);
#endif
  CloseLayout(&internal->layout);
  internal->~ServiceStateInternal();
  SecureZeroMemory(state->storage.data(), state->storage.size());
  return cleanup_result;
}

namespace {

alignas(64) std::array<std::uint8_t, kGcpaMaximumRequestFrameBytes>
    g_client_frame{};
volatile LONG g_client_exchange_held = 0;

bool ProveNoAmbientThreadToken() noexcept {
  HANDLE ambient = nullptr;
  SetLastError(NO_ERROR);
  if (OpenThreadToken(
          GetCurrentThread(), TOKEN_QUERY, FALSE, &ambient) != FALSE) {
    CloseHandle(ambient);
    return false;
  }
  return GetLastError() == ERROR_NO_TOKEN;
}

class ClientExchangeScope final {
 public:
  ClientExchangeScope() noexcept = default;
  ~ClientExchangeScope() noexcept {
    pipe_.Reset();
    CloseProcessEvidence(&server_);
    CloseProcessEvidence(&client_);
    CloseLayout(&layout_);
    SecureZeroMemory(g_client_frame.data(), g_client_frame.size());
    InterlockedExchange(&g_client_exchange_held, 0);
  }
  ClientExchangeScope(const ClientExchangeScope&) = delete;
  ClientExchangeScope& operator=(const ClientExchangeScope&) = delete;

  HeldLayout layout_{};
  ProcessEvidence server_{};
  ProcessEvidence client_{};
  ScopedHandle pipe_{};
};

bool OpenProtectedClientPipe(ScopedHandle* output) noexcept {
  if (output == nullptr) {
    return false;
  }
  const std::uint64_t deadline =
      AddDeadline(GetTickCount64(), kClientPipeWaitMilliseconds);
  const DWORD wait_ms = DeadlineWaitMilliseconds(deadline);
  if (wait_ms == 0U ||
      WaitNamedPipeW(kProvisionerPipeName, wait_ms) == FALSE) {
    return false;
  }
  ScopedHandle pipe(CreateFileW(
      kProvisionerPipeName,
      static_cast<DWORD>(GENERIC_READ | FILE_WRITE_DATA),
      0U,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION |
          SECURITY_EFFECTIVE_ONLY,
      nullptr));
  if (pipe.get() == INVALID_HANDLE_VALUE) {
    return false;
  }
  output->Reset(pipe.Release());
  return true;
}

bool ExpectedInspectResult(
    const std::uint8_t* result,
    std::uint32_t result_length) noexcept {
  if (result == nullptr || result_length != kProtectedInspectPayloadBytes) {
    return false;
  }
  RequestHeader header{};
  header.opcode = static_cast<std::uint8_t>(Opcode::Inspect);
  const Response direct = DecideRequest(
      HeaderStatus::Valid, header, true, true, kLocalPeMachine);
  return direct.size == kHeaderBytes + kInspectPayloadBytes &&
         direct.exit_code == ExitCode::Success &&
         BytesEqual(result, direct.bytes.data() + kHeaderBytes, kInspectPayloadBytes) &&
         result[32U] == 1U && result[33U] == 0U &&
         ReadU64(result + 40U) == kProtectedCallableOpcodeBitmap;
}

bool IsExactProtectedRequest(const ClientExchangeRequest& request) noexcept {
  if (request.opcode == static_cast<std::uint8_t>(Opcode::Inspect)) {
    return request.body_length == 0U &&
           IsAllZero(request.operation_id.data(), request.operation_id.size()) &&
           IsAllZero(
               request.expected_state_sha256.data(),
               request.expected_state_sha256.size());
  }
  if (request.opcode == static_cast<std::uint8_t>(Opcode::CreateKeyset)) {
    CreateKeysetRequest decoded{};
    return DecodeCreateKeysetRequest(request.body, request.body_length, &decoded) &&
           BytesEqual(decoded.operation_id.data(), request.operation_id.data(), 16U) &&
           BytesEqual(
               decoded.expected_state_sha256.data(),
               request.expected_state_sha256.data(),
               32U);
  }
  if (request.opcode ==
      static_cast<std::uint8_t>(Opcode::SignAdmissionEvidence)) {
    SignAdmissionEvidenceRequest decoded{};
    return DecodeSignAdmissionEvidenceRequest(
               request.body, request.body_length, &decoded) &&
           BytesEqual(
               decoded.operation_id.data(), request.operation_id.data(), 16U) &&
           BytesEqual(
               decoded.expected_state_sha256.data(),
               request.expected_state_sha256.data(),
               32U);
  }
  if (request.opcode ==
      static_cast<std::uint8_t>(Opcode::SignRuntimePopV2)) {
    SignRuntimePopV2Request decoded{};
    return DecodeSignRuntimePopV2CallerRequest(
               request.body, request.body_length, &decoded) &&
           IsAllZero(request.operation_id.data(), request.operation_id.size()) &&
           BytesEqual(
               decoded.expected_state_sha256.data(),
               request.expected_state_sha256.data(),
               32U);
  }
  if (request.opcode == static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset)) {
    RevokeKeysetRequest decoded{};
    return DecodeRevokeKeysetRequest(request.body, request.body_length, &decoded) &&
           BytesEqual(decoded.operation_id.data(), request.operation_id.data(), 16U) &&
           BytesEqual(
               decoded.expected_state_sha256.data(),
               request.expected_state_sha256.data(),
               32U);
  }
  return IsRecognizedOpcode(request.opcode);
}

bool IsConsistentBoundError(
    std::uint8_t opcode,
    GcpaErrorCode error_code) noexcept {
  if (error_code == GcpaErrorCode::IoFailed) {
    return true;
  }
  if (opcode == static_cast<std::uint8_t>(Opcode::Inspect)) {
    return false;
  }
  if (opcode == static_cast<std::uint8_t>(Opcode::CreateKeyset) ||
      opcode == static_cast<std::uint8_t>(Opcode::SignAdmissionEvidence) ||
      opcode == static_cast<std::uint8_t>(Opcode::SignRuntimePopV2) ||
      opcode == static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset)) {
    return false;
  }
  return IsRecognizedOpcode(opcode) &&
         error_code == GcpaErrorCode::OperationUnavailable;
}

}  // namespace

ClientExchangeDisposition RunProtectedClientExchange(
    const ClientExchangeRequest& request,
    ClientExchangeResponse* response) noexcept {
  if (response == nullptr || !IsRecognizedOpcode(request.opcode) ||
      request.body_length > kOrdinaryMaximumBytes ||
      (request.body_length != 0U && request.body == nullptr) ||
      !IsExactProtectedRequest(request) ||
      InterlockedCompareExchange(&g_client_exchange_held, 1, 0) != 0) {
    return ClientExchangeDisposition::TransportFailure;
  }
  *response = ClientExchangeResponse{};
  ClientExchangeScope scope;
  if (!ProveNoAmbientThreadToken() || !ResolveSystemVolume(&scope.layout_) ||
      !CompleteProtectedLayout(&scope.layout_) ||
      !OpenProtectedClientPipe(&scope.pipe_) ||
      !AuthenticateServerBeforeHello(
          scope.pipe_.get(),
          &scope.layout_,
          &scope.server_,
          &scope.client_)) {
    return ClientExchangeDisposition::TransportFailure;
  }

  Byte32 client_nonce{};
  Byte16 operation_id{};
  std::array<std::uint8_t, kSignRuntimePopV2RequestBytes> bound_pop_v2_body{};
  const std::uint8_t* bound_body = request.body;
  if (!GenerateRandom32(&client_nonce)) {
    return ClientExchangeDisposition::TransportFailure;
  }
  if (request.opcode == static_cast<std::uint8_t>(Opcode::Inspect)) {
    if (!GenerateRandom16(&operation_id)) {
      return ClientExchangeDisposition::TransportFailure;
    }
  } else if (
      request.opcode == static_cast<std::uint8_t>(Opcode::SignRuntimePopV2)) {
    std::memcpy(
        bound_pop_v2_body.data(), request.body, bound_pop_v2_body.size());
    SignRuntimePopV2Request caller_request{};
    if (!DecodeSignRuntimePopV2CallerRequest(
            bound_pop_v2_body.data(),
            bound_pop_v2_body.size(),
            &caller_request)) {
      return ClientExchangeDisposition::TransportFailure;
    }
    if (!DeriveRuntimePopV2OperationId(
            scope.client_.token_projection.user.bytes.data(),
            scope.client_.token_projection.user.length,
            caller_request.expected_state_sha256,
            caller_request.expected_generation,
            caller_request.expected_keyset_receipt_sha256,
            caller_request.preimage.data(),
            caller_request.preimage.size(),
            &operation_id)) {
      return ClientExchangeDisposition::TransportFailure;
    }
    std::memcpy(
        bound_pop_v2_body.data(), operation_id.data(), operation_id.size());
    SignRuntimePopV2Request normalized{};
    if (!DecodeSignRuntimePopV2Request(
            bound_pop_v2_body.data(), bound_pop_v2_body.size(), &normalized) ||
        normalized.operation_id != operation_id) {
      return ClientExchangeDisposition::TransportFailure;
    }
    bound_body = bound_pop_v2_body.data();
  } else {
    operation_id = request.operation_id;
  }
  const std::uint64_t work_deadline =
      AddDeadline(GetTickCount64(), kClientWorkMilliseconds);
  std::array<std::uint8_t, kGcpaHeaderBytes + kGcpaServerHelloPayloadBytes>
      hello_frame{};
  std::size_t frame_length = 0U;
  if (!EncodeGcpaClientHello(
          client_nonce,
          hello_frame.data(),
          hello_frame.size(),
          &frame_length) ||
      OverlappedWriteMessage(
          scope.pipe_.get(),
          hello_frame.data(),
          frame_length,
          nullptr,
          work_deadline,
          true) != IoResult::Success) {
    return ClientExchangeDisposition::TransportFailure;
  }

  frame_length = 0U;
  if (!ReadFrozenClientMessage(
          scope.pipe_.get(),
          hello_frame.data(),
          hello_frame.size(),
          work_deadline,
          &frame_length)) {
    return ClientExchangeDisposition::TransportFailure;
  }
  GcpaServerHelloFields server_hello{};
  if (!DecodeGcpaServerHello(
          hello_frame.data(), frame_length, &server_hello) ||
      !BytesEqual(
          server_hello.client_nonce.data(),
          client_nonce.data(),
          client_nonce.size()) ||
      BytesEqual(
          server_hello.service_start_nonce.data(),
          server_hello.connection_nonce.data(),
          server_hello.service_start_nonce.size()) ||
      BytesEqual(
          server_hello.service_start_nonce.data(),
          client_nonce.data(),
          client_nonce.size()) ||
      BytesEqual(
          server_hello.connection_nonce.data(),
          client_nonce.data(),
          client_nonce.size())) {
    return ClientExchangeDisposition::TransportFailure;
  }

  Byte32 body_hash{};
  Byte32 expected_state = request.expected_state_sha256;
  if (!ComputeSha256(bound_body, request.body_length, &body_hash)) {
    return ClientExchangeDisposition::TransportFailure;
  }
  GcpaClientRequestFields gcpa_request{};
  gcpa_request.service_start_nonce = server_hello.service_start_nonce;
  gcpa_request.connection_nonce = server_hello.connection_nonce;
  gcpa_request.client_nonce = client_nonce;
  gcpa_request.operation_id = operation_id;
  gcpa_request.opcode = request.opcode;
  gcpa_request.schema = kGcpaSchema;
  gcpa_request.body_length = request.body_length;
  gcpa_request.body_sha256 = body_hash;
  gcpa_request.expected_state_sha256 = expected_state;
  gcpa_request.body = bound_body;

  Byte32 binding{};
  AuthenticatedRequestBindingInput binding_input{};
  binding_input.service_image = &scope.layout_.service_projection;
  binding_input.client_image = &scope.layout_.client_projection;
  binding_input.client_primary = &scope.client_.token_projection;
  binding_input.pipe_identification = &scope.client_.token_projection;
  binding_input.service_pid = scope.server_.pid;
  binding_input.service_creation_file_time = scope.server_.creation_file_time;
  binding_input.client_pid = GetCurrentProcessId();
  binding_input.client_creation_file_time = scope.client_.creation_file_time;
  binding_input.service_start_nonce = &server_hello.service_start_nonce;
  binding_input.connection_nonce = &server_hello.connection_nonce;
  binding_input.client_nonce = &client_nonce;
  binding_input.operation_id = &operation_id;
  binding_input.opcode = request.opcode;
  binding_input.schema = kGcpaSchema;
  binding_input.body_sha256 = &body_hash;
  binding_input.expected_state_sha256 = &expected_state;
  if (!ComputeAuthenticatedRequestBinding(binding_input, &binding) ||
      !EncodeGcpaClientRequest(
          gcpa_request,
          g_client_frame.data(),
          g_client_frame.size(),
          &frame_length) ||
      OverlappedWriteMessage(
          scope.pipe_.get(),
          g_client_frame.data(),
          frame_length,
          nullptr,
          work_deadline,
          true) != IoResult::Success) {
    return ClientExchangeDisposition::TransportFailure;
  }

  frame_length = 0U;
  if (!ReadFrozenClientMessage(
          scope.pipe_.get(),
          g_client_frame.data(),
          kGcpaMaximumResponseFrameBytes,
          work_deadline,
          &frame_length)) {
    return ClientExchangeDisposition::TransportFailure;
  }
  GcpaServerResponseFields server_response{};
  if (!DecodeGcpaServerResponse(
          g_client_frame.data(), frame_length, &server_response) ||
      !BytesEqual(
          server_response.operation_id.data(),
          operation_id.data(),
          operation_id.size()) ||
      !BytesEqual(
          server_response.authenticated_request_binding.data(),
          binding.data(),
          binding.size()) ||
      !RefreshServiceEvidenceMatches(
          scope.server_, scope.layout_.service_path_dos) ||
      !RevalidateHeldLayout(scope.layout_) ||
      !PipeHasNoBufferedBytes(scope.pipe_.get())) {
    return ClientExchangeDisposition::TransportFailure;
  }

  if (server_response.kind == GcpaKind::ServerResult) {
    const bool exact_result =
        (request.opcode == static_cast<std::uint8_t>(Opcode::Inspect) &&
         ExpectedInspectResult(server_response.result, server_response.result_length)) ||
        (request.opcode == static_cast<std::uint8_t>(Opcode::CreateKeyset) &&
         server_response.result_length == kCreateKeysetResultBytes) ||
        (request.opcode ==
             static_cast<std::uint8_t>(Opcode::SignAdmissionEvidence) &&
         server_response.result_length == kSignAdmissionEvidenceResultBytes) ||
        (request.opcode ==
             static_cast<std::uint8_t>(Opcode::SignRuntimePopV2) &&
         server_response.result_length == kSignRuntimePopV2ResultBytes) ||
        (request.opcode == static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset) &&
         server_response.result_length == kRevokeKeysetResultBytes);
    if (!exact_result) {
      return ClientExchangeDisposition::TransportFailure;
    }
    response->disposition = ClientExchangeDisposition::Success;
    response->result_length = server_response.result_length;
    std::memcpy(
        response->result.data(),
        server_response.result,
        server_response.result_length);
    return response->disposition;
  }
  if (server_response.kind != GcpaKind::Error ||
      !IsConsistentBoundError(request.opcode, server_response.error_code)) {
    return ClientExchangeDisposition::TransportFailure;
  }
  switch (server_response.error_code) {
    case GcpaErrorCode::ProtocolInvalid:
      response->disposition = ClientExchangeDisposition::ProtocolInvalid;
      break;
    case GcpaErrorCode::OperationUnavailable:
      response->disposition = ClientExchangeDisposition::OperationUnavailable;
      break;
    case GcpaErrorCode::IoFailed:
      response->disposition = ClientExchangeDisposition::IoFailed;
      break;
  }
  return response->disposition;
}

}  // namespace goatcitadel::remote_worker_provisioner
