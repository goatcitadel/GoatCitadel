#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "local_transport.hpp"

namespace goatcitadel::remote_worker_provisioner {

constexpr std::size_t kJournalRecordBytes = 1024U;
constexpr std::size_t kMaximumJournalRequestBytes = 128U;
constexpr std::size_t kMaximumJournalOperatorSidBytes = 68U;
constexpr std::uint32_t kMaximumJournalAttempts = 16U;
constexpr std::uint16_t kMaximumPublicationSequence = 864U;

enum class JournalRecordKind : std::uint8_t {
  Prepared = 1U,
  Attempt = 2U,
  Outcome = 3U,
  Committed = 4U,
  Quarantined = 5U,
};

struct JournalRecord final {
  std::array<std::uint8_t, kJournalRecordBytes> bytes{};
};

struct PreparedJournalInput final {
  Byte16 operation_id{};
  std::uint8_t opcode = 0U;
  std::uint8_t schema = 1U;
  const std::uint8_t* operator_sid = nullptr;
  std::uint16_t operator_sid_length = 0U;
  const std::uint8_t* body = nullptr;
  std::uint16_t body_length = 0U;
  Byte32 body_sha256{};
  Byte32 expected_state_sha256{};
  Byte32 stable_binding{};
  Byte32 authenticated_binding{};
  std::uint64_t creation_file_time = 0U;
  std::uint16_t publication_sequence = 0U;
};

bool ComputeStableOperationBinding(
    const std::uint8_t* operator_sid,
    std::uint16_t operator_sid_length,
    const Byte16& operation_id,
    std::uint8_t opcode,
    std::uint8_t schema,
    const std::uint8_t* body,
    std::uint32_t body_length,
    Byte32* output) noexcept;
bool EncodePreparedJournalRecord(
    const PreparedJournalInput& input,
    JournalRecord* output) noexcept;
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
    JournalRecord* output) noexcept;
bool ValidateJournalRecord(
    const JournalRecord& record,
    JournalRecordKind* kind,
    std::uint32_t* sequence,
    Byte32* record_sha256) noexcept;
bool GetJournalPublicationSequence(
    const JournalRecord& record,
    std::uint16_t* publication_sequence) noexcept;
bool ValidateJournalTransition(
    const JournalRecord& prepared,
    const JournalRecord& prior,
    const JournalRecord& next) noexcept;

}  // namespace goatcitadel::remote_worker_provisioner
