#include <windows.h>

#include "local_transport.hpp"
#include "protocol.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <vector>

namespace gc = goatcitadel::remote_worker_provisioner;

int RunEd25519RuntimeTests() noexcept;

namespace {

int g_failures = 0;

void Expect(bool condition, const char* message) noexcept {
  if (!condition) {
    std::fprintf(stderr, "FAIL: GCPA %s\n", message);
    ++g_failures;
  }
}

std::uint8_t HexNibble(char value) noexcept {
  if (value >= '0' && value <= '9') {
    return static_cast<std::uint8_t>(value - '0');
  }
  if (value >= 'a' && value <= 'f') {
    return static_cast<std::uint8_t>(value - 'a' + 10);
  }
  if (value >= 'A' && value <= 'F') {
    return static_cast<std::uint8_t>(value - 'A' + 10);
  }
  return 0xFFU;
}

std::vector<std::uint8_t> Hex(const char* text) {
  std::vector<std::uint8_t> bytes;
  if (text == nullptr) {
    return bytes;
  }
  std::size_t length = 0U;
  while (text[length] != '\0') {
    ++length;
  }
  if ((length & 1U) != 0U) {
    return bytes;
  }
  bytes.reserve(length / 2U);
  for (std::size_t index = 0U; index < length; index += 2U) {
    const std::uint8_t high = HexNibble(text[index]);
    const std::uint8_t low = HexNibble(text[index + 1U]);
    if (high > 0x0FU || low > 0x0FU) {
      bytes.clear();
      return bytes;
    }
    bytes.push_back(static_cast<std::uint8_t>((high << 4U) | low));
  }
  return bytes;
}

template <std::size_t Size>
bool EqualBytes(
    const std::array<std::uint8_t, Size>& actual,
    const std::vector<std::uint8_t>& expected) noexcept {
  if (expected.size() != actual.size()) {
    return false;
  }
  for (std::size_t index = 0U; index < actual.size(); ++index) {
    if (actual[index] != expected[index]) {
      return false;
    }
  }
  return true;
}

bool EqualPrefix(
    const std::uint8_t* actual,
    std::size_t actual_size,
    const std::vector<std::uint8_t>& expected) noexcept {
  if (actual == nullptr || actual_size != expected.size()) {
    return false;
  }
  for (std::size_t index = 0U; index < actual_size; ++index) {
    if (actual[index] != expected[index]) {
      return false;
    }
  }
  return true;
}

template <std::size_t Size>
void FillRange(
    std::array<std::uint8_t, Size>* output,
    std::uint8_t first) noexcept {
  for (std::size_t index = 0U; index < output->size(); ++index) {
    (*output)[index] = static_cast<std::uint8_t>(first + index);
  }
}

bool FillSid(gc::SidProjection* output, const char* hex) {
  if (output == nullptr) {
    return false;
  }
  const std::vector<std::uint8_t> bytes = Hex(hex);
  if (bytes.empty() || bytes.size() > output->bytes.size()) {
    return false;
  }
  *output = gc::SidProjection{};
  output->length = static_cast<std::uint16_t>(bytes.size());
  for (std::size_t index = 0U; index < bytes.size(); ++index) {
    output->bytes[index] = bytes[index];
  }
  return IsValidSid(output->bytes.data()) != FALSE &&
         GetLengthSid(output->bytes.data()) == output->length;
}

struct Fixture final {
  gc::TokenProjection token{};
  gc::ImageProjection service_image{};
  gc::ImageProjection client_image{};
  gc::Byte32 service_nonce{};
  gc::Byte32 connection_nonce{};
  gc::Byte32 client_nonce{};
  gc::Byte16 operation_id{};
  gc::Byte32 body_hash{};
  gc::Byte32 expected_state{};
  gc::Byte32 binding{};
  std::vector<std::uint8_t> inspect_result{};
};

Fixture MakeFixture() {
  Fixture fixture{};
  Expect(
      FillSid(
          &fixture.token.user,
          "010500000000000515000000e8030000d0070000b80b0000a00f0000"),
      "fixture user SID valid");
  Expect(
      FillSid(
          &fixture.token.logon,
          "0103000000000005050000004433221188776655"),
      "fixture logon SID valid");
  fixture.token.logon_sid_attributes = UINT32_C(0xC0000007);
  fixture.token.authentication_id_low = UINT32_C(0x89ABCDEF);
  fixture.token.authentication_id_high = -2;
  fixture.token.session_id = 7U;
  fixture.token.elevation_type = 2U;
  fixture.token.integrity_rid = UINT32_C(0x3000);
  fixture.token.administrators_sid_attributes = 7U;
  fixture.token.has_restricted_sids = false;

  fixture.service_image.volume_serial_number = UINT64_C(0x1122334455667788);
  FillRange(&fixture.service_image.file_id, 0x00U);
  fixture.service_image.file_size = UINT64_C(0x0102030405060708);
  FillRange(&fixture.service_image.sha256, 0x10U);
  fixture.client_image.volume_serial_number = UINT64_C(0x8877665544332211);
  FillRange(&fixture.client_image.file_id, 0xF0U);
  fixture.client_image.file_size = UINT64_C(0x1020304050607080);
  FillRange(&fixture.client_image.sha256, 0xC0U);
  FillRange(&fixture.service_nonce, 0x01U);
  FillRange(&fixture.connection_nonce, 0x21U);
  FillRange(&fixture.client_nonce, 0x41U);
  FillRange(&fixture.operation_id, 0x61U);
  fixture.body_hash = {{
      0xE3U, 0xB0U, 0xC4U, 0x42U, 0x98U, 0xFCU, 0x1CU, 0x14U,
      0x9AU, 0xFBU, 0xF4U, 0xC8U, 0x99U, 0x6FU, 0xB9U, 0x24U,
      0x27U, 0xAEU, 0x41U, 0xE4U, 0x64U, 0x9BU, 0x93U, 0x4CU,
      0xA4U, 0x95U, 0x99U, 0x1BU, 0x78U, 0x52U, 0xB8U, 0x55U,
  }};
  fixture.binding = {{
      0x19U, 0x0BU, 0xB9U, 0x9FU, 0x3AU, 0xB8U, 0x72U, 0x46U,
      0xF6U, 0x5BU, 0xAFU, 0x79U, 0x11U, 0x09U, 0x96U, 0x0FU,
      0x1EU, 0xF3U, 0xB9U, 0xCFU, 0x8AU, 0xE1U, 0xB3U, 0x02U,
      0xFEU, 0x32U, 0x6FU, 0x21U, 0xD1U, 0x96U, 0x17U, 0x4AU,
  }};
  fixture.inspect_result = Hex(
      "0100648600002000002000000000000002000f00070007000200000000000000");
  return fixture;
}

gc::AuthenticatedRequestBindingInput MakeBindingInput(
    const Fixture& fixture,
    const gc::TokenProjection* primary,
    const gc::TokenProjection* pipe) noexcept {
  gc::AuthenticatedRequestBindingInput input{};
  input.service_image = &fixture.service_image;
  input.client_image = &fixture.client_image;
  input.client_primary = primary;
  input.pipe_identification = pipe;
  input.service_pid = UINT32_C(0x10203040);
  input.service_creation_file_time = UINT64_C(0x0102030405060708);
  input.client_pid = UINT32_C(0x50607080);
  input.client_creation_file_time = UINT64_C(0x1112131415161718);
  input.service_start_nonce = &fixture.service_nonce;
  input.connection_nonce = &fixture.connection_nonce;
  input.client_nonce = &fixture.client_nonce;
  input.operation_id = &fixture.operation_id;
  input.opcode = 0x01U;
  input.schema = 1U;
  input.body_sha256 = &fixture.body_hash;
  input.expected_state_sha256 = &fixture.expected_state;
  return input;
}

void TestBindingFixture() {
  const Fixture fixture = MakeFixture();
  gc::Byte32 actual{};
  const auto input = MakeBindingInput(fixture, &fixture.token, &fixture.token);
  Expect(
      gc::ComputeAuthenticatedRequestBinding(input, &actual),
      "binding fixture computes");
  Expect(actual == fixture.binding, "binding fixture exact digest");

  gc::TokenProjection overlong = fixture.token;
  ++overlong.user.length;
  const auto overlong_input =
      MakeBindingInput(fixture, &overlong, &fixture.token);
  Expect(
      !gc::ComputeAuthenticatedRequestBinding(overlong_input, &actual),
      "noncanonical overlong SID rejected");

  gc::TokenProjection malformed = fixture.token;
  malformed.logon.bytes[0] = 0U;
  const auto malformed_input =
      MakeBindingInput(fixture, &malformed, &fixture.token);
  Expect(
      !gc::ComputeAuthenticatedRequestBinding(malformed_input, &actual),
      "malformed SID rejected");
}

void TestLiteralMessages() {
  const auto callable = [](gc::Opcode opcode) noexcept {
    return (gc::kGcpaCallableOpcodeBitmap &
            (UINT64_C(1) << static_cast<std::uint8_t>(opcode))) != 0U;
  };
  Expect(
      gc::kGcpaCallableOpcodeBitmap == UINT64_C(0x0000000000090002) &&
          callable(gc::Opcode::Inspect) &&
          callable(gc::Opcode::CreateKeyset) &&
          callable(gc::Opcode::RevokeLocalKeyset) &&
          !callable(gc::Opcode::AcquireKeyForSigning) &&
          !callable(gc::Opcode::CommitSignature),
      "GCPA exposes INSPECT/CREATE/REVOKE only and keeps signer operations dark");
  const Fixture fixture = MakeFixture();
  const auto expected_client_hello = Hex(
      "47435041010001000100000020000000"
      "4142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f60");
  const auto expected_server_hello = Hex(
      "47435041010081000100000070000000"
      "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
      "2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40"
      "4142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f60"
      "02000f00070007000200090000000000");
  const auto expected_request = Hex(
      "474350410100020001000000b8000000"
      "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
      "2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40"
      "4142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f60"
      "6162636465666768696a6b6c6d6e6f70"
      "0101000000000000"
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      "0000000000000000000000000000000000000000000000000000000000000000");
  const auto expected_result = Hex(
      "47435041010082000100000074000000"
      "6162636465666768696a6b6c6d6e6f70"
      "190bb99f3ab87246f65baf791109960f1ef3b9cf8ae1b302fe326f21d196174a"
      "e36d466cd72cd981f6aa88bdeceddffb086abfca5511f2b735f7286c3a6e9f25"
      "20000000"
      "0100648600002000002000000000000002000f00070007000200000000000000");
  const auto expected_error = Hex(
      "4743504101007f00010000003400000002000000"
      "6162636465666768696a6b6c6d6e6f70"
      "190bb99f3ab87246f65baf791109960f1ef3b9cf8ae1b302fe326f21d196174a");

  std::array<std::uint8_t, gc::kGcpaMaximumResponseFrameBytes> output{};
  std::size_t length = 0U;
  Expect(
      gc::EncodeGcpaClientHello(
          fixture.client_nonce, output.data(), output.size(), &length) &&
          EqualPrefix(output.data(), length, expected_client_hello),
      "CLIENT_HELLO literal");
  gc::Byte32 decoded_nonce{};
  Expect(
      gc::DecodeGcpaClientHello(output.data(), length, &decoded_nonce) &&
          decoded_nonce == fixture.client_nonce,
      "CLIENT_HELLO decode");

  gc::GcpaServerHelloFields hello{};
  hello.service_start_nonce = fixture.service_nonce;
  hello.connection_nonce = fixture.connection_nonce;
  hello.client_nonce = fixture.client_nonce;
  hello.recognized_operation_bitmap = gc::kGcpaRecognizedOpcodeBitmap;
  hello.callable_operation_bitmap = gc::kGcpaCallableOpcodeBitmap;
  Expect(
      gc::EncodeGcpaServerHello(
          hello, output.data(), output.size(), &length) &&
          EqualPrefix(output.data(), length, expected_server_hello),
      "SERVER_HELLO literal");
  gc::GcpaServerHelloFields decoded_hello{};
  Expect(
      gc::DecodeGcpaServerHello(output.data(), length, &decoded_hello) &&
          decoded_hello.connection_nonce == fixture.connection_nonce,
      "SERVER_HELLO decode");

  gc::GcpaClientRequestFields request{};
  request.service_start_nonce = fixture.service_nonce;
  request.connection_nonce = fixture.connection_nonce;
  request.client_nonce = fixture.client_nonce;
  request.operation_id = fixture.operation_id;
  request.opcode = 1U;
  request.schema = 1U;
  request.body_length = 0U;
  request.body_sha256 = fixture.body_hash;
  request.expected_state_sha256 = fixture.expected_state;
  std::array<std::uint8_t, 512U> request_output{};
  Expect(
      gc::EncodeGcpaClientRequest(
          request,
          request_output.data(),
          request_output.size(),
          &length) &&
          EqualPrefix(request_output.data(), length, expected_request),
      "CLIENT_REQUEST literal");
  gc::GcpaClientRequestFields decoded_request{};
  Expect(
      gc::DecodeGcpaClientRequest(
          request_output.data(), length, &decoded_request) &&
          decoded_request.operation_id == fixture.operation_id &&
          decoded_request.body_length == 0U,
      "CLIENT_REQUEST decode");

  Expect(
      gc::EncodeGcpaServerResult(
          fixture.operation_id,
          fixture.binding,
          fixture.inspect_result.data(),
          static_cast<std::uint32_t>(fixture.inspect_result.size()),
          output.data(),
          output.size(),
          &length) &&
          EqualPrefix(output.data(), length, expected_result),
      "SERVER_RESULT literal");
  gc::GcpaServerResponseFields decoded_response{};
  Expect(
      gc::DecodeGcpaServerResponse(
          output.data(), length, &decoded_response) &&
          decoded_response.kind == gc::GcpaKind::ServerResult &&
          decoded_response.result_length == fixture.inspect_result.size(),
      "SERVER_RESULT decode");

  Expect(
      gc::EncodeGcpaError(
          gc::GcpaErrorCode::OperationUnavailable,
          fixture.operation_id,
          fixture.binding,
          output.data(),
          output.size(),
          &length) &&
          EqualPrefix(output.data(), length, expected_error),
      "ERROR literal");
  Expect(
      gc::DecodeGcpaServerResponse(
          output.data(), length, &decoded_response) &&
          decoded_response.kind == gc::GcpaKind::Error &&
          decoded_response.error_code ==
              gc::GcpaErrorCode::OperationUnavailable,
      "ERROR decode");
}

void TestFrozenMessageBoundaries() {
  std::size_t budget = 0U;
  Expect(
      gc::FreezeCurrentMessageBudget(128U, 128U, 128U, &budget) &&
          budget == 128U,
      "pre-read budget frozen");
  Expect(
      !gc::FreezeCurrentMessageBudget(129U, 128U, 256U, &budget),
      "buffered second message rejected before read");
  Expect(
      !gc::FreezeCurrentMessageBudget(0U, 0U, 128U, &budget),
      "empty observation is not a frame");
  Expect(
      !gc::FreezeCurrentMessageBudget(129U, 129U, 128U, &budget),
      "phase maximum enforced");
  Expect(
      gc::FreezeCurrentMessageBudget(1U, 1U, 128U, &budget) &&
          !gc::FrozenFrameLengthIsExact(
              budget, gc::kGcpaServerHelloPayloadBytes, 0U),
      "one-byte first message exhausts without crossing boundary");
  Expect(
      gc::FrozenFrameLengthIsExact(
          128U, gc::kGcpaServerHelloPayloadBytes, 0U),
      "exact hello frozen length");
  Expect(
      !gc::FrozenFrameLengthIsExact(
          129U, gc::kGcpaServerHelloPayloadBytes, 0U),
      "trailing byte rejected by frozen length");
}

void TestNegativeProtocolMatrix() {
  const Fixture fixture = MakeFixture();
  gc::GcpaClientRequestFields request{};
  request.service_start_nonce = fixture.service_nonce;
  request.connection_nonce = fixture.connection_nonce;
  request.client_nonce = fixture.client_nonce;
  request.operation_id = fixture.operation_id;
  request.opcode = 0x10U;
  request.schema = 1U;
  const std::array<std::uint8_t, 3U> body = {0xAAU, 0xBBU, 0xCCU};
  request.body = body.data();
  request.body_length = static_cast<std::uint32_t>(body.size());
  Expect(
      gc::ComputeSha256(body.data(), body.size(), &request.body_sha256),
      "mutation body hash");
  std::array<std::uint8_t, 512U> frame{};
  std::size_t length = 0U;
  Expect(
      gc::EncodeGcpaClientRequest(
          request, frame.data(), frame.size(), &length),
      "opaque mutation request encodes");
  gc::GcpaClientRequestFields decoded{};
  Expect(
      gc::DecodeGcpaClientRequest(frame.data(), length, &decoded) &&
          decoded.opcode == 0x10U && decoded.body_length == body.size() &&
          decoded.body[0] == 0xAAU && decoded.body[2] == 0xCCU,
      "opaque mutation payload preserved");
  frame[gc::kGcpaHeaderBytes + 120U] ^= 0x01U;
  Expect(
      !gc::DecodeGcpaClientRequest(frame.data(), length, &decoded),
      "body digest mismatch rejected");

  std::array<std::uint8_t, gc::kGcpaMaximumResponseFrameBytes> response{};
  gc::Byte16 zero_id{};
  gc::Byte32 zero_binding{};
  Expect(
      gc::EncodeGcpaError(
          gc::GcpaErrorCode::ProtocolInvalid,
          zero_id,
          zero_binding,
          response.data(),
          response.size(),
          &length),
      "pre-envelope zero-bound code1 allowed");
  gc::GcpaServerResponseFields decoded_response{};
  Expect(
      gc::DecodeGcpaServerResponse(
          response.data(), length, &decoded_response),
      "pre-envelope zero-bound code1 decodes");
  Expect(
      !gc::EncodeGcpaError(
          gc::GcpaErrorCode::OperationUnavailable,
          zero_id,
          zero_binding,
          response.data(),
          response.size(),
          &length),
      "zero-bound code2 rejected");
  Expect(
      !gc::EncodeGcpaError(
          gc::GcpaErrorCode::ProtocolInvalid,
          fixture.operation_id,
          zero_binding,
          response.data(),
          response.size(),
          &length),
      "mixed bound fields rejected");

  Expect(
      gc::EncodeGcpaServerResult(
          fixture.operation_id,
          fixture.binding,
          fixture.inspect_result.data(),
          static_cast<std::uint32_t>(fixture.inspect_result.size()),
          response.data(),
          response.size(),
          &length),
      "result for corruption test encodes");
  response[gc::kGcpaHeaderBytes + 48U] ^= 0x01U;
  Expect(
      !gc::DecodeGcpaServerResponse(
          response.data(), length, &decoded_response),
      "result digest mismatch rejected");

  std::array<std::uint8_t, gc::kGcpaHeaderBytes + gc::kGcpaClientHelloPayloadBytes>
      hello{};
  Expect(
      gc::EncodeGcpaClientHello(
          fixture.client_nonce, hello.data(), hello.size(), &length),
      "hello baseline encodes");
  for (std::size_t offset = 0U; offset < gc::kGcpaHeaderBytes; ++offset) {
    auto corrupted = hello;
    corrupted[offset] ^= 0x01U;
    gc::Byte32 nonce{};
    Expect(
        !gc::DecodeGcpaClientHello(corrupted.data(), length, &nonce),
        "every header byte corruption rejected");
  }
}

void TestRandomDuplicateGuard() {
  gc::ResetRandomRegistryForTest();
  gc::Byte16 first16{};
  gc::Byte16 second16{};
  FillRange(&first16, 1U);
  FillRange(&second16, 2U);
  Expect(gc::RegisterRandom16ForTest(first16), "first 16-byte RNG accepted");
  Expect(!gc::RegisterRandom16ForTest(first16), "duplicate 16-byte RNG rejected");
  Expect(gc::RegisterRandom16ForTest(second16), "distinct 16-byte RNG accepted");
  gc::Byte16 zero16{};
  Expect(!gc::RegisterRandom16ForTest(zero16), "zero 16-byte RNG rejected");

  gc::Byte32 first32{};
  gc::Byte32 second32{};
  FillRange(&first32, 0x20U);
  FillRange(&second32, 0x21U);
  Expect(gc::RegisterRandom32ForTest(first32), "first 32-byte RNG accepted");
  Expect(!gc::RegisterRandom32ForTest(first32), "duplicate 32-byte RNG rejected");
  Expect(gc::RegisterRandom32ForTest(second32), "distinct 32-byte RNG accepted");
  gc::Byte32 zero32{};
  Expect(!gc::RegisterRandom32ForTest(zero32), "zero 32-byte RNG rejected");
  gc::ResetRandomRegistryForTest();
}

}  // namespace

int RunLocalTransportTests() noexcept {
  const int initial_failures = g_failures;
  g_failures += RunEd25519RuntimeTests();
  TestBindingFixture();
  TestLiteralMessages();
  TestFrozenMessageBoundaries();
  TestNegativeProtocolMatrix();
  TestRandomDuplicateGuard();
  return g_failures - initial_failures;
}
