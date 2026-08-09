#include "protocol.hpp"

#include <limits>

namespace goatcitadel::remote_worker_provisioner {
namespace {

constexpr std::array<std::uint8_t, 4U> kMagic = {'G', 'C', 'P', 'W'};
constexpr std::uint8_t kFlags = 0U;
constexpr std::uint8_t kErrorOpcode = 0x7FU;
constexpr std::uint8_t kSuccessMask = 0x80U;
constexpr char kRemoteWorkerPopV2Domain[] =
    "goatcitadel.remote-worker-pop.v2";
static_assert(sizeof(kRemoteWorkerPopV2Domain) == kRemoteWorkerPopV2DomainBytes);
constexpr std::uint64_t kMaximumSafeInteger = UINT64_C(9007199254740991);

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

std::uint64_t ReadU64Be(const std::uint8_t* bytes) noexcept {
  std::uint64_t value = 0U;
  for (std::size_t index = 0U; index < 8U; ++index) {
    value = (value << 8U) | static_cast<std::uint64_t>(bytes[index]);
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
    bytes[index] = static_cast<std::uint8_t>((value >> (index * 8U)) & UINT64_C(0xFF));
  }
}

void WriteHeader(Response* response, std::uint8_t opcode, std::uint32_t payload_length) noexcept {
  response->bytes[0] = kMagic[0];
  response->bytes[1] = kMagic[1];
  response->bytes[2] = kMagic[2];
  response->bytes[3] = kMagic[3];
  WriteU16(response->bytes.data() + 4U, kProtocolVersion);
  response->bytes[6] = opcode;
  response->bytes[7] = kFlags;
  WriteU32(response->bytes.data() + 8U, kRequestId);
  WriteU32(response->bytes.data() + 12U, payload_length);
}

Response MakeError(ErrorCode code, ExitCode exit_code) noexcept {
  Response response{};
  response.size = kHeaderBytes + kErrorPayloadBytes;
  response.exit_code = exit_code;
  WriteHeader(&response, kErrorOpcode, static_cast<std::uint32_t>(kErrorPayloadBytes));
  WriteU32(response.bytes.data() + kHeaderBytes, static_cast<std::uint32_t>(code));
  return response;
}

Response MakeInspect(std::uint16_t pe_machine) noexcept {
  Response response{};
  response.size = kHeaderBytes + kInspectPayloadBytes;
  response.exit_code = ExitCode::Success;
  WriteHeader(
      &response,
      static_cast<std::uint8_t>(static_cast<std::uint8_t>(Opcode::Inspect) | kSuccessMask),
      static_cast<std::uint32_t>(kInspectPayloadBytes));

  std::uint8_t* payload = response.bytes.data() + kHeaderBytes;
  WriteU16(payload + 0U, 1U);
  WriteU16(payload + 2U, pe_machine);
  WriteU32(payload + 4U, kOrdinaryMaximumBytes);
  WriteU32(payload + 8U, kSecretMaximumBytes);
  WriteU32(payload + 12U, 0U);
  WriteU64(payload + 16U, kRecognizedOpcodeBitmap);
  WriteU64(payload + 24U, kCallableOpcodeBitmap);
  return response;
}

bool HasExactMagic(const std::uint8_t* bytes) noexcept {
  return bytes[0] == kMagic[0] && bytes[1] == kMagic[1] && bytes[2] == kMagic[2] &&
         bytes[3] == kMagic[3];
}

bool AllZero(const std::uint8_t* bytes, std::size_t length) noexcept {
  if (bytes == nullptr) {
    return length == 0U;
  }
  std::uint8_t aggregate = 0U;
  for (std::size_t index = 0U; index < length; ++index) {
    aggregate = static_cast<std::uint8_t>(aggregate | bytes[index]);
  }
  return aggregate == 0U;
}

bool DecodeRemoteWorkerPopV2Preimage(
    const std::uint8_t* bytes,
    std::size_t length,
    RemoteWorkerPopV2Material* material) noexcept {
  if (material == nullptr) return false;
  *material = RemoteWorkerPopV2Material{};
  if (bytes == nullptr || length != kRemoteWorkerPopV2PreimageBytes) {
    return false;
  }
  for (std::size_t index = 0U; index < kRemoteWorkerPopV2DomainBytes;
       ++index) {
    if (bytes[index] != static_cast<std::uint8_t>(
                            kRemoteWorkerPopV2Domain[index])) {
      return false;
    }
  }
  const std::size_t fixed = kRemoteWorkerPopV2DomainBytes;
  const std::uint8_t route_code = bytes[fixed + 2U];
  const std::uint8_t authority_kind_code = bytes[fixed + 3U];
  const std::uint8_t expected_authority_kind =
      route_code == 1U ? 1U : route_code >= 2U && route_code <= 10U ? 2U : 0U;
  const std::uint64_t authority_generation = ReadU64Be(bytes + fixed + 4U);
  const std::uint64_t worker_generation = ReadU64Be(bytes + fixed + 12U);
  const std::uint64_t timestamp_epoch_ms = ReadU64Be(bytes + fixed + 20U);
  if (bytes[fixed] != 2U || bytes[fixed + 1U] != 1U ||
      expected_authority_kind == 0U ||
      authority_kind_code != expected_authority_kind ||
      authority_generation == 0U ||
      authority_generation > kMaximumSafeInteger || worker_generation == 0U ||
      worker_generation > kMaximumSafeInteger ||
      timestamp_epoch_ms > kMaximumSafeInteger) {
    return false;
  }
  material->route_code = route_code;
  material->authority_kind_code = authority_kind_code;
  material->authority_generation = authority_generation;
  material->worker_generation = worker_generation;
  material->timestamp_epoch_ms = timestamp_epoch_ms;
  constexpr std::size_t kWorkerSpkiHashOffset =
      kRemoteWorkerPopV2DomainBytes + 28U + 4U * 32U;
  for (std::size_t index = 0U;
       index < material->worker_public_key_spki_sha256.size();
       ++index) {
    material->worker_public_key_spki_sha256[index] =
        bytes[kWorkerSpkiHashOffset + index];
  }
  return true;
}

}  // namespace

bool DecodeCreateKeysetRequest(
    const std::uint8_t* bytes,
    std::size_t length,
    CreateKeysetRequest* request) noexcept {
  if (request == nullptr) {
    return false;
  }
  *request = CreateKeysetRequest{};
  if (bytes == nullptr || length != kCreateKeysetRequestBytes ||
      AllZero(bytes, 16U) || AllZero(bytes + 16U, 32U) ||
      ReadU16(bytes + 48U) != 1U || ReadU16(bytes + 50U) != 0U ||
      ReadU64(bytes + 52U) == 0U || ReadU32(bytes + 68U) != 0U) {
    return false;
  }
  for (std::size_t index = 0U; index < 16U; ++index) {
    request->operation_id[index] = bytes[index];
  }
  for (std::size_t index = 0U; index < 32U; ++index) {
    request->expected_state_sha256[index] = bytes[16U + index];
  }
  request->requested_generation = ReadU64(bytes + 52U);
  request->predecessor_generation = ReadU64(bytes + 60U);
  return true;
}

bool DecodeRevokeKeysetRequest(
    const std::uint8_t* bytes,
    std::size_t length,
    RevokeKeysetRequest* request) noexcept {
  if (request == nullptr) {
    return false;
  }
  *request = RevokeKeysetRequest{};
  if (bytes == nullptr || length != kRevokeKeysetRequestBytes ||
      AllZero(bytes, 16U) || AllZero(bytes + 16U, 32U) ||
      ReadU16(bytes + 48U) != 1U || ReadU16(bytes + 50U) != 0U ||
      ReadU64(bytes + 52U) == 0U || ReadU32(bytes + 64U) != 0U ||
      AllZero(bytes + 68U, 32U)) {
    return false;
  }
  const std::uint32_t reason = ReadU32(bytes + 60U);
  if (reason < 1U || reason > 3U) {
    return false;
  }
  for (std::size_t index = 0U; index < 16U; ++index) {
    request->operation_id[index] = bytes[index];
  }
  for (std::size_t index = 0U; index < 32U; ++index) {
    request->expected_state_sha256[index] = bytes[16U + index];
    request->expected_receipt_sha256[index] = bytes[68U + index];
  }
  request->generation = ReadU64(bytes + 52U);
  request->reason = reason;
  return true;
}

bool DecodeAdmissionEvidenceEnvelope(
    const std::uint8_t* bytes,
    std::size_t length,
    AdmissionEvidenceEnvelope* envelope) noexcept {
  if (envelope == nullptr) return false;
  *envelope = AdmissionEvidenceEnvelope{};
  if (bytes == nullptr || length != kAdmissionEvidenceEnvelopeBytes ||
      bytes[0] != 'G' || bytes[1] != 'C' || bytes[2] != 'A' ||
      bytes[3] != 'E' || ReadU16(bytes + 4U) != 1U || bytes[6] != 1U ||
      bytes[7] != 0U || ReadU32(bytes + 8U) != length ||
      ReadU32(bytes + 12U) != 0U || AllZero(bytes + 16U, 16U) ||
      AllZero(bytes + 32U, 32U) || ReadU64(bytes + 64U) == 0U ||
      !AllZero(bytes + 72U, 24U)) {
    return false;
  }
  constexpr std::array<std::size_t, 6U> kHashOffsets = {
      96U, 128U, 160U, 192U, 224U, 256U};
  for (const std::size_t offset : kHashOffsets) {
    if (AllZero(bytes + offset, 32U)) return false;
  }
  for (std::size_t index = 0U; index < envelope->operation_id.size(); ++index) {
    envelope->operation_id[index] = bytes[16U + index];
  }
  for (std::size_t index = 0U; index < 32U; ++index) {
    envelope->evidence_nonce_sha256[index] = bytes[32U + index];
    envelope->context_sha256[index] = bytes[96U + index];
    envelope->runtime_manifest_sha256[index] = bytes[128U + index];
    envelope->worker_public_key_spki_sha256[index] = bytes[160U + index];
    envelope->download_verification_receipt_sha256[index] =
        bytes[192U + index];
    envelope->installed_tree_attestation_sha256[index] =
        bytes[224U + index];
    envelope->installed_tree_verification_receipt_sha256[index] =
        bytes[256U + index];
  }
  envelope->worker_generation = ReadU64(bytes + 64U);
  return true;
}

bool DecodeSignAdmissionEvidenceRequest(
    const std::uint8_t* bytes,
    std::size_t length,
    SignAdmissionEvidenceRequest* request) noexcept {
  if (request == nullptr) return false;
  *request = SignAdmissionEvidenceRequest{};
  if (bytes == nullptr || length != kSignAdmissionEvidenceRequestBytes ||
      AllZero(bytes, 16U) || AllZero(bytes + 16U, 32U) ||
      ReadU16(bytes + 48U) != 1U || bytes[50U] != 2U ||
      bytes[51U] != 0U || ReadU64(bytes + 52U) == 0U ||
      AllZero(bytes + 60U, 32U) ||
      ReadU32(bytes + 92U) != kAdmissionEvidenceEnvelopeBytes ||
      !DecodeAdmissionEvidenceEnvelope(
          bytes + 96U, kAdmissionEvidenceEnvelopeBytes, &request->envelope)) {
    return false;
  }
  for (std::size_t index = 0U; index < request->operation_id.size(); ++index) {
    request->operation_id[index] = bytes[index];
  }
  for (std::size_t index = 0U; index < 32U; ++index) {
    request->expected_state_sha256[index] = bytes[16U + index];
    request->expected_keyset_receipt_sha256[index] = bytes[60U + index];
  }
  request->expected_generation = ReadU64(bytes + 52U);
  if (request->operation_id == request->envelope.operation_id &&
      request->expected_generation == request->envelope.worker_generation) {
    return true;
  }
  *request = SignAdmissionEvidenceRequest{};
  return false;
}

bool DecodeSignRuntimePopV2RequestCore(
    const std::uint8_t* bytes,
    std::size_t length,
    bool caller_placeholder,
    SignRuntimePopV2Request* request) noexcept {
  if (request == nullptr) return false;
  *request = SignRuntimePopV2Request{};
  RemoteWorkerPopV2Material material{};
  if (bytes == nullptr || length != kSignRuntimePopV2RequestBytes ||
      (caller_placeholder ? !AllZero(bytes, 16U) : AllZero(bytes, 16U)) ||
      AllZero(bytes + 16U, 32U) ||
      ReadU16(bytes + 48U) != 1U || bytes[50U] != 3U ||
      bytes[51U] != 0U || ReadU64(bytes + 52U) == 0U ||
      ReadU64(bytes + 52U) > kMaximumSafeInteger ||
      AllZero(bytes + 60U, 32U) ||
      ReadU32(bytes + 92U) != kRemoteWorkerPopV2PreimageBytes ||
      !DecodeRemoteWorkerPopV2Preimage(
          bytes + 96U, kRemoteWorkerPopV2PreimageBytes, &material) ||
      material.worker_generation != ReadU64(bytes + 52U) ||
      !AllZero(
          bytes + 96U + kRemoteWorkerPopV2PreimageBytes,
          kSignRuntimePopV2RequestBytes - 96U -
              kRemoteWorkerPopV2PreimageBytes)) {
    return false;
  }
  for (std::size_t index = 0U; index < request->operation_id.size();
       ++index) {
    request->operation_id[index] = bytes[index];
  }
  for (std::size_t index = 0U; index < 32U; ++index) {
    request->expected_state_sha256[index] = bytes[16U + index];
    request->expected_keyset_receipt_sha256[index] = bytes[60U + index];
  }
  request->expected_generation = ReadU64(bytes + 52U);
  for (std::size_t index = 0U; index < request->preimage.size(); ++index) {
    request->preimage[index] = bytes[96U + index];
  }
  request->material = material;
  return true;
}

bool DecodeSignRuntimePopV2Request(
    const std::uint8_t* bytes,
    std::size_t length,
    SignRuntimePopV2Request* request) noexcept {
  return DecodeSignRuntimePopV2RequestCore(bytes, length, false, request);
}

bool DecodeSignRuntimePopV2CallerRequest(
    const std::uint8_t* bytes,
    std::size_t length,
    SignRuntimePopV2Request* request) noexcept {
  return DecodeSignRuntimePopV2RequestCore(bytes, length, true, request);
}

bool EncodeProtectedInspectResult(
    std::uint16_t pe_machine,
    const std::uint8_t* custody_projection,
    std::size_t custody_projection_length,
    std::array<std::uint8_t, kProtectedInspectPayloadBytes>* output) noexcept {
  if (output == nullptr || custody_projection == nullptr ||
      custody_projection_length != kProtectedInspectPayloadBytes - kInspectPayloadBytes ||
      (pe_machine != kMachineX64 && pe_machine != kMachineArm64)) {
    return false;
  }
  output->fill(0U);
  const Response direct = MakeInspect(pe_machine);
  if (direct.size != kHeaderBytes + kInspectPayloadBytes) {
    return false;
  }
  for (std::size_t index = 0U; index < kInspectPayloadBytes; ++index) {
    (*output)[index] = direct.bytes[kHeaderBytes + index];
  }
  for (std::size_t index = 0U; index < custody_projection_length; ++index) {
    (*output)[kInspectPayloadBytes + index] = custody_projection[index];
  }
  if (ReadU16(output->data() + 32U) != 1U ||
      ReadU64(output->data() + 40U) != kProtectedCallableOpcodeBitmap) {
    output->fill(0U);
    return false;
  }
  return true;
}

bool IsRecognizedOpcode(std::uint8_t opcode) noexcept {
  switch (static_cast<Opcode>(opcode)) {
    case Opcode::Inspect:
    case Opcode::CreateKeyset:
    case Opcode::AcquireKeyForSigning:
    case Opcode::SignAdmissionEvidence:
    case Opcode::RevokeLocalKeyset:
    case Opcode::SignRuntimePopV2:
    case Opcode::BeginInstall:
    case Opcode::SealAndPublishInstall:
    case Opcode::AbandonToQuarantine:
    case Opcode::RunKeyInitService:
    case Opcode::PublishCertAndFinalizeDisabled:
    case Opcode::InspectFinal:
      return true;
  }
  return false;
}

HeaderStatus ParseHeader(
    const std::uint8_t* bytes,
    std::size_t length,
    RequestHeader* header) noexcept {
  if (header == nullptr) {
    return HeaderStatus::ProtocolInvalid;
  }
  *header = RequestHeader{};
  if (bytes == nullptr || length < kHeaderBytes) {
    return HeaderStatus::Truncated;
  }

  header->opcode = bytes[6];
  header->payload_length = ReadU32(bytes + 12U);
  if (header->payload_length > kOrdinaryMaximumBytes) {
    return HeaderStatus::PayloadTooLarge;
  }
  if (!HasExactMagic(bytes) || ReadU16(bytes + 4U) != kProtocolVersion || bytes[7] != kFlags ||
      ReadU32(bytes + 8U) != kRequestId) {
    return HeaderStatus::ProtocolInvalid;
  }
  return HeaderStatus::Valid;
}

Response DecideRequest(
    HeaderStatus header_status,
    const RequestHeader& header,
    bool payload_complete,
    bool exact_eof,
    std::uint16_t pe_machine) noexcept {
  if (header_status == HeaderStatus::Truncated || header_status == HeaderStatus::PayloadTooLarge ||
      !payload_complete) {
    return Response{};
  }
  if (!exact_eof || header_status != HeaderStatus::Valid) {
    return MakeError(ErrorCode::ProtocolInvalid, ExitCode::ProtocolInvalid);
  }
  if (pe_machine != kMachineX64 && pe_machine != kMachineArm64) {
    return MakeError(ErrorCode::ProtocolInvalid, ExitCode::ProtocolInvalid);
  }
  if (header.opcode == static_cast<std::uint8_t>(Opcode::Inspect)) {
    if (header.payload_length != 0U) {
      return MakeError(ErrorCode::ProtocolInvalid, ExitCode::ProtocolInvalid);
    }
    return MakeInspect(pe_machine);
  }
  if (IsRecognizedOpcode(header.opcode)) {
    return MakeError(ErrorCode::OperationUnavailable, ExitCode::OperationUnavailable);
  }
  return MakeError(ErrorCode::ProtocolInvalid, ExitCode::ProtocolInvalid);
}

Response ProcessBuffer(
    const std::uint8_t* bytes,
    std::size_t length,
    std::uint16_t pe_machine) noexcept {
  RequestHeader header{};
  const HeaderStatus status = ParseHeader(bytes, length, &header);
  if (status == HeaderStatus::Truncated || status == HeaderStatus::PayloadTooLarge) {
    return Response{};
  }
  const std::size_t expected_length =
      kHeaderBytes + static_cast<std::size_t>(header.payload_length);
  const bool payload_complete = length >= expected_length;
  const bool exact_eof = length == expected_length;
  return DecideRequest(status, header, payload_complete, exact_eof, pe_machine);
}

}  // namespace goatcitadel::remote_worker_provisioner
