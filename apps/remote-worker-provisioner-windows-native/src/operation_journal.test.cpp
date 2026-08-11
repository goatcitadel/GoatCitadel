#include "operation_journal.hpp"

#if defined(GOATCITADEL_PROVISIONER_TESTING)

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>

namespace gc = goatcitadel::remote_worker_provisioner;

namespace {

constexpr char kRecordDomain[] =
    "goatcitadel.remote-worker.provisioner.journal-record.v1";

void WriteU16(std::uint8_t* bytes, std::uint16_t value) noexcept {
  bytes[0] = static_cast<std::uint8_t>(value & 0xffU);
  bytes[1] = static_cast<std::uint8_t>((value >> 8U) & 0xffU);
}

void WriteU32(std::uint8_t* bytes, std::uint32_t value) noexcept {
  for (std::size_t index = 0U; index < 4U; ++index) {
    bytes[index] = static_cast<std::uint8_t>(
        (value >> (index * 8U)) & UINT32_C(0xff));
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

bool AllZero(const std::uint8_t* bytes, std::size_t size) noexcept {
  std::uint8_t aggregate = 0U;
  for (std::size_t index = 0U; index < size; ++index) {
    aggregate = static_cast<std::uint8_t>(aggregate | bytes[index]);
  }
  return aggregate == 0U;
}

bool EqualHex(const gc::Byte32& value, const char* lowercase_hex) noexcept {
  constexpr char kHex[] = "0123456789abcdef";
  for (std::size_t index = 0U; index < value.size(); ++index) {
    if (lowercase_hex[index * 2U] != kHex[value[index] >> 4U] ||
        lowercase_hex[index * 2U + 1U] != kHex[value[index] & 0x0fU]) {
      return false;
    }
  }
  return lowercase_hex[64] == '\0';
}

bool Rehash(gc::JournalRecord* record) noexcept {
  if (record == nullptr) return false;
  std::array<std::uint8_t, 1200U> projection{};
  const std::size_t domain_bytes = sizeof(kRecordDomain);
  std::memcpy(projection.data(), kRecordDomain, domain_bytes);
  std::memcpy(
      projection.data() + domain_bytes,
      record->bytes.data(),
      992U);
  gc::Byte32 digest{};
  if (!gc::ComputeSha256(
          projection.data(), domain_bytes + 992U, &digest)) {
    return false;
  }
  std::memcpy(record->bytes.data() + 992U, digest.data(), digest.size());
  return true;
}

struct Fixture final {
  std::array<std::uint8_t, 12U> sid{};
  std::array<std::uint8_t, 72U> body{};
  gc::PreparedJournalInput input{};
};

Fixture MakeFixture() noexcept {
  Fixture fixture{};
  for (std::size_t index = 0U; index < fixture.sid.size(); ++index) {
    fixture.sid[index] = static_cast<std::uint8_t>(index + 1U);
  }
  for (std::size_t index = 0U; index < fixture.body.size(); ++index) {
    fixture.body[index] = static_cast<std::uint8_t>(0x40U + index);
  }
  for (std::size_t index = 0U; index < fixture.input.operation_id.size(); ++index) {
    fixture.input.operation_id[index] = static_cast<std::uint8_t>(0x10U + index);
  }
  fixture.input.opcode = 0x10U;
  fixture.input.schema = 1U;
  fixture.input.operator_sid = fixture.sid.data();
  fixture.input.operator_sid_length =
      static_cast<std::uint16_t>(fixture.sid.size());
  fixture.input.body = fixture.body.data();
  fixture.input.body_length =
      static_cast<std::uint16_t>(fixture.body.size());
  gc::ComputeSha256(
      fixture.body.data(), fixture.body.size(), &fixture.input.body_sha256);
  fixture.input.expected_state_sha256.fill(0x55U);
  fixture.input.authenticated_binding.fill(0x77U);
  fixture.input.creation_file_time = UINT64_C(0x0102030405060708);
  fixture.input.publication_sequence = 1U;
  gc::ComputeStableOperationBinding(
      fixture.sid.data(),
      static_cast<std::uint16_t>(fixture.sid.size()),
      fixture.input.operation_id,
      fixture.input.opcode,
      fixture.input.schema,
      fixture.body.data(),
      static_cast<std::uint32_t>(fixture.body.size()),
      &fixture.input.stable_binding);
  return fixture;
}

bool RecordValid(const gc::JournalRecord& record) noexcept {
  gc::JournalRecordKind kind{};
  std::uint32_t sequence = UINT32_MAX;
  gc::Byte32 hash{};
  return gc::ValidateJournalRecord(record, &kind, &sequence, &hash);
}

}  // namespace

int RunOperationJournalTests() noexcept {
  int failures = 0;
  const auto Fail = [&](const char* label) {
    std::fprintf(stderr, "FAIL operation_journal: %s\n", label);
    ++failures;
  };
  Fixture fixture = MakeFixture();
  fixture.input.operator_sid = fixture.sid.data();
  fixture.input.body = fixture.body.data();
  if (!EqualHex(
          fixture.input.body_sha256,
          "f0c200f742748a598f295b5ce3a74e0e8ae371f2523f6bd4764505d650d88d79") ||
      !EqualHex(
          fixture.input.stable_binding,
          "8faded3bde67b54d9b3d14408f0ef09e2ecf84519d341fa50d470dd2ce2ac755")) {
    Fail("stable literal vectors");
  }

  gc::JournalRecord prepared{};
  if (!gc::EncodePreparedJournalRecord(fixture.input, &prepared)) return failures + 1;
  gc::JournalRecordKind kind{};
  std::uint32_t sequence = UINT32_MAX;
  gc::Byte32 hash{};
  if (!gc::ValidateJournalRecord(prepared, &kind, &sequence, &hash) ||
      kind != gc::JournalRecordKind::Prepared || sequence != 0U ||
      std::memcmp(prepared.bytes.data(), "GCJR", 4U) != 0 ||
      ReadU16(prepared.bytes.data() + 4U) != 1U ||
      prepared.bytes[7] != 0U ||
      ReadU32(prepared.bytes.data() + 8U) != gc::kJournalRecordBytes ||
      std::memcmp(prepared.bytes.data() + 16U, fixture.input.operation_id.data(), 16U) != 0 ||
      prepared.bytes[32] != 0x10U || prepared.bytes[33] != 1U ||
      ReadU16(prepared.bytes.data() + 36U) != fixture.sid.size() ||
      ReadU16(prepared.bytes.data() + 38U) != fixture.body.size() ||
      std::memcmp(prepared.bytes.data() + 40U, fixture.sid.data(), fixture.sid.size()) != 0 ||
      !AllZero(prepared.bytes.data() + 40U + fixture.sid.size(), 68U - fixture.sid.size()) ||
      std::memcmp(prepared.bytes.data() + 112U, fixture.body.data(), fixture.body.size()) != 0 ||
      !AllZero(prepared.bytes.data() + 112U + fixture.body.size(), 128U - fixture.body.size()) ||
      std::memcmp(prepared.bytes.data() + 240U, fixture.input.body_sha256.data(), 32U) != 0 ||
      std::memcmp(prepared.bytes.data() + 272U, fixture.input.expected_state_sha256.data(), 32U) != 0 ||
      std::memcmp(prepared.bytes.data() + 304U, fixture.input.stable_binding.data(), 32U) != 0 ||
      std::memcmp(prepared.bytes.data() + 336U, fixture.input.authenticated_binding.data(), 32U) != 0 ||
      !AllZero(prepared.bytes.data() + 368U, 464U) ||
      ReadU16(prepared.bytes.data() + 840U) != 1U ||
      !AllZero(prepared.bytes.data() + 842U, 150U) ||
      std::memcmp(prepared.bytes.data() + 992U, hash.data(), hash.size()) != 0) {
    Fail("PREPARED exact ABI");
  }

  std::uint16_t publication_sequence = 0U;
  if (!gc::GetJournalPublicationSequence(prepared, &publication_sequence) ||
      publication_sequence != 1U ||
      gc::GetJournalPublicationSequence(prepared, nullptr)) {
    Fail("PREPARED publication sequence accessor");
  }
  gc::JournalRecord sequence_hash_mutation = prepared;
  sequence_hash_mutation.bytes[840U] = 2U;
  if (RecordValid(sequence_hash_mutation)) {
    Fail("publication sequence is hash covered");
  }
  for (const std::uint16_t forbidden_sequence : {std::uint16_t{0U},
                                                 std::uint16_t{865U}}) {
    gc::JournalRecord mutated = prepared;
    WriteU16(mutated.bytes.data() + 840U, forbidden_sequence);
    if (!Rehash(&mutated) || RecordValid(mutated)) {
      Fail("publication sequence closed range");
    }
  }
  Fixture maximum_fixture = MakeFixture();
  maximum_fixture.input.operator_sid = maximum_fixture.sid.data();
  maximum_fixture.input.body = maximum_fixture.body.data();
  maximum_fixture.input.publication_sequence = 864U;
  gc::JournalRecord maximum_sequence_record{};
  if (!gc::EncodePreparedJournalRecord(
          maximum_fixture.input, &maximum_sequence_record) ||
      !gc::GetJournalPublicationSequence(
          maximum_sequence_record, &publication_sequence) ||
      publication_sequence != 864U) {
    Fail("publication sequence 864 accepted");
  }
  maximum_fixture.input.publication_sequence = 865U;
  if (gc::EncodePreparedJournalRecord(
          maximum_fixture.input, &maximum_sequence_record)) {
    Fail("prospective publication sequence 865 rejected");
  }
  maximum_fixture.input.publication_sequence = 0U;
  if (gc::EncodePreparedJournalRecord(
          maximum_fixture.input, &maximum_sequence_record)) {
    Fail("prospective publication sequence zero rejected");
  }

  constexpr std::array<std::size_t, 15U> kMustRemainZero = {
      34U, 35U, 52U, 107U, 108U, 111U, 184U, 239U,
      368U, 399U, 400U, 411U, 412U, 831U, 991U};
  for (const std::size_t offset : kMustRemainZero) {
    gc::JournalRecord mutated = prepared;
    mutated.bytes[offset] = 1U;
    if (!Rehash(&mutated) || RecordValid(mutated)) {
      std::fprintf(stderr, "FAIL operation_journal: reserved offset %zu\n", offset);
      ++failures;
    }
  }
  for (const std::size_t offset : {6U, 7U, 12U, 13U, 14U, 15U}) {
    gc::JournalRecord mutated = prepared;
    mutated.bytes[offset] ^= 1U;
    if (!Rehash(&mutated) || RecordValid(mutated)) {
      std::fprintf(stderr, "FAIL operation_journal: PREPARED header offset %zu\n", offset);
      ++failures;
    }
  }

  gc::JournalRecord attempt{};
  if (!gc::EncodeFollowingJournalRecord(
          gc::JournalRecordKind::Attempt,
          0U,
          prepared,
          prepared,
          &fixture.input.authenticated_binding,
          nullptr,
          0U,
          UINT64_C(0x1112131415161718),
          2U,
          &attempt) ||
      !gc::ValidateJournalTransition(prepared, prepared, attempt) ||
      attempt.bytes[6] != static_cast<std::uint8_t>(gc::JournalRecordKind::Attempt) ||
      ReadU32(attempt.bytes.data() + 12U) != 1U ||
      ReadU16(attempt.bytes.data() + 840U) != 2U ||
      std::memcmp(attempt.bytes.data() + 336U, fixture.input.authenticated_binding.data(), 32U) != 0 ||
      !AllZero(attempt.bytes.data() + 400U, 432U)) {
    Fail("initial ATTEMPT ABI");
  }
  gc::JournalRecord invalid_publication_attempt{};
  for (const std::uint16_t forbidden_sequence : {std::uint16_t{0U},
                                                 std::uint16_t{865U}}) {
    if (gc::EncodeFollowingJournalRecord(
            gc::JournalRecordKind::Attempt,
            0U,
            prepared,
            prepared,
            &fixture.input.authenticated_binding,
            nullptr,
            0U,
            UINT64_C(0x191a1b1c1d1e1f20),
            forbidden_sequence,
            &invalid_publication_attempt)) {
      Fail("following-record publication sequence closed range");
    }
  }

  std::array<std::uint8_t, 432U> outcome_bytes{};
  WriteU16(outcome_bytes.data(), 1U);
  WriteU16(outcome_bytes.data() + 2U, 1U);
  WriteU32(outcome_bytes.data() + 4U, 320U);
  WriteU32(outcome_bytes.data() + 8U, 1U);
  outcome_bytes[16] = 0x31U;
  outcome_bytes[48] = 0x41U;
  outcome_bytes[80] = 0x51U;
  outcome_bytes[112] = 0x61U;
  gc::JournalRecord outcome{};
  if (!gc::EncodeFollowingJournalRecord(
          gc::JournalRecordKind::Outcome,
          0U,
          prepared,
          attempt,
          nullptr,
          outcome_bytes.data(),
          outcome_bytes.size(),
          UINT64_C(0x2122232425262728),
          4U,
          &outcome) ||
      !gc::ValidateJournalTransition(prepared, attempt, outcome) ||
      !AllZero(outcome.bytes.data() + 336U, 32U) ||
      ReadU16(outcome.bytes.data() + 840U) != 4U ||
      std::memcmp(outcome.bytes.data() + 400U, outcome_bytes.data(), outcome_bytes.size()) != 0) {
    Fail("OUTCOME ABI");
  }
  gc::JournalRecord nonincreasing_outcome = outcome;
  WriteU16(nonincreasing_outcome.bytes.data() + 840U, 2U);
  if (!Rehash(&nonincreasing_outcome) ||
      !RecordValid(nonincreasing_outcome) ||
      gc::ValidateJournalTransition(
          prepared, attempt, nonincreasing_outcome)) {
    Fail("local transition publication sequence must increase");
  }

  gc::JournalRecord recovery_attempt{};
  if (!gc::EncodeFollowingJournalRecord(
          gc::JournalRecordKind::Attempt,
          1U,
          prepared,
          outcome,
          nullptr,
          nullptr,
          0U,
          UINT64_C(0x3132333435363738),
          5U,
          &recovery_attempt) ||
      !gc::ValidateJournalTransition(prepared, outcome, recovery_attempt) ||
      recovery_attempt.bytes[7] != 1U ||
      !AllZero(recovery_attempt.bytes.data() + 336U, 32U)) {
    Fail("recovery ATTEMPT ABI");
  }

  auto mismatched_outcome_bytes = outcome_bytes;
  mismatched_outcome_bytes[112U] ^= 0x01U;
  gc::JournalRecord mismatched_committed{};
  if (gc::EncodeFollowingJournalRecord(
          gc::JournalRecordKind::Committed,
          0U,
          prepared,
          outcome,
          nullptr,
          mismatched_outcome_bytes.data(),
          mismatched_outcome_bytes.size(),
          UINT64_C(0x393a3b3c3d3e3f40),
          5U,
          &mismatched_committed)) {
    Fail("COMMITTED must repeat direct OUTCOME exactly");
  }

  gc::JournalRecord committed{};
  if (!gc::EncodeFollowingJournalRecord(
          gc::JournalRecordKind::Committed,
          0U,
          prepared,
          recovery_attempt,
          nullptr,
          outcome_bytes.data(),
          outcome_bytes.size(),
          UINT64_C(0x4142434445464748),
          7U,
          &committed) ||
      !gc::ValidateJournalTransition(prepared, recovery_attempt, committed) ||
      std::memcmp(committed.bytes.data() + 400U, outcome.bytes.data() + 400U, 432U) != 0) {
    Fail("COMMITTED ABI");
  }

  gc::JournalRecord replay_attempt{};
  if (!gc::EncodeFollowingJournalRecord(
          gc::JournalRecordKind::Attempt,
          2U,
          prepared,
          committed,
          &fixture.input.authenticated_binding,
          nullptr,
          0U,
          UINT64_C(0x5152535455565758),
          8U,
          &replay_attempt) ||
      !gc::ValidateJournalTransition(prepared, committed, replay_attempt) ||
      replay_attempt.bytes[7] != 2U) {
    Fail("replay ATTEMPT ABI");
  }

  gc::JournalRecord invalid{};
  gc::JournalRecord prepared_recovery_attempt{};
  if (!gc::EncodeFollowingJournalRecord(
          gc::JournalRecordKind::Attempt,
          1U,
          prepared,
          prepared,
          nullptr,
          nullptr,
          0U,
          1U,
          2U,
          &prepared_recovery_attempt) ||
      !gc::ValidateJournalTransition(
          prepared, prepared, prepared_recovery_attempt) ||
      ReadU32(prepared_recovery_attempt.bytes.data() + 12U) != 1U ||
      prepared_recovery_attempt.bytes[7] != 1U ||
      !AllZero(prepared_recovery_attempt.bytes.data() + 336U, 32U) ||
      std::memcmp(
          prepared_recovery_attempt.bytes.data() + 368U,
          prepared.bytes.data() + 992U,
          32U) != 0 ||
      !AllZero(prepared_recovery_attempt.bytes.data() + 400U, 432U)) {
    Fail("PREPARED to recovery ATTEMPT ABI");
  }

  // A PREPARED/no-ATTEMPT restart consumes no new authenticated entropy. The
  // recovery ATTEMPT is the sole predecessor of its terminal OUTCOME, and the
  // eventual COMMITTED record repeats those exact immutable outcome bytes.
  gc::JournalRecord prepared_recovery_outcome{};
  gc::JournalRecord prepared_recovery_committed{};
  if (!gc::EncodeFollowingJournalRecord(
          gc::JournalRecordKind::Outcome,
          0U,
          prepared,
          prepared_recovery_attempt,
          nullptr,
          outcome_bytes.data(),
          outcome_bytes.size(),
          UINT64_C(0x6162636465666768),
          4U,
          &prepared_recovery_outcome) ||
      !gc::ValidateJournalTransition(
          prepared, prepared_recovery_attempt, prepared_recovery_outcome) ||
      !gc::EncodeFollowingJournalRecord(
          gc::JournalRecordKind::Committed,
          0U,
          prepared,
          prepared_recovery_outcome,
          nullptr,
          outcome_bytes.data(),
          outcome_bytes.size(),
          UINT64_C(0x7172737475767778),
          5U,
          &prepared_recovery_committed) ||
      !gc::ValidateJournalTransition(
          prepared, prepared_recovery_outcome, prepared_recovery_committed) ||
      ReadU32(prepared_recovery_outcome.bytes.data() + 12U) != 2U ||
      ReadU32(prepared_recovery_committed.bytes.data() + 12U) != 3U ||
      std::memcmp(
          prepared_recovery_committed.bytes.data() + 400U,
          prepared_recovery_outcome.bytes.data() + 400U,
          432U) != 0) {
    Fail("PREPARED recovery terminal chain");
  }
  gc::JournalRecord forbidden_post_commit_recovery{};
  if (gc::EncodeFollowingJournalRecord(
          gc::JournalRecordKind::Attempt,
          1U,
          prepared,
          prepared_recovery_committed,
          nullptr,
          nullptr,
          0U,
          UINT64_C(0x8182838485868788),
          6U,
          &forbidden_post_commit_recovery)) {
    Fail("committed recovery is restart-idempotent");
  }
  if (gc::EncodeFollowingJournalRecord(
          gc::JournalRecordKind::Attempt,
          2U,
          prepared,
          prepared,
          &fixture.input.authenticated_binding,
          nullptr,
          0U,
          1U,
          2U,
          &invalid) ||
      gc::EncodeFollowingJournalRecord(
          gc::JournalRecordKind::Attempt,
          0U,
          prepared,
          outcome,
          &fixture.input.authenticated_binding,
          nullptr,
          0U,
          1U,
          5U,
          &invalid) ||
      gc::EncodeFollowingJournalRecord(
          gc::JournalRecordKind::Outcome,
          0U,
          prepared,
          prepared,
          nullptr,
          outcome_bytes.data(),
          outcome_bytes.size(),
          1U,
          2U,
          &invalid)) {
    Fail("invalid chain classes rejected");
  }

  return failures;
}

#endif
