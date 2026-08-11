#pragma once

#include <windows.h>

#include <array>
#include <cstddef>
#include <cstdint>

namespace goatcitadel::remote_worker_provisioner {

using Byte16 = std::array<std::uint8_t, 16U>;
using Byte32 = std::array<std::uint8_t, 32U>;

constexpr std::size_t kGcpaHeaderBytes = 16U;
constexpr std::size_t kGcpaClientHelloPayloadBytes = 32U;
constexpr std::size_t kGcpaServerHelloPayloadBytes = 112U;
constexpr std::size_t kGcpaClientRequestPrefixBytes = 184U;
constexpr std::size_t kGcpaServerResultPrefixBytes = 84U;
constexpr std::size_t kGcpaErrorPayloadBytes = 52U;
constexpr std::size_t kGcpaMaximumRequestFrameBytes =
    kGcpaHeaderBytes + kGcpaClientRequestPrefixBytes +
    static_cast<std::size_t>(2U * 1024U * 1024U);
constexpr std::size_t kGcpaMaximumResponseFrameBytes =
    kGcpaHeaderBytes + kGcpaServerResultPrefixBytes +
    static_cast<std::size_t>(8U * 1024U);
constexpr std::uint16_t kGcpaVersion = 1U;
constexpr std::uint32_t kGcpaRequestId = 1U;
constexpr std::uint64_t kGcpaRecognizedOpcodeBitmap =
    UINT64_C(0x00070007001F0002);
constexpr std::uint64_t kGcpaCallableOpcodeBitmap =
    UINT64_C(0x00000000001D0002);

constexpr wchar_t kProvisionerTransportServiceName[] =
    L"GoatCitadelRemoteWorkerProvisioner";
constexpr wchar_t kProvisionerPipeName[] =
    L"\\\\.\\pipe\\LOCAL\\GoatCitadelRemoteWorkerProvisioner.v1";

enum class GcpaKind : std::uint8_t {
  ClientHello = 0x01U,
  ClientRequest = 0x02U,
  ServerHello = 0x81U,
  ServerResult = 0x82U,
  Error = 0x7FU,
};

enum class GcpaErrorCode : std::uint32_t {
  ProtocolInvalid = 1U,
  OperationUnavailable = 2U,
  IoFailed = 3U,
};

struct SidProjection final {
  std::uint16_t length = 0U;
  std::array<std::uint8_t, SECURITY_MAX_SID_SIZE> bytes{};
};

struct ImageProjection final {
  std::uint64_t volume_serial_number = 0U;
  std::array<std::uint8_t, 16U> file_id{};
  std::uint64_t file_size = 0U;
  Byte32 sha256{};
};

struct TokenProjection final {
  SidProjection user{};
  SidProjection logon{};
  std::uint32_t logon_sid_attributes = 0U;
  std::uint32_t authentication_id_low = 0U;
  std::int32_t authentication_id_high = 0;
  std::uint32_t session_id = 0U;
  std::uint32_t elevation_type = 0U;
  std::uint32_t integrity_rid = 0U;
  std::uint32_t administrators_sid_attributes = 0U;
  bool has_restricted_sids = false;
};

struct AuthenticatedRequestBindingInput final {
  const ImageProjection* service_image = nullptr;
  const ImageProjection* client_image = nullptr;
  const TokenProjection* client_primary = nullptr;
  const TokenProjection* pipe_identification = nullptr;
  std::uint32_t service_pid = 0U;
  std::uint64_t service_creation_file_time = 0U;
  std::uint32_t client_pid = 0U;
  std::uint64_t client_creation_file_time = 0U;
  const Byte32* service_start_nonce = nullptr;
  const Byte32* connection_nonce = nullptr;
  const Byte32* client_nonce = nullptr;
  const Byte16* operation_id = nullptr;
  std::uint8_t opcode = 0U;
  std::uint8_t schema = 1U;
  const Byte32* body_sha256 = nullptr;
  const Byte32* expected_state_sha256 = nullptr;
};

struct GcpaServerHelloFields final {
  Byte32 service_start_nonce{};
  Byte32 connection_nonce{};
  Byte32 client_nonce{};
  std::uint64_t recognized_operation_bitmap = 0U;
  std::uint64_t callable_operation_bitmap = 0U;
};

struct GcpaClientRequestFields final {
  Byte32 service_start_nonce{};
  Byte32 connection_nonce{};
  Byte32 client_nonce{};
  Byte16 operation_id{};
  std::uint8_t opcode = 0U;
  std::uint8_t schema = 0U;
  std::uint32_t body_length = 0U;
  Byte32 body_sha256{};
  Byte32 expected_state_sha256{};
  const std::uint8_t* body = nullptr;
};

struct GcpaServerResponseFields final {
  GcpaKind kind = GcpaKind::Error;
  GcpaErrorCode error_code = GcpaErrorCode::ProtocolInvalid;
  Byte16 operation_id{};
  Byte32 authenticated_request_binding{};
  Byte32 result_sha256{};
  std::uint32_t result_length = 0U;
  const std::uint8_t* result = nullptr;
};

bool GenerateRandom16(Byte16* output) noexcept;
bool GenerateRandom32(Byte32* output) noexcept;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
void ResetRandomRegistryForTest() noexcept;
bool RegisterRandom16ForTest(const Byte16& value) noexcept;
bool RegisterRandom32ForTest(const Byte32& value) noexcept;
#endif
bool ComputeSha256(
    const std::uint8_t* bytes,
    std::size_t length,
    Byte32* output) noexcept;
// SHA-256, truncated to 16 bytes, over the operation-domain including its NUL,
// then: caller SID length u16 LE, caller SID, expected state SHA-256,
// expected generation u64 LE, expected receipt SHA-256, and the exact
// contract-owned PoP-v2 preimage. This is a local custody-operation fence; it
// does not change the Ed25519 PoP-v2 preimage or signature contract.
bool DeriveRuntimePopV2OperationId(
    const std::uint8_t* authenticated_caller_sid,
    std::uint16_t authenticated_caller_sid_length,
    const Byte32& expected_state_sha256,
    std::uint64_t expected_generation,
    const Byte32& expected_keyset_receipt_sha256,
    const std::uint8_t* canonical_preimage,
    std::size_t canonical_preimage_length,
    Byte16* output) noexcept;
bool ComputeAuthenticatedRequestBinding(
    const AuthenticatedRequestBindingInput& input,
    Byte32* output) noexcept;

bool FreezeCurrentMessageBudget(
    std::uint32_t total_available,
    std::uint32_t current_message_left,
    std::size_t phase_maximum,
    std::size_t* frozen_budget) noexcept;
bool FrozenFrameLengthIsExact(
    std::size_t frozen_budget,
    std::size_t fixed_payload_prefix,
    std::uint32_t variable_body_length) noexcept;

bool EncodeGcpaClientHello(
    const Byte32& client_nonce,
    std::uint8_t* output,
    std::size_t output_capacity,
    std::size_t* output_length) noexcept;
bool DecodeGcpaClientHello(
    const std::uint8_t* frame,
    std::size_t frame_length,
    Byte32* client_nonce) noexcept;
bool EncodeGcpaServerHello(
    const GcpaServerHelloFields& fields,
    std::uint8_t* output,
    std::size_t output_capacity,
    std::size_t* output_length) noexcept;
bool DecodeGcpaServerHello(
    const std::uint8_t* frame,
    std::size_t frame_length,
    GcpaServerHelloFields* fields) noexcept;
bool EncodeGcpaClientRequest(
    const GcpaClientRequestFields& fields,
    std::uint8_t* output,
    std::size_t output_capacity,
    std::size_t* output_length) noexcept;
bool DecodeGcpaClientRequest(
    const std::uint8_t* frame,
    std::size_t frame_length,
    GcpaClientRequestFields* fields) noexcept;
bool EncodeGcpaServerResult(
    const Byte16& operation_id,
    const Byte32& authenticated_request_binding,
    const std::uint8_t* result,
    std::uint32_t result_length,
    std::uint8_t* output,
    std::size_t output_capacity,
    std::size_t* output_length) noexcept;
bool EncodeGcpaError(
    GcpaErrorCode error_code,
    const Byte16& operation_id,
    const Byte32& authenticated_request_binding,
    std::uint8_t* output,
    std::size_t output_capacity,
    std::size_t* output_length) noexcept;
bool DecodeGcpaServerResponse(
    const std::uint8_t* frame,
    std::size_t frame_length,
    GcpaServerResponseFields* fields) noexcept;

enum class ClientExchangeDisposition : std::uint32_t {
  Success = 0U,
  ProtocolInvalid = 1U,
  OperationUnavailable = 2U,
  IoFailed = 3U,
  TransportFailure = 4U,
};

struct ClientExchangeRequest final {
  std::uint8_t opcode = 0U;
  const std::uint8_t* body = nullptr;
  std::uint32_t body_length = 0U;
  Byte16 operation_id{};
  Byte32 expected_state_sha256{};
};

struct ClientExchangeResponse final {
  ClientExchangeDisposition disposition =
      ClientExchangeDisposition::TransportFailure;
  std::array<std::uint8_t, 320U> result{};
  std::uint32_t result_length = 0U;
};

ClientExchangeDisposition RunProtectedClientExchange(
    const ClientExchangeRequest& request,
    ClientExchangeResponse* response) noexcept;

enum class ServiceTransportResult : std::uint32_t {
  Success = 0U,
  ProtectedImage = 3U,
  PipeReadiness = 4U,
  CallerAuthentication = 5U,
  ProtocolInvalid = 6U,
  Deadline = 7U,
  CancellationOrReversion = 8U,
  CustodyOrJournal = 9U,
};

struct ServiceTransportContext final {
  HANDLE stop_event = nullptr;
  std::uint64_t running_deadline_ms = 0U;
  const Byte32* service_start_nonce = nullptr;
  const Byte32* expected_client_sha256 = nullptr;
};

// Fixed storage keeps the service transport allocation-free. The service owns one
// static instance for its complete lifetime; callers must not place it on the stack.
constexpr std::size_t kServiceTransportStateBytesUnaligned =
    kGcpaMaximumRequestFrameBytes + 256U * 1024U;
constexpr std::size_t kServiceTransportStateBytes =
    (kServiceTransportStateBytesUnaligned + 63U) & ~static_cast<std::size_t>(63U);
struct alignas(64) ServiceTransportState final {
  std::array<std::uint8_t, kServiceTransportStateBytes> storage{};
};

ServiceTransportResult ResolveProtectedServiceBinaryPath(
    ServiceTransportState* state,
    wchar_t* quoted_path,
    std::size_t quoted_path_capacity,
    std::size_t* quoted_path_length) noexcept;
ServiceTransportResult ValidateServiceTransportImages(
    const ServiceTransportContext& context,
    ServiceTransportState* state) noexcept;
ServiceTransportResult RecoverProtectedServiceState(
    ServiceTransportState* state,
    std::uint64_t startup_deadline_ms) noexcept;
ServiceTransportResult ArmServiceTransport(
    ServiceTransportState* state) noexcept;
bool SetServiceTransportRunningDeadline(
    ServiceTransportState* state,
    std::uint64_t running_deadline_ms) noexcept;
ServiceTransportResult RunServiceTransport(
    ServiceTransportState* state) noexcept;
ServiceTransportResult CloseServiceTransport(
    ServiceTransportState* state) noexcept;

}  // namespace goatcitadel::remote_worker_provisioner
