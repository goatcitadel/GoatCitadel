#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace goatcitadel::remote_worker_provisioner {

constexpr std::size_t kHeaderBytes = 16U;
constexpr std::size_t kInspectPayloadBytes = 32U;
constexpr std::size_t kErrorPayloadBytes = 4U;
constexpr std::size_t kMaximumResponseBytes = kHeaderBytes + kInspectPayloadBytes;
constexpr std::uint32_t kOrdinaryMaximumBytes = 2U * 1024U * 1024U;
constexpr std::uint32_t kSecretMaximumBytes = 8U * 1024U;
constexpr std::uint16_t kProtocolVersion = 1U;
constexpr std::uint32_t kRequestId = 1U;
constexpr std::uint16_t kMachineX64 = 0x8664U;
constexpr std::uint16_t kMachineArm64 = 0xAA64U;
constexpr std::uint64_t kRecognizedOpcodeBitmap = UINT64_C(0x00070007000F0002);
constexpr std::uint64_t kCallableOpcodeBitmap = UINT64_C(0x0000000000000002);
constexpr std::uint64_t kProtectedCallableOpcodeBitmap = UINT64_C(0x00000000000D0002);
constexpr std::size_t kProtectedInspectPayloadBytes = 320U;
constexpr std::size_t kCreateKeysetRequestBytes = 72U;
constexpr std::size_t kCreateKeysetResultBytes = 320U;
constexpr std::size_t kRevokeKeysetRequestBytes = 100U;
constexpr std::size_t kRevokeKeysetResultBytes = 200U;
constexpr std::size_t kAdmissionEvidenceEnvelopeBytes = 288U;
constexpr std::size_t kSignAdmissionEvidenceRequestBytes = 384U;
constexpr std::size_t kSignAdmissionEvidenceResultBytes = 320U;

enum class Opcode : std::uint8_t {
  Inspect = 0x01U,
  CreateKeyset = 0x10U,
  AcquireKeyForSigning = 0x11U,
  SignAdmissionEvidence = 0x12U,
  RevokeLocalKeyset = 0x13U,
  BeginInstall = 0x20U,
  SealAndPublishInstall = 0x21U,
  AbandonToQuarantine = 0x22U,
  RunKeyInitService = 0x30U,
  PublishCertAndFinalizeDisabled = 0x31U,
  InspectFinal = 0x32U,
};

enum class ErrorCode : std::uint32_t {
  ProtocolInvalid = 1U,
  OperationUnavailable = 2U,
  IoFailed = 3U,
};

enum class ExitCode : int {
  Success = 0,
  Usage = 2,
  ProtocolInvalid = 3,
  OperationUnavailable = 4,
  IoFailed = 5,
};

enum class HeaderStatus : std::uint8_t {
  Valid,
  Truncated,
  ProtocolInvalid,
  PayloadTooLarge,
};

struct RequestHeader final {
  std::uint8_t opcode = 0U;
  std::uint32_t payload_length = 0U;
};

struct Response final {
  std::array<std::uint8_t, kMaximumResponseBytes> bytes{};
  std::size_t size = 0U;
  ExitCode exit_code = ExitCode::ProtocolInvalid;
};

struct CreateKeysetRequest final {
  std::array<std::uint8_t, 16U> operation_id{};
  std::array<std::uint8_t, 32U> expected_state_sha256{};
  std::uint64_t requested_generation = 0U;
  std::uint64_t predecessor_generation = 0U;
};

struct RevokeKeysetRequest final {
  std::array<std::uint8_t, 16U> operation_id{};
  std::array<std::uint8_t, 32U> expected_state_sha256{};
  std::uint64_t generation = 0U;
  std::uint32_t reason = 0U;
  std::array<std::uint8_t, 32U> expected_receipt_sha256{};
};

struct AdmissionEvidenceEnvelope final {
  std::array<std::uint8_t, 16U> operation_id{};
  std::array<std::uint8_t, 32U> evidence_nonce_sha256{};
  std::uint64_t worker_generation = 0U;
  std::array<std::uint8_t, 32U> context_sha256{};
  std::array<std::uint8_t, 32U> runtime_manifest_sha256{};
  std::array<std::uint8_t, 32U> worker_public_key_spki_sha256{};
  std::array<std::uint8_t, 32U> download_verification_receipt_sha256{};
  std::array<std::uint8_t, 32U> installed_tree_attestation_sha256{};
  std::array<std::uint8_t, 32U>
      installed_tree_verification_receipt_sha256{};
};

struct SignAdmissionEvidenceRequest final {
  std::array<std::uint8_t, 16U> operation_id{};
  std::array<std::uint8_t, 32U> expected_state_sha256{};
  std::uint64_t expected_generation = 0U;
  std::array<std::uint8_t, 32U> expected_keyset_receipt_sha256{};
  AdmissionEvidenceEnvelope envelope{};
};

bool DecodeCreateKeysetRequest(
    const std::uint8_t* bytes,
    std::size_t length,
    CreateKeysetRequest* request) noexcept;
bool DecodeRevokeKeysetRequest(
    const std::uint8_t* bytes,
    std::size_t length,
    RevokeKeysetRequest* request) noexcept;
bool DecodeAdmissionEvidenceEnvelope(
    const std::uint8_t* bytes,
    std::size_t length,
    AdmissionEvidenceEnvelope* envelope) noexcept;
bool DecodeSignAdmissionEvidenceRequest(
    const std::uint8_t* bytes,
    std::size_t length,
    SignAdmissionEvidenceRequest* request) noexcept;
bool EncodeProtectedInspectResult(
    std::uint16_t pe_machine,
    const std::uint8_t* custody_projection,
    std::size_t custody_projection_length,
    std::array<std::uint8_t, kProtectedInspectPayloadBytes>* output) noexcept;

HeaderStatus ParseHeader(
    const std::uint8_t* bytes,
    std::size_t length,
    RequestHeader* header) noexcept;

Response DecideRequest(
    HeaderStatus header_status,
    const RequestHeader& header,
    bool payload_complete,
    bool exact_eof,
    std::uint16_t pe_machine) noexcept;

Response ProcessBuffer(
    const std::uint8_t* bytes,
    std::size_t length,
    std::uint16_t pe_machine) noexcept;

bool IsRecognizedOpcode(std::uint8_t opcode) noexcept;

}  // namespace goatcitadel::remote_worker_provisioner
