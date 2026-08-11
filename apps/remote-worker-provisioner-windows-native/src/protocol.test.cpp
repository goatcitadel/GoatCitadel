#include <windows.h>

#include "protocol.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <vector>

namespace gc = goatcitadel::remote_worker_provisioner;

int RunServiceRuntimeTests() noexcept;
int RunLocalTransportTests() noexcept;
int RunAvailabilityBrokerTests() noexcept;
int RunProtectedFilesystemTests() noexcept;
int RunOperationJournalTests() noexcept;
int RunKeyCustodyTests() noexcept;
int RunProtectedOperationsTests() noexcept;

namespace {

constexpr std::uint32_t kFuzzSeed = 0x47504357U;
constexpr std::size_t kFuzzCases = 65536U;

int g_failures = 0;

void Fail(const char* message) {
  std::fprintf(stderr, "FAIL: %s\n", message);
  ++g_failures;
}

void Expect(bool condition, const char* message) {
  if (!condition) {
    Fail(message);
  }
}

void WriteU16(std::uint8_t* bytes, std::uint16_t value) {
  bytes[0] = static_cast<std::uint8_t>(value & 0xFFU);
  bytes[1] = static_cast<std::uint8_t>((value >> 8U) & 0xFFU);
}

void WriteU32(std::uint8_t* bytes, std::uint32_t value) {
  bytes[0] = static_cast<std::uint8_t>(value & 0xFFU);
  bytes[1] = static_cast<std::uint8_t>((value >> 8U) & 0xFFU);
  bytes[2] = static_cast<std::uint8_t>((value >> 16U) & 0xFFU);
  bytes[3] = static_cast<std::uint8_t>((value >> 24U) & 0xFFU);
}

void WriteU64(std::uint8_t* bytes, std::uint64_t value) {
  for (std::size_t index = 0U; index < 8U; ++index) {
    bytes[index] = static_cast<std::uint8_t>((value >> (index * 8U)) & UINT64_C(0xff));
  }
}

void WriteU64Be(std::uint8_t* bytes, std::uint64_t value) {
  for (std::size_t index = 0U; index < 8U; ++index) {
    bytes[index] = static_cast<std::uint8_t>(
        (value >> ((7U - index) * 8U)) & UINT64_C(0xff));
  }
}

std::uint16_t ReadU16(const std::uint8_t* bytes) {
  return static_cast<std::uint16_t>(
      static_cast<std::uint16_t>(bytes[0]) |
      static_cast<std::uint16_t>(static_cast<std::uint16_t>(bytes[1]) << 8U));
}

std::uint32_t ReadU32(const std::uint8_t* bytes) {
  return static_cast<std::uint32_t>(
      static_cast<std::uint32_t>(bytes[0]) |
      (static_cast<std::uint32_t>(bytes[1]) << 8U) |
      (static_cast<std::uint32_t>(bytes[2]) << 16U) |
      (static_cast<std::uint32_t>(bytes[3]) << 24U));
}

std::uint64_t ReadU64(const std::uint8_t* bytes) {
  std::uint64_t value = 0U;
  for (std::size_t index = 0U; index < 8U; ++index) {
    value |= static_cast<std::uint64_t>(bytes[index]) << (index * 8U);
  }
  return value;
}

std::vector<std::uint8_t> MakeFrame(
    std::uint8_t opcode,
    std::uint32_t declared_payload_length = 0U,
    std::size_t actual_payload_length = 0U) {
  std::vector<std::uint8_t> frame(gc::kHeaderBytes + actual_payload_length, 0U);
  frame[0] = 'G';
  frame[1] = 'C';
  frame[2] = 'P';
  frame[3] = 'W';
  WriteU16(frame.data() + 4U, gc::kProtocolVersion);
  frame[6] = opcode;
  frame[7] = 0U;
  WriteU32(frame.data() + 8U, gc::kRequestId);
  WriteU32(frame.data() + 12U, declared_payload_length);
  return frame;
}

bool IsWireHeader(const gc::Response& response, std::uint8_t opcode, std::uint32_t payload_length) {
  return response.size == gc::kHeaderBytes + payload_length &&
         response.bytes[0] == 'G' && response.bytes[1] == 'C' &&
         response.bytes[2] == 'P' && response.bytes[3] == 'W' &&
         ReadU16(response.bytes.data() + 4U) == gc::kProtocolVersion &&
         response.bytes[6] == opcode && response.bytes[7] == 0U &&
         ReadU32(response.bytes.data() + 8U) == gc::kRequestId &&
         ReadU32(response.bytes.data() + 12U) == payload_length;
}

bool IsError(const gc::Response& response, gc::ErrorCode code, gc::ExitCode exit_code) {
  return IsWireHeader(response, 0x7FU, static_cast<std::uint32_t>(gc::kErrorPayloadBytes)) &&
         ReadU32(response.bytes.data() + gc::kHeaderBytes) ==
             static_cast<std::uint32_t>(code) &&
         response.exit_code == exit_code;
}

void TestExactInspectRoundTrip() {
  const auto request = MakeFrame(static_cast<std::uint8_t>(gc::Opcode::Inspect));
  for (const std::uint16_t machine : {gc::kMachineX64, gc::kMachineArm64}) {
    const gc::Response response =
        gc::ProcessBuffer(request.data(), request.size(), machine);
    Expect(
        IsWireHeader(
            response,
            0x81U,
            static_cast<std::uint32_t>(gc::kInspectPayloadBytes)),
        "INSPECT response header");
    Expect(response.exit_code == gc::ExitCode::Success, "INSPECT exit success");
    const std::uint8_t* payload = response.bytes.data() + gc::kHeaderBytes;
    Expect(ReadU16(payload + 0U) == 1U, "INSPECT schema");
    Expect(ReadU16(payload + 2U) == machine, "INSPECT machine");
    Expect(ReadU32(payload + 4U) == gc::kOrdinaryMaximumBytes, "INSPECT ordinary maximum");
    Expect(ReadU32(payload + 8U) == gc::kSecretMaximumBytes, "INSPECT secret maximum");
    Expect(ReadU32(payload + 12U) == 0U, "INSPECT flags");
    Expect(
        ReadU64(payload + 16U) == gc::kRecognizedOpcodeBitmap,
        "INSPECT recognized bitmap");
    Expect(
        ReadU64(payload + 24U) == gc::kCallableOpcodeBitmap,
        "INSPECT callable bitmap");
  }
}

void TestEveryTruncatedPrefix() {
  const auto request = MakeFrame(static_cast<std::uint8_t>(gc::Opcode::Inspect));
  for (std::size_t length = 0U; length < gc::kHeaderBytes; ++length) {
    const gc::Response response =
        gc::ProcessBuffer(request.data(), length, gc::kMachineX64);
    Expect(response.size == 0U, "truncated header emits no response");
    Expect(response.exit_code != gc::ExitCode::Success, "truncated header fails");
  }

  auto payload_request =
      MakeFrame(static_cast<std::uint8_t>(gc::Opcode::CreateKeyset), 32U, 32U);
  for (std::size_t length = gc::kHeaderBytes;
       length < payload_request.size();
       ++length) {
    const gc::Response response =
        gc::ProcessBuffer(payload_request.data(), length, gc::kMachineX64);
    Expect(response.size == 0U, "truncated payload emits no response");
  }
}

void TestLengthCapsAndExactEof() {
  auto exact_cap = MakeFrame(
      static_cast<std::uint8_t>(gc::Opcode::CreateKeyset),
      gc::kOrdinaryMaximumBytes,
      gc::kOrdinaryMaximumBytes);
  const gc::Response cap_response =
      gc::ProcessBuffer(exact_cap.data(), exact_cap.size(), gc::kMachineX64);
  Expect(
      IsError(
          cap_response,
          gc::ErrorCode::OperationUnavailable,
          gc::ExitCode::OperationUnavailable),
      "exact ordinary cap remains bounded and dark");

  for (const std::uint32_t declared : {
           gc::kOrdinaryMaximumBytes + 1U,
           UINT32_MAX,
       }) {
    auto over_cap =
        MakeFrame(static_cast<std::uint8_t>(gc::Opcode::Inspect), declared, 0U);
    const gc::Response response =
        gc::ProcessBuffer(over_cap.data(), over_cap.size(), gc::kMachineX64);
    Expect(response.size == 0U, "over-cap declaration emits no response");
  }

  auto inspect_payload =
      MakeFrame(static_cast<std::uint8_t>(gc::Opcode::Inspect), 1U, 1U);
  Expect(
      IsError(
          gc::ProcessBuffer(
              inspect_payload.data(),
              inspect_payload.size(),
              gc::kMachineX64),
          gc::ErrorCode::ProtocolInvalid,
          gc::ExitCode::ProtocolInvalid),
      "INSPECT payload rejected");

  auto trailing = MakeFrame(static_cast<std::uint8_t>(gc::Opcode::Inspect));
  trailing.push_back(0U);
  Expect(
      IsError(
          gc::ProcessBuffer(trailing.data(), trailing.size(), gc::kMachineX64),
          gc::ErrorCode::ProtocolInvalid,
          gc::ExitCode::ProtocolInvalid),
      "trailing byte rejected");

  auto second = MakeFrame(static_cast<std::uint8_t>(gc::Opcode::Inspect));
  const auto second_frame =
      MakeFrame(static_cast<std::uint8_t>(gc::Opcode::Inspect));
  second.insert(second.end(), second_frame.begin(), second_frame.end());
  Expect(
      IsError(
          gc::ProcessBuffer(second.data(), second.size(), gc::kMachineX64),
          gc::ErrorCode::ProtocolInvalid,
          gc::ExitCode::ProtocolInvalid),
      "second frame rejected");
}

void TestHeaderFieldMatrix() {
  const auto baseline = MakeFrame(static_cast<std::uint8_t>(gc::Opcode::Inspect));
  for (std::size_t magic_index = 0U; magic_index < 4U; ++magic_index) {
    auto frame = baseline;
    frame[magic_index] ^= 0x01U;
    Expect(
        IsError(
            gc::ProcessBuffer(frame.data(), frame.size(), gc::kMachineX64),
            gc::ErrorCode::ProtocolInvalid,
            gc::ExitCode::ProtocolInvalid),
        "invalid magic rejected");
  }
  constexpr std::array<std::uint16_t, 3U> kInvalidVersions = {
      static_cast<std::uint16_t>(0U),
      static_cast<std::uint16_t>(2U),
      UINT16_MAX,
  };
  for (const std::uint16_t version : kInvalidVersions) {
    auto frame = baseline;
    WriteU16(frame.data() + 4U, version);
    Expect(
        IsError(
            gc::ProcessBuffer(frame.data(), frame.size(), gc::kMachineX64),
            gc::ErrorCode::ProtocolInvalid,
            gc::ExitCode::ProtocolInvalid),
        "invalid version rejected");
  }
  for (std::uint16_t flags = 1U; flags <= UINT8_MAX; ++flags) {
    auto frame = baseline;
    frame[7] = static_cast<std::uint8_t>(flags);
    Expect(
        IsError(
            gc::ProcessBuffer(frame.data(), frame.size(), gc::kMachineX64),
            gc::ErrorCode::ProtocolInvalid,
            gc::ExitCode::ProtocolInvalid),
        "nonzero flags rejected");
  }
  constexpr std::array<std::uint32_t, 3U> kInvalidRequestIds = {
      UINT32_C(0),
      UINT32_C(2),
      UINT32_MAX,
  };
  for (const std::uint32_t request_id : kInvalidRequestIds) {
    auto frame = baseline;
    WriteU32(frame.data() + 8U, request_id);
    Expect(
        IsError(
            gc::ProcessBuffer(frame.data(), frame.size(), gc::kMachineX64),
            gc::ErrorCode::ProtocolInvalid,
            gc::ExitCode::ProtocolInvalid),
        "invalid request ID rejected");
  }
  Expect(
      IsError(
          gc::ProcessBuffer(
              baseline.data(),
              baseline.size(),
              static_cast<std::uint16_t>(0x014CU)),
          gc::ErrorCode::ProtocolInvalid,
          gc::ExitCode::ProtocolInvalid),
      "unsupported PE machine rejected");
}

void TestKnownDarkAndUnknownOpcodes() {
  constexpr std::array<std::uint8_t, 11U> kDarkOpcodes = {
      static_cast<std::uint8_t>(gc::Opcode::CreateKeyset),
      static_cast<std::uint8_t>(gc::Opcode::AcquireKeyForSigning),
      static_cast<std::uint8_t>(gc::Opcode::SignAdmissionEvidence),
      static_cast<std::uint8_t>(gc::Opcode::RevokeLocalKeyset),
      static_cast<std::uint8_t>(gc::Opcode::SignRuntimePopV2),
      static_cast<std::uint8_t>(gc::Opcode::BeginInstall),
      static_cast<std::uint8_t>(gc::Opcode::SealAndPublishInstall),
      static_cast<std::uint8_t>(gc::Opcode::AbandonToQuarantine),
      static_cast<std::uint8_t>(gc::Opcode::RunKeyInitService),
      static_cast<std::uint8_t>(gc::Opcode::PublishCertAndFinalizeDisabled),
      static_cast<std::uint8_t>(gc::Opcode::InspectFinal),
  };
  for (const std::uint8_t opcode : kDarkOpcodes) {
    const auto frame = MakeFrame(opcode);
    Expect(gc::IsRecognizedOpcode(opcode), "dark opcode recognized");
    Expect(
        IsError(
            gc::ProcessBuffer(frame.data(), frame.size(), gc::kMachineX64),
            gc::ErrorCode::OperationUnavailable,
            gc::ExitCode::OperationUnavailable),
        "dark opcode unavailable");
  }

  for (std::uint16_t candidate = 0U; candidate <= UINT8_MAX; ++candidate) {
    const auto opcode = static_cast<std::uint8_t>(candidate);
    if (gc::IsRecognizedOpcode(opcode)) {
      continue;
    }
    const auto frame = MakeFrame(opcode);
    Expect(
        IsError(
            gc::ProcessBuffer(frame.data(), frame.size(), gc::kMachineX64),
            gc::ErrorCode::ProtocolInvalid,
            gc::ExitCode::ProtocolInvalid),
        "unknown opcode invalid");
  }
}

std::uint32_t NextRandom(std::uint32_t* state) {
  std::uint32_t value = *state;
  value ^= value << 13U;
  value ^= value >> 17U;
  value ^= value << 5U;
  *state = value;
  return value;
}

void TestSeededFuzz() {
  std::uint32_t state = kFuzzSeed;
  for (std::size_t case_index = 0U; case_index < kFuzzCases; ++case_index) {
    const std::size_t length =
        static_cast<std::size_t>(NextRandom(&state) % 257U);
    std::vector<std::uint8_t> bytes(length, 0U);
    for (std::size_t index = 0U; index < length; ++index) {
      bytes[index] = static_cast<std::uint8_t>(NextRandom(&state) & 0xFFU);
    }
    if (length >= gc::kHeaderBytes && (case_index % 3U) == 0U) {
      bytes[0] = 'G';
      bytes[1] = 'C';
      bytes[2] = 'P';
      bytes[3] = 'W';
      WriteU16(bytes.data() + 4U, gc::kProtocolVersion);
      bytes[7] = 0U;
      WriteU32(bytes.data() + 8U, gc::kRequestId);
      WriteU32(
          bytes.data() + 12U,
          static_cast<std::uint32_t>(length - gc::kHeaderBytes));
    }

    const std::uint8_t* data = bytes.empty() ? nullptr : bytes.data();
    const std::uint16_t machine =
        (case_index & 1U) == 0U ? gc::kMachineX64 : gc::kMachineArm64;
    const gc::Response response = gc::ProcessBuffer(data, bytes.size(), machine);
    Expect(response.size <= response.bytes.size(), "fuzz response bounded");
    Expect(
        response.size == 0U ||
            response.size == gc::kHeaderBytes + gc::kErrorPayloadBytes ||
            response.size == gc::kHeaderBytes + gc::kInspectPayloadBytes,
        "fuzz response shape closed");
    if (response.size != 0U) {
      Expect(response.bytes[0] == 'G' && response.bytes[3] == 'W', "fuzz response magic");
      Expect(response.bytes[7] == 0U, "fuzz response flags");
      Expect(ReadU32(response.bytes.data() + 8U) == gc::kRequestId, "fuzz response ID");
    }
  }
}

void TestProtectedMutationCodecs() {
  std::array<std::uint8_t, gc::kCreateKeysetRequestBytes> create{};
  for (std::size_t index = 0U; index < 16U; ++index) {
    create[index] = static_cast<std::uint8_t>(index + 1U);
  }
  for (std::size_t index = 0U; index < 32U; ++index) {
    create[16U + index] = static_cast<std::uint8_t>(0x40U + index);
  }
  WriteU16(create.data() + 48U, 1U);
  WriteU64(create.data() + 52U, 7U);
  WriteU64(create.data() + 60U, 6U);
  gc::CreateKeysetRequest decoded_create{};
  Expect(
      gc::DecodeCreateKeysetRequest(create.data(), create.size(), &decoded_create) &&
          decoded_create.operation_id[0] == 1U &&
          decoded_create.expected_state_sha256[0] == 0x40U &&
          decoded_create.requested_generation == 7U &&
          decoded_create.predecessor_generation == 6U,
      "protected CREATE request exact codec");

  auto InvalidCreateClears = [&](const auto& bytes, std::size_t length) {
    decoded_create.operation_id.fill(0xa5U);
    decoded_create.expected_state_sha256.fill(0xa5U);
    decoded_create.requested_generation = UINT64_MAX;
    decoded_create.predecessor_generation = UINT64_MAX;
    const bool accepted = gc::DecodeCreateKeysetRequest(
        bytes.data(), length, &decoded_create);
    const gc::CreateKeysetRequest empty{};
    return !accepted &&
           std::memcmp(&decoded_create, &empty, sizeof(empty)) == 0;
  };
  for (std::size_t length = 0U; length < create.size(); ++length) {
    Expect(InvalidCreateClears(create, length), "truncated CREATE rejected and cleared");
  }
  auto extra_create = std::array<std::uint8_t, gc::kCreateKeysetRequestBytes + 1U>{};
  std::memcpy(extra_create.data(), create.data(), create.size());
  Expect(InvalidCreateClears(extra_create, extra_create.size()), "trailing CREATE byte rejected");
  for (const std::size_t offset : {0U, 16U, 48U, 50U, 51U, 52U, 68U, 69U, 70U, 71U}) {
    auto mutated = create;
    if (offset == 0U) {
      std::fill(mutated.begin(), mutated.begin() + 16U, static_cast<std::uint8_t>(0U));
    } else if (offset == 16U) {
      std::fill(mutated.begin() + 16U, mutated.begin() + 48U, static_cast<std::uint8_t>(0U));
    } else if (offset == 48U) {
      WriteU16(mutated.data() + 48U, 2U);
    } else if (offset == 52U) {
      WriteU64(mutated.data() + 52U, 0U);
    } else {
      mutated[offset] = 1U;
    }
    Expect(InvalidCreateClears(mutated, mutated.size()), "CREATE fixed authority mutation rejected");
  }
  Expect(
      !gc::DecodeCreateKeysetRequest(create.data(), create.size(), nullptr),
      "CREATE null output rejected");

  std::array<std::uint8_t, gc::kRevokeKeysetRequestBytes> revoke{};
  std::memcpy(revoke.data(), create.data(), 48U);
  WriteU16(revoke.data() + 48U, 1U);
  WriteU64(revoke.data() + 52U, 7U);
  WriteU32(revoke.data() + 60U, 3U);
  for (std::size_t index = 0U; index < 32U; ++index) {
    revoke[68U + index] = static_cast<std::uint8_t>(0x80U + index);
  }
  gc::RevokeKeysetRequest decoded_revoke{};
  Expect(
      gc::DecodeRevokeKeysetRequest(revoke.data(), revoke.size(), &decoded_revoke) &&
          decoded_revoke.generation == 7U && decoded_revoke.reason == 3U &&
          decoded_revoke.expected_receipt_sha256[0] == 0x80U,
      "protected REVOKE request exact codec");
  auto InvalidRevokeClears = [&](const auto& bytes, std::size_t length) {
    decoded_revoke.operation_id.fill(0xa5U);
    decoded_revoke.expected_state_sha256.fill(0xa5U);
    decoded_revoke.expected_receipt_sha256.fill(0xa5U);
    decoded_revoke.generation = UINT64_MAX;
    decoded_revoke.reason = UINT32_MAX;
    const bool accepted = gc::DecodeRevokeKeysetRequest(
        bytes.data(), length, &decoded_revoke);
    const gc::RevokeKeysetRequest empty{};
    return !accepted &&
           std::memcmp(&decoded_revoke, &empty, sizeof(empty)) == 0;
  };
  for (std::size_t length = 0U; length < revoke.size(); ++length) {
    Expect(InvalidRevokeClears(revoke, length), "truncated REVOKE rejected and cleared");
  }
  for (std::uint32_t reason = 1U; reason <= 3U; ++reason) {
    auto each_reason = revoke;
    WriteU32(each_reason.data() + 60U, reason);
    Expect(
        gc::DecodeRevokeKeysetRequest(
            each_reason.data(), each_reason.size(), &decoded_revoke) &&
            decoded_revoke.reason == reason,
        "REVOKE closed reason accepted");
  }
  for (const std::size_t offset : {0U, 16U, 48U, 50U, 51U, 52U, 60U, 64U, 65U, 66U, 67U, 68U}) {
    auto mutated = revoke;
    if (offset == 0U) {
      std::fill(mutated.begin(), mutated.begin() + 16U, static_cast<std::uint8_t>(0U));
    } else if (offset == 16U) {
      std::fill(mutated.begin() + 16U, mutated.begin() + 48U, static_cast<std::uint8_t>(0U));
    } else if (offset == 48U) {
      WriteU16(mutated.data() + 48U, 2U);
    } else if (offset == 52U) {
      WriteU64(mutated.data() + 52U, 0U);
    } else if (offset == 60U) {
      WriteU32(mutated.data() + 60U, 4U);
    } else if (offset == 68U) {
      std::fill(mutated.begin() + 68U, mutated.end(), static_cast<std::uint8_t>(0U));
    } else {
      mutated[offset] = 1U;
    }
    Expect(InvalidRevokeClears(mutated, mutated.size()), "REVOKE fixed authority mutation rejected");
  }
  Expect(
      !gc::DecodeRevokeKeysetRequest(revoke.data(), revoke.size(), nullptr),
      "REVOKE null output rejected");

  std::array<std::uint8_t, gc::kAdmissionEvidenceEnvelopeBytes> envelope{};
  envelope[0U] = 'G';
  envelope[1U] = 'C';
  envelope[2U] = 'A';
  envelope[3U] = 'E';
  WriteU16(envelope.data() + 4U, 1U);
  envelope[6U] = 1U;
  WriteU32(
      envelope.data() + 8U,
      static_cast<std::uint32_t>(gc::kAdmissionEvidenceEnvelopeBytes));
  for (std::size_t index = 0U; index < 16U; ++index) {
    envelope[16U + index] = static_cast<std::uint8_t>(0x20U + index);
  }
  for (std::size_t index = 0U; index < 32U; ++index) {
    envelope[32U + index] = static_cast<std::uint8_t>(0x40U + index);
  }
  WriteU64(envelope.data() + 64U, 7U);
  constexpr std::array<std::size_t, 6U> kEvidenceHashOffsets = {
      96U, 128U, 160U, 192U, 224U, 256U};
  for (std::size_t field = 0U; field < kEvidenceHashOffsets.size(); ++field) {
    for (std::size_t index = 0U; index < 32U; ++index) {
      envelope[kEvidenceHashOffsets[field] + index] =
          static_cast<std::uint8_t>(0x60U + field * 5U + index);
    }
  }
  gc::AdmissionEvidenceEnvelope decoded_envelope{};
  Expect(
      gc::DecodeAdmissionEvidenceEnvelope(
          envelope.data(), envelope.size(), &decoded_envelope) &&
          decoded_envelope.operation_id[0U] == 0x20U &&
          decoded_envelope.evidence_nonce_sha256[0U] == 0x40U &&
          decoded_envelope.worker_generation == 7U &&
          decoded_envelope.context_sha256[0U] == 0x60U &&
          decoded_envelope.installed_tree_verification_receipt_sha256[0U] ==
              static_cast<std::uint8_t>(0x60U + 5U * 5U),
      "admission-evidence envelope exact codec");
  auto InvalidEnvelopeClears = [&](const auto& bytes, std::size_t length) {
    std::memset(&decoded_envelope, 0xa5, sizeof(decoded_envelope));
    const bool accepted = gc::DecodeAdmissionEvidenceEnvelope(
        bytes.data(), length, &decoded_envelope);
    const gc::AdmissionEvidenceEnvelope empty{};
    return !accepted &&
           std::memcmp(&decoded_envelope, &empty, sizeof(empty)) == 0;
  };
  for (std::size_t length = 0U; length < envelope.size(); ++length) {
    Expect(
        InvalidEnvelopeClears(envelope, length),
        "truncated admission-evidence envelope rejected and cleared");
  }
  std::array<std::uint8_t, gc::kAdmissionEvidenceEnvelopeBytes + 1U>
      extra_envelope{};
  std::memcpy(extra_envelope.data(), envelope.data(), envelope.size());
  Expect(
      InvalidEnvelopeClears(extra_envelope, extra_envelope.size()),
      "oversize admission-evidence envelope rejected");
  for (const std::size_t offset : {
           0U, 4U, 6U, 7U, 8U, 12U, 16U, 32U, 64U, 72U,
           96U, 128U, 160U, 192U, 224U, 256U}) {
    auto mutated = envelope;
    if (offset == 0U) {
      mutated[0U] = 0U;
    } else if (offset == 4U) {
      WriteU16(mutated.data() + 4U, 2U);
    } else if (offset == 6U) {
      mutated[6U] = 2U;
    } else if (offset == 7U || offset == 12U || offset == 72U) {
      mutated[offset] = 1U;
    } else if (offset == 8U) {
      WriteU32(mutated.data() + 8U, 287U);
    } else if (offset == 16U) {
      std::fill(
          mutated.begin() + 16U,
          mutated.begin() + 32U,
          static_cast<std::uint8_t>(0U));
    } else if (offset == 32U) {
      std::fill(
          mutated.begin() + 32U,
          mutated.begin() + 64U,
          static_cast<std::uint8_t>(0U));
    } else if (offset == 64U) {
      WriteU64(mutated.data() + 64U, 0U);
    } else {
      std::fill(
          mutated.begin() + offset,
          mutated.begin() + offset + 32U,
          static_cast<std::uint8_t>(0U));
    }
    Expect(
        InvalidEnvelopeClears(mutated, mutated.size()),
        "admission-evidence envelope mutation rejected");
  }
  Expect(
      !gc::DecodeAdmissionEvidenceEnvelope(
          envelope.data(), envelope.size(), nullptr),
      "admission-evidence envelope null output rejected");

  std::array<std::uint8_t, gc::kSignAdmissionEvidenceRequestBytes>
      sign_request{};
  std::memcpy(sign_request.data(), envelope.data() + 16U, 16U);
  for (std::size_t index = 0U; index < 32U; ++index) {
    sign_request[16U + index] = static_cast<std::uint8_t>(0x80U + index);
    sign_request[60U + index] = static_cast<std::uint8_t>(0xa0U + index);
  }
  WriteU16(sign_request.data() + 48U, 1U);
  sign_request[50U] = 2U;
  WriteU64(sign_request.data() + 52U, 7U);
  WriteU32(
      sign_request.data() + 92U,
      static_cast<std::uint32_t>(gc::kAdmissionEvidenceEnvelopeBytes));
  std::memcpy(sign_request.data() + 96U, envelope.data(), envelope.size());
  gc::SignAdmissionEvidenceRequest decoded_sign_request{};
  Expect(
      gc::DecodeSignAdmissionEvidenceRequest(
          sign_request.data(), sign_request.size(), &decoded_sign_request) &&
          decoded_sign_request.operation_id[0U] == 0x20U &&
          decoded_sign_request.expected_state_sha256[0U] == 0x80U &&
          decoded_sign_request.expected_generation == 7U &&
          decoded_sign_request.expected_keyset_receipt_sha256[0U] == 0xa0U &&
          decoded_sign_request.envelope.worker_generation == 7U,
      "sign admission-evidence request exact codec");
  auto InvalidSignRequestClears = [&](const auto& bytes, std::size_t length) {
    std::memset(&decoded_sign_request, 0xa5, sizeof(decoded_sign_request));
    const bool accepted = gc::DecodeSignAdmissionEvidenceRequest(
        bytes.data(), length, &decoded_sign_request);
    const gc::SignAdmissionEvidenceRequest empty{};
    return !accepted &&
           std::memcmp(
               &decoded_sign_request, &empty, sizeof(decoded_sign_request)) ==
               0;
  };
  for (std::size_t length = 0U; length < sign_request.size(); ++length) {
    Expect(
        InvalidSignRequestClears(sign_request, length),
        "truncated sign admission-evidence request rejected and cleared");
  }
  std::array<std::uint8_t, gc::kSignAdmissionEvidenceRequestBytes + 1U>
      extra_sign_request{};
  std::memcpy(
      extra_sign_request.data(), sign_request.data(), sign_request.size());
  Expect(
      InvalidSignRequestClears(
          extra_sign_request, extra_sign_request.size()),
      "oversize sign admission-evidence request rejected");
  for (const std::size_t offset : {
           0U, 16U, 48U, 50U, 51U, 52U, 60U, 92U, 96U, 112U, 160U}) {
    auto mutated = sign_request;
    if (offset == 0U) {
      std::fill(
          mutated.begin(),
          mutated.begin() + 16U,
          static_cast<std::uint8_t>(0U));
    } else if (offset == 16U) {
      std::fill(
          mutated.begin() + 16U,
          mutated.begin() + 48U,
          static_cast<std::uint8_t>(0U));
    } else if (offset == 48U) {
      WriteU16(mutated.data() + 48U, 2U);
    } else if (offset == 50U) {
      mutated[50U] = 1U;
    } else if (offset == 51U) {
      mutated[51U] = 1U;
    } else if (offset == 52U) {
      WriteU64(mutated.data() + 52U, 0U);
    } else if (offset == 60U) {
      std::fill(
          mutated.begin() + 60U,
          mutated.begin() + 92U,
          static_cast<std::uint8_t>(0U));
    } else if (offset == 92U) {
      WriteU32(mutated.data() + 92U, 287U);
    } else if (offset == 96U) {
      mutated[96U] = 0U;
    } else if (offset == 112U) {
      mutated[112U] ^= 1U;
    } else {
      WriteU64(mutated.data() + 160U, 8U);
    }
    Expect(
        InvalidSignRequestClears(mutated, mutated.size()),
        "sign admission-evidence request mutation rejected");
  }
  Expect(
      !gc::DecodeSignAdmissionEvidenceRequest(
          sign_request.data(), sign_request.size(), nullptr),
      "sign admission-evidence null output rejected");

  std::array<std::uint8_t, gc::kRemoteWorkerPopV2PreimageBytes> pop_preimage{};
  constexpr char kPopV2Domain[] = "goatcitadel.remote-worker-pop.v2";
  static_assert(sizeof(kPopV2Domain) == gc::kRemoteWorkerPopV2DomainBytes);
  std::memcpy(pop_preimage.data(), kPopV2Domain, sizeof(kPopV2Domain));
  pop_preimage[gc::kRemoteWorkerPopV2DomainBytes + 0U] = 2U;
  pop_preimage[gc::kRemoteWorkerPopV2DomainBytes + 1U] = 1U;
  pop_preimage[gc::kRemoteWorkerPopV2DomainBytes + 2U] = 7U;
  pop_preimage[gc::kRemoteWorkerPopV2DomainBytes + 3U] = 2U;
  WriteU64Be(pop_preimage.data() + gc::kRemoteWorkerPopV2DomainBytes + 4U, 3U);
  WriteU64Be(pop_preimage.data() + gc::kRemoteWorkerPopV2DomainBytes + 12U, 7U);
  WriteU64Be(
      pop_preimage.data() + gc::kRemoteWorkerPopV2DomainBytes + 20U,
      UINT64_C(1786288496789));
  for (std::size_t index = gc::kRemoteWorkerPopV2DomainBytes + 28U;
       index < pop_preimage.size();
       ++index) {
    pop_preimage[index] = static_cast<std::uint8_t>(index & 0xffU);
  }

  std::array<std::uint8_t, gc::kSignRuntimePopV2RequestBytes> pop_request{};
  for (std::size_t index = 0U; index < 16U; ++index) {
    pop_request[index] = static_cast<std::uint8_t>(0xc0U + index);
  }
  for (std::size_t index = 0U; index < 32U; ++index) {
    pop_request[16U + index] = static_cast<std::uint8_t>(0x80U + index);
    pop_request[60U + index] = static_cast<std::uint8_t>(0xa0U + index);
  }
  WriteU16(pop_request.data() + 48U, 1U);
  pop_request[50U] = 3U;
  WriteU64(pop_request.data() + 52U, 7U);
  WriteU32(
      pop_request.data() + 92U,
      static_cast<std::uint32_t>(gc::kRemoteWorkerPopV2PreimageBytes));
  std::memcpy(
      pop_request.data() + 96U,
      pop_preimage.data(),
      pop_preimage.size());

  gc::SignRuntimePopV2Request decoded_pop_request{};
  Expect(
      gc::DecodeSignRuntimePopV2Request(
          pop_request.data(), pop_request.size(), &decoded_pop_request) &&
          decoded_pop_request.operation_id[0U] == 0xc0U &&
          decoded_pop_request.expected_state_sha256[0U] == 0x80U &&
          decoded_pop_request.expected_generation == 7U &&
          decoded_pop_request.expected_keyset_receipt_sha256[0U] == 0xa0U &&
          decoded_pop_request.material.route_code == 7U &&
          decoded_pop_request.material.authority_kind_code == 2U &&
          decoded_pop_request.material.authority_generation == 3U &&
          decoded_pop_request.material.worker_generation == 7U &&
          decoded_pop_request.preimage == pop_preimage,
      "remote-worker PoP-v2 request exact codec");
  auto caller_pop_request = pop_request;
  std::fill(
      caller_pop_request.begin(),
      caller_pop_request.begin() + 16U,
      std::uint8_t{0U});
  Expect(
      gc::DecodeSignRuntimePopV2CallerRequest(
          caller_pop_request.data(),
          caller_pop_request.size(),
          &decoded_pop_request) &&
          decoded_pop_request.operation_id ==
              std::array<std::uint8_t, 16U>{} &&
          decoded_pop_request.preimage == pop_preimage &&
          !gc::DecodeSignRuntimePopV2Request(
              caller_pop_request.data(),
              caller_pop_request.size(),
              &decoded_pop_request) &&
          !gc::DecodeSignRuntimePopV2CallerRequest(
              pop_request.data(),
              pop_request.size(),
              &decoded_pop_request),
      "remote-worker PoP-v2 caller placeholder and inner authority are distinct");
  auto InvalidPopRequestClears = [&](const auto& bytes, std::size_t length) {
    std::memset(&decoded_pop_request, 0xa5, sizeof(decoded_pop_request));
    const bool accepted = gc::DecodeSignRuntimePopV2Request(
        bytes.data(), length, &decoded_pop_request);
    return !accepted &&
           decoded_pop_request.operation_id ==
               std::array<std::uint8_t, 16U>{} &&
           decoded_pop_request.expected_state_sha256 ==
               std::array<std::uint8_t, 32U>{} &&
           decoded_pop_request.expected_generation == 0U &&
           decoded_pop_request.expected_keyset_receipt_sha256 ==
               std::array<std::uint8_t, 32U>{} &&
           decoded_pop_request.preimage ==
               std::array<
                   std::uint8_t,
                   gc::kRemoteWorkerPopV2PreimageBytes>{} &&
           decoded_pop_request.material.route_code == 0U &&
           decoded_pop_request.material.authority_kind_code == 0U &&
           decoded_pop_request.material.authority_generation == 0U &&
           decoded_pop_request.material.worker_generation == 0U &&
           decoded_pop_request.material.timestamp_epoch_ms == 0U &&
           decoded_pop_request.material.worker_public_key_spki_sha256 ==
               std::array<std::uint8_t, 32U>{};
  };
  for (const std::size_t offset : {
           0U, 16U, 48U, 50U, 51U, 52U, 60U, 92U, 96U, 129U, 130U,
           131U, 132U, 133U, 141U, 149U, 381U}) {
    auto mutated = pop_request;
    if (offset == 0U) {
      std::fill(mutated.begin(), mutated.begin() + 16U, std::uint8_t{0U});
    } else if (offset == 16U) {
      std::fill(
          mutated.begin() + 16U,
          mutated.begin() + 48U,
          std::uint8_t{0U});
    } else if (offset == 48U) {
      WriteU16(mutated.data() + 48U, 2U);
    } else if (offset == 50U) {
      mutated[50U] = 2U;
    } else if (offset == 51U || offset == 381U) {
      mutated[offset] = 1U;
    } else if (offset == 52U) {
      WriteU64(mutated.data() + 52U, 0U);
    } else if (offset == 60U) {
      std::fill(
          mutated.begin() + 60U,
          mutated.begin() + 92U,
          std::uint8_t{0U});
    } else if (offset == 92U) {
      WriteU32(mutated.data() + 92U, 284U);
    } else if (offset == 96U) {
      mutated[96U] = 0U;
    } else if (offset == 129U) {
      mutated[offset] = 3U;
    } else if (offset == 130U) {
      mutated[offset] = 2U;
    } else if (offset == 131U) {
      mutated[offset] = 11U;
    } else if (offset == 132U) {
      mutated[offset] = 1U;
    } else if (offset == 133U) {
      WriteU64Be(mutated.data() + offset, 0U);
    } else if (offset == 141U) {
      WriteU64Be(mutated.data() + offset, 8U);
    } else {
      WriteU64Be(mutated.data() + offset, UINT64_C(9007199254740992));
    }
    Expect(
        InvalidPopRequestClears(mutated, mutated.size()),
        "remote-worker PoP-v2 request mutation rejected");
  }
  for (std::uint8_t route = 1U; route <= 10U; ++route) {
    auto bound = pop_request;
    bound[131U] = route;
    bound[132U] = route == 1U ? 1U : 2U;
    Expect(
        gc::DecodeSignRuntimePopV2Request(
            bound.data(), bound.size(), &decoded_pop_request),
        "closed remote-worker PoP-v2 route purpose accepted");
  }
  auto wrong_bootstrap_purpose = pop_request;
  wrong_bootstrap_purpose[131U] = 1U;
  wrong_bootstrap_purpose[132U] = 2U;
  Expect(
      InvalidPopRequestClears(
          wrong_bootstrap_purpose, wrong_bootstrap_purpose.size()),
      "bootstrap route rejects credential authority purpose");
  std::array<std::uint8_t, gc::kSignRuntimePopV2RequestBytes + 1U>
      extra_pop_request{};
  std::memcpy(
      extra_pop_request.data(), pop_request.data(), pop_request.size());
  Expect(
      InvalidPopRequestClears(pop_request, pop_request.size() - 1U) &&
          InvalidPopRequestClears(
              extra_pop_request, extra_pop_request.size()) &&
          !gc::DecodeSignRuntimePopV2Request(
              pop_request.data(), pop_request.size(), nullptr),
      "remote-worker PoP-v2 exact length and output enforced");

  std::array<std::uint8_t, 288U> projection{};
  WriteU16(projection.data(), 1U);
  WriteU64(projection.data() + 8U, gc::kProtectedCallableOpcodeBitmap);
  std::array<std::uint8_t, gc::kProtectedInspectPayloadBytes> inspect{};
  Expect(
      gc::EncodeProtectedInspectResult(
          gc::kMachineX64, projection.data(), projection.size(), &inspect) &&
          ReadU64(inspect.data() + 24U) == gc::kCallableOpcodeBitmap &&
          ReadU64(inspect.data() + 40U) == gc::kProtectedCallableOpcodeBitmap,
      "protected INSPECT extends but does not mutate direct W0 projection");
  for (const std::size_t offset : {0U, 8U}) {
    auto invalid_projection = projection;
    invalid_projection[offset] ^= 1U;
    inspect.fill(0xa5U);
    Expect(
        !gc::EncodeProtectedInspectResult(
            gc::kMachineX64,
            invalid_projection.data(),
            invalid_projection.size(),
            &inspect) &&
            std::all_of(inspect.begin(), inspect.end(), [](std::uint8_t value) { return value == 0U; }),
        "protected INSPECT fixed projection mutation rejected and cleared");
  }
}

}  // namespace

int main(int argument_count, char* arguments[]) {
  if (argument_count != 1 || arguments == nullptr) {
    return 2;
  }
  const auto RunExternal = [](const char* name, int (*run)() noexcept) {
    const int failures = run();
    if (failures != 0) {
      std::fprintf(stderr, "FAIL: %s returned %d\n", name, failures);
    }
    return failures;
  };
  g_failures += RunExternal("service_runtime", &RunServiceRuntimeTests);
  g_failures += RunExternal("local_transport", &RunLocalTransportTests);
  g_failures += RunExternal("availability_broker", &RunAvailabilityBrokerTests);
  g_failures += RunExternal("protected_filesystem", &RunProtectedFilesystemTests);
  g_failures += RunExternal("operation_journal", &RunOperationJournalTests);
  g_failures += RunExternal("key_custody", &RunKeyCustodyTests);
  g_failures += RunExternal("protected_operations", &RunProtectedOperationsTests);
  TestExactInspectRoundTrip();
  TestEveryTruncatedPrefix();
  TestLengthCapsAndExactEof();
  TestHeaderFieldMatrix();
  TestKnownDarkAndUnknownOpcodes();
  TestProtectedMutationCodecs();
  TestSeededFuzz();
  if (g_failures != 0) {
    return 1;
  }
  constexpr char kReceipt[] =
      "GCPW_NATIVE_TESTS seed=0x47504357 cases=65536\n";
  const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  DWORD written = 0U;
  if (output == nullptr || output == INVALID_HANDLE_VALUE ||
      WriteFile(
          output,
          kReceipt,
          static_cast<DWORD>(sizeof(kReceipt) - 1U),
          &written,
          nullptr) == FALSE ||
      written != static_cast<DWORD>(sizeof(kReceipt) - 1U)) {
    return 1;
  }
  return 0;
}
