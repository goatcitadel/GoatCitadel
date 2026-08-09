#include "operation_journal.hpp"

#include "protocol.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace goatcitadel::remote_worker_provisioner {
namespace {

constexpr char kRecordDomain[] =
    "goatcitadel.remote-worker.provisioner.journal-record.v1";
constexpr char kOperationDomain[] =
    "goatcitadel.remote-worker.provisioner.operation.v2";

void WriteU16(std::uint8_t* bytes, std::uint16_t value) noexcept {
  bytes[0] = static_cast<std::uint8_t>(value & 0xffU);
  bytes[1] = static_cast<std::uint8_t>((value >> 8U) & 0xffU);
}
void WriteU32(std::uint8_t* bytes, std::uint32_t value) noexcept {
  for (std::size_t index = 0U; index < 4U; ++index) {
    bytes[index] = static_cast<std::uint8_t>((value >> (index * 8U)) & 0xffU);
  }
}
void WriteU64(std::uint8_t* bytes, std::uint64_t value) noexcept {
  for (std::size_t index = 0U; index < 8U; ++index) {
    bytes[index] = static_cast<std::uint8_t>((value >> (index * 8U)) & UINT64_C(0xff));
  }
}
std::uint16_t ReadU16(const std::uint8_t* bytes) noexcept {
  return static_cast<std::uint16_t>(bytes[0]) |
         static_cast<std::uint16_t>(bytes[1] << 8U);
}
std::uint32_t ReadU32(const std::uint8_t* bytes) noexcept {
  std::uint32_t value = 0U;
  for (std::size_t index = 0U; index < 4U; ++index) {
    value |= static_cast<std::uint32_t>(bytes[index]) << (index * 8U);
  }
  return value;
}
bool Equal(const std::uint8_t* left, const std::uint8_t* right, std::size_t length) noexcept {
  if (left == nullptr || right == nullptr) return false;
  std::uint8_t difference = 0U;
  for (std::size_t index = 0U; index < length; ++index) {
    difference = static_cast<std::uint8_t>(difference | (left[index] ^ right[index]));
  }
  return difference == 0U;
}
bool AllZero(const std::uint8_t* bytes, std::size_t length) noexcept {
  if (bytes == nullptr) return false;
  std::uint8_t aggregate = 0U;
  for (std::size_t index = 0U; index < length; ++index) aggregate = static_cast<std::uint8_t>(aggregate | bytes[index]);
  return aggregate == 0U;
}
bool HashDomain(
    const char* domain,
    std::size_t domain_length,
    const std::uint8_t* bytes,
    std::size_t length,
    Byte32* output) noexcept {
  if (domain == nullptr || bytes == nullptr || output == nullptr ||
      domain_length + 1U + length > 1200U) return false;
  std::array<std::uint8_t, 1200U> projection{};
  std::memcpy(projection.data(), domain, domain_length);
  projection[domain_length] = 0U;
  std::memcpy(projection.data() + domain_length + 1U, bytes, length);
  return ComputeSha256(projection.data(), domain_length + 1U + length, output);
}
bool ComputeRecordHash(const JournalRecord& record, Byte32* output) noexcept {
  return HashDomain(
      kRecordDomain,
      sizeof(kRecordDomain) - 1U,
      record.bytes.data(),
      992U,
      output);
}
bool KindValid(std::uint8_t kind) noexcept {
  return kind >= static_cast<std::uint8_t>(JournalRecordKind::Prepared) &&
         kind <= static_cast<std::uint8_t>(JournalRecordKind::Quarantined);
}
bool RequestProjectionValid(const JournalRecord& record) noexcept {
  const auto& bytes = record.bytes;
  const std::uint16_t sid_length = ReadU16(bytes.data() + 36U);
  const std::uint16_t body_length = ReadU16(bytes.data() + 38U);
  if (AllZero(bytes.data() + 16U, 16U) || bytes[33] != 1U ||
      sid_length == 0U || sid_length > kMaximumJournalOperatorSidBytes ||
      body_length == 0U || body_length > kMaximumJournalRequestBytes ||
      !AllZero(bytes.data() + 40U + sid_length, 68U - sid_length) ||
      !AllZero(bytes.data() + 112U + body_length, 128U - body_length) ||
      AllZero(bytes.data() + 272U, 32U) || AllZero(bytes.data() + 304U, 32U)) {
    return false;
  }
  if ((bytes[32] == static_cast<std::uint8_t>(Opcode::CreateKeyset) &&
       body_length != kCreateKeysetRequestBytes) ||
      (bytes[32] == static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset) &&
       body_length != kRevokeKeysetRequestBytes) ||
      (bytes[32] != static_cast<std::uint8_t>(Opcode::CreateKeyset) &&
       bytes[32] != static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset))) {
    return false;
  }
  Byte32 body_hash{};
  Byte32 stable_binding{};
  Byte16 operation_id{};
  std::memcpy(operation_id.data(), bytes.data() + 16U, operation_id.size());
  if (!ComputeSha256(bytes.data() + 112U, body_length, &body_hash) ||
      !Equal(body_hash.data(), bytes.data() + 240U, body_hash.size()) ||
      !ComputeStableOperationBinding(
          bytes.data() + 40U,
          sid_length,
          operation_id,
          bytes[32],
          bytes[33],
          bytes.data() + 112U,
          body_length,
          &stable_binding) ||
      !Equal(stable_binding.data(), bytes.data() + 304U, stable_binding.size())) {
    return false;
  }
  return true;
}
bool OutcomeProjectionValid(const JournalRecord& record, JournalRecordKind kind) noexcept {
  const auto& bytes = record.bytes;
  if (kind == JournalRecordKind::Prepared || kind == JournalRecordKind::Attempt) {
    return AllZero(bytes.data() + 400U, 432U);
  }
  const std::uint16_t outcome_kind = ReadU16(bytes.data() + 400U);
  const std::uint16_t disposition = ReadU16(bytes.data() + 402U);
  const std::uint32_t result_length = ReadU32(bytes.data() + 404U);
  const std::uint32_t side_effect_kind = ReadU32(bytes.data() + 408U);
  if (ReadU32(bytes.data() + 412U) != 0U ||
      AllZero(bytes.data() + 416U, 32U) ||
      AllZero(bytes.data() + 448U, 32U) ||
      AllZero(bytes.data() + 480U, 32U)) {
    return false;
  }
  if (kind == JournalRecordKind::Quarantined) {
    return outcome_kind == 3U && disposition >= 1U && disposition <= 3U &&
           result_length == 0U && side_effect_kind == 3U &&
           AllZero(bytes.data() + 512U, 320U);
  }
  if (outcome_kind == 1U) {
    return disposition == 1U && result_length == kCreateKeysetResultBytes &&
           side_effect_kind == 1U && !AllZero(bytes.data() + 512U, 320U);
  }
  if (outcome_kind == 2U) {
    return disposition == 1U && result_length == kRevokeKeysetResultBytes &&
           side_effect_kind == 2U && !AllZero(bytes.data() + 512U, 200U) &&
           AllZero(bytes.data() + 712U, 120U);
  }
  return false;
}

}  // namespace

bool ComputeStableOperationBinding(
    const std::uint8_t* operator_sid,
    std::uint16_t operator_sid_length,
    const Byte16& operation_id,
    std::uint8_t opcode,
    std::uint8_t schema,
    const std::uint8_t* body,
    std::uint32_t body_length,
    Byte32* output) noexcept {
  if (output == nullptr || operator_sid == nullptr ||
      operator_sid_length == 0U || operator_sid_length > kMaximumJournalOperatorSidBytes ||
      body == nullptr || body_length == 0U || body_length > kMaximumJournalRequestBytes ||
      AllZero(operation_id.data(), operation_id.size()) || schema != 1U) {
    return false;
  }
  std::array<std::uint8_t, 256U> projection{};
  std::size_t offset = 0U;
  WriteU16(projection.data() + offset, operator_sid_length);
  offset += 2U;
  std::memcpy(projection.data() + offset, operator_sid, operator_sid_length);
  offset += operator_sid_length;
  std::memcpy(projection.data() + offset, operation_id.data(), operation_id.size());
  offset += operation_id.size();
  projection[offset++] = opcode;
  projection[offset++] = schema;
  WriteU16(projection.data() + offset, 0U);
  offset += 2U;
  WriteU32(projection.data() + offset, body_length);
  offset += 4U;
  std::memcpy(projection.data() + offset, body, body_length);
  offset += body_length;
  return HashDomain(
      kOperationDomain,
      sizeof(kOperationDomain) - 1U,
      projection.data(),
      offset,
      output);
}

bool EncodePreparedJournalRecord(
    const PreparedJournalInput& input,
    JournalRecord* output) noexcept {
  if (output == nullptr || input.operator_sid == nullptr || input.body == nullptr ||
      input.operator_sid_length == 0U ||
      input.operator_sid_length > kMaximumJournalOperatorSidBytes ||
      input.body_length == 0U || input.body_length > kMaximumJournalRequestBytes ||
      input.schema != 1U || AllZero(input.operation_id.data(), 16U) ||
      AllZero(input.expected_state_sha256.data(), 32U) ||
      AllZero(input.stable_binding.data(), 32U) ||
      AllZero(input.authenticated_binding.data(), 32U) ||
      input.publication_sequence == 0U ||
      input.publication_sequence > kMaximumPublicationSequence) {
    return false;
  }
  output->bytes.fill(0U);
  auto& bytes = output->bytes;
  bytes[0] = 'G'; bytes[1] = 'C'; bytes[2] = 'J'; bytes[3] = 'R';
  WriteU16(bytes.data() + 4U, 1U);
  bytes[6] = static_cast<std::uint8_t>(JournalRecordKind::Prepared);
  WriteU32(bytes.data() + 8U, kJournalRecordBytes);
  std::memcpy(bytes.data() + 16U, input.operation_id.data(), 16U);
  bytes[32] = input.opcode;
  bytes[33] = input.schema;
  WriteU16(bytes.data() + 36U, input.operator_sid_length);
  WriteU16(bytes.data() + 38U, input.body_length);
  std::memcpy(bytes.data() + 40U, input.operator_sid, input.operator_sid_length);
  std::memcpy(bytes.data() + 112U, input.body, input.body_length);
  std::memcpy(bytes.data() + 240U, input.body_sha256.data(), 32U);
  std::memcpy(bytes.data() + 272U, input.expected_state_sha256.data(), 32U);
  std::memcpy(bytes.data() + 304U, input.stable_binding.data(), 32U);
  std::memcpy(bytes.data() + 336U, input.authenticated_binding.data(), 32U);
  WriteU64(bytes.data() + 832U, input.creation_file_time);
  WriteU16(bytes.data() + 840U, input.publication_sequence);
  Byte32 hash{};
  if (!ComputeRecordHash(*output, &hash)) {
    output->bytes.fill(0U);
    return false;
  }
  std::memcpy(bytes.data() + 992U, hash.data(), hash.size());
  JournalRecordKind validated_kind{};
  std::uint32_t validated_sequence = 0U;
  Byte32 validated_hash{};
  return ValidateJournalRecord(*output, &validated_kind, &validated_sequence, &validated_hash) &&
         validated_kind == JournalRecordKind::Prepared && validated_sequence == 0U;
}

bool EncodeFollowingJournalRecord(
    JournalRecordKind kind,
    std::uint8_t flags,
    const JournalRecord& prepared,
    const JournalRecord& prior,
    const Byte32* authenticated_binding,
    const std::uint8_t* outcome_bytes,
    std::size_t outcome_length,
    std::uint64_t creation_file_time,
    std::uint16_t publication_sequence,
    JournalRecord* output) noexcept {
  JournalRecordKind prepared_kind{};
  JournalRecordKind prior_kind{};
  std::uint32_t prepared_sequence = 0U;
  std::uint32_t prior_sequence = 0U;
  Byte32 prepared_hash{};
  Byte32 prior_hash{};
  const bool attempt = kind == JournalRecordKind::Attempt;
  if (output == nullptr || kind == JournalRecordKind::Prepared ||
      !ValidateJournalRecord(prepared, &prepared_kind, &prepared_sequence, &prepared_hash) ||
      !ValidateJournalRecord(prior, &prior_kind, &prior_sequence, &prior_hash) ||
      prepared_kind != JournalRecordKind::Prepared || prepared_sequence != 0U ||
      prior_sequence == UINT32_MAX || (flags & ~0x03U) != 0U ||
      publication_sequence == 0U ||
      publication_sequence > kMaximumPublicationSequence ||
      publication_sequence <= ReadU16(prior.bytes.data() + 840U) ||
      (!attempt && flags != 0U) || (attempt && flags == 0x03U) ||
      outcome_length > 432U || (outcome_length != 0U && outcome_bytes == nullptr)) {
    return false;
  }
  const std::uint8_t prior_flags = prior.bytes[7];
  if (attempt) {
    const bool initial = prior_kind == JournalRecordKind::Prepared && flags == 0U &&
                         authenticated_binding != nullptr;
    const bool recovery =
        (prior_kind == JournalRecordKind::Prepared ||
         prior_kind == JournalRecordKind::Attempt ||
         prior_kind == JournalRecordKind::Outcome) &&
        prior_flags != 2U && flags == 1U && authenticated_binding == nullptr;
    const bool replay =
        (prior_kind == JournalRecordKind::Committed ||
         (prior_kind == JournalRecordKind::Attempt && prior_flags == 2U)) &&
        flags == 2U && authenticated_binding != nullptr;
    if ((!initial && !recovery && !replay) || outcome_length != 0U) return false;
  } else if (authenticated_binding != nullptr) {
    return false;
  } else if (kind == JournalRecordKind::Outcome) {
    if (prior_kind != JournalRecordKind::Attempt || prior_flags == 2U || outcome_length != 432U) return false;
  } else if (kind == JournalRecordKind::Committed) {
    if (!((prior_kind == JournalRecordKind::Outcome) ||
          (prior_kind == JournalRecordKind::Attempt && prior_flags == 1U)) ||
        outcome_length != 432U) return false;
    if (prior_kind == JournalRecordKind::Outcome &&
        !Equal(prior.bytes.data() + 400U, outcome_bytes, 432U)) return false;
  } else if (kind == JournalRecordKind::Quarantined) {
    if (prior_kind != JournalRecordKind::Attempt || prior_flags == 2U || outcome_length != 112U) return false;
  }
  output->bytes.fill(0U);
  auto& bytes = output->bytes;
  std::memcpy(bytes.data(), prepared.bytes.data(), 336U);
  bytes[6] = static_cast<std::uint8_t>(kind);
  bytes[7] = flags;
  WriteU32(bytes.data() + 12U, prior_sequence + 1U);
  if (attempt && authenticated_binding != nullptr) {
    std::memcpy(bytes.data() + 336U, authenticated_binding->data(), 32U);
  } else {
    std::memset(bytes.data() + 336U, 0, 32U);
  }
  std::memcpy(bytes.data() + 368U, prior_hash.data(), 32U);
  if (outcome_length != 0U) std::memcpy(bytes.data() + 400U, outcome_bytes, outcome_length);
  WriteU64(bytes.data() + 832U, creation_file_time);
  WriteU16(bytes.data() + 840U, publication_sequence);
  Byte32 hash{};
  if (!ComputeRecordHash(*output, &hash)) {
    output->bytes.fill(0U);
    return false;
  }
  std::memcpy(bytes.data() + 992U, hash.data(), 32U);
  JournalRecordKind validated_kind{};
  std::uint32_t validated_sequence = 0U;
  Byte32 validated_hash{};
  return ValidateJournalRecord(*output, &validated_kind, &validated_sequence, &validated_hash) &&
         validated_kind == kind && validated_sequence == prior_sequence + 1U;
}

bool ValidateJournalRecord(
    const JournalRecord& record,
    JournalRecordKind* kind,
    std::uint32_t* sequence,
    Byte32* record_sha256) noexcept {
  Byte32 hash{};
  const auto& bytes = record.bytes;
  if (kind == nullptr || sequence == nullptr || record_sha256 == nullptr ||
      bytes[0] != 'G' || bytes[1] != 'C' || bytes[2] != 'J' || bytes[3] != 'R' ||
      ReadU16(bytes.data() + 4U) != 1U || !KindValid(bytes[6]) ||
      ReadU32(bytes.data() + 8U) != kJournalRecordBytes ||
      ReadU16(bytes.data() + 34U) != 0U || ReadU32(bytes.data() + 108U) != 0U ||
      ReadU16(bytes.data() + 840U) == 0U ||
      ReadU16(bytes.data() + 840U) > kMaximumPublicationSequence ||
      !AllZero(bytes.data() + 842U, 150U) || !RequestProjectionValid(record) ||
      !ComputeRecordHash(record, &hash) ||
      !Equal(hash.data(), bytes.data() + 992U, 32U)) {
    return false;
  }
  const JournalRecordKind parsed_kind = static_cast<JournalRecordKind>(bytes[6]);
  const std::uint8_t flags = bytes[7];
  const std::uint32_t parsed_sequence = ReadU32(bytes.data() + 12U);
  if (!OutcomeProjectionValid(record, parsed_kind) ||
      (parsed_kind == JournalRecordKind::Prepared &&
       (flags != 0U || parsed_sequence != 0U ||
        AllZero(bytes.data() + 336U, 32U) || !AllZero(bytes.data() + 368U, 32U))) ||
      (parsed_kind == JournalRecordKind::Attempt &&
       ((flags != 0U && flags != 1U && flags != 2U) || parsed_sequence == 0U ||
        ((flags == 1U) != AllZero(bytes.data() + 336U, 32U)) ||
        AllZero(bytes.data() + 368U, 32U))) ||
      (parsed_kind != JournalRecordKind::Prepared &&
       parsed_kind != JournalRecordKind::Attempt &&
       (flags != 0U || parsed_sequence == 0U ||
        !AllZero(bytes.data() + 336U, 32U) || AllZero(bytes.data() + 368U, 32U)))) {
    return false;
  }
  *kind = parsed_kind;
  *sequence = parsed_sequence;
  *record_sha256 = hash;
  return true;
}

bool ValidateJournalTransition(
    const JournalRecord& prepared,
    const JournalRecord& prior,
    const JournalRecord& next) noexcept {
  JournalRecordKind prepared_kind{};
  JournalRecordKind prior_kind{};
  JournalRecordKind next_kind{};
  std::uint32_t prepared_sequence = 0U;
  std::uint32_t prior_sequence = 0U;
  std::uint32_t next_sequence = 0U;
  Byte32 prepared_hash{};
  Byte32 prior_hash{};
  Byte32 next_hash{};
  if (!ValidateJournalRecord(prepared, &prepared_kind, &prepared_sequence, &prepared_hash) ||
      !ValidateJournalRecord(prior, &prior_kind, &prior_sequence, &prior_hash) ||
      !ValidateJournalRecord(next, &next_kind, &next_sequence, &next_hash) ||
      prepared_kind != JournalRecordKind::Prepared || prepared_sequence != 0U ||
      next_sequence != prior_sequence + 1U ||
      ReadU16(next.bytes.data() + 840U) <= ReadU16(prior.bytes.data() + 840U) ||
      !Equal(next.bytes.data() + 16U, prepared.bytes.data() + 16U, 320U) ||
      !Equal(next.bytes.data() + 368U, prior_hash.data(), 32U)) {
    return false;
  }
  if (prior_kind == JournalRecordKind::Quarantined || next_kind == JournalRecordKind::Prepared) return false;
  const std::uint8_t prior_flags = prior.bytes[7];
  const std::uint8_t next_flags = next.bytes[7];
  if (prior_kind == JournalRecordKind::Prepared) {
    return next_kind == JournalRecordKind::Attempt &&
           (next_flags == 0U || next_flags == 1U);
  }
  if (prior_kind == JournalRecordKind::Committed ||
      (prior_kind == JournalRecordKind::Attempt && prior_flags == 2U)) {
    return next_kind == JournalRecordKind::Attempt && next_flags == 2U;
  }
  if (prior_kind == JournalRecordKind::Outcome) {
    return (next_kind == JournalRecordKind::Attempt && next_flags == 1U) ||
           next_kind == JournalRecordKind::Committed;
  }
  if (prior_kind == JournalRecordKind::Attempt && prior_flags != 2U) {
    if (next_kind == JournalRecordKind::Attempt) return next_flags == 1U;
    if (next_kind == JournalRecordKind::Outcome || next_kind == JournalRecordKind::Quarantined) {
      return next_flags == 0U;
    }
    return prior_flags == 1U && next_kind == JournalRecordKind::Committed;
  }
  return false;
}

bool GetJournalPublicationSequence(
    const JournalRecord& record,
    std::uint16_t* publication_sequence) noexcept {
  JournalRecordKind kind{};
  std::uint32_t sequence = 0U;
  Byte32 hash{};
  if (publication_sequence == nullptr ||
      !ValidateJournalRecord(record, &kind, &sequence, &hash)) {
    return false;
  }
  *publication_sequence = ReadU16(record.bytes.data() + 840U);
  return true;
}

}  // namespace goatcitadel::remote_worker_provisioner
