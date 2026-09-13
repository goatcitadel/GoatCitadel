// Test-only synthetic signer. Never part of the production DLL or installed helper.
#include "tls_key.hpp"
#include "ed25519_runtime.hpp"
#include "protocol.hpp"
#include "fixture_seed.hpp"
#include <array>
#include <cstring>
#include <cwchar>
using namespace goatcitadel::worker_tls;
using namespace goatcitadel::remote_worker_provisioner;

int wmain(int argc, wchar_t** argv) {
  if (argc != 2 || std::wcscmp(argv[1], L"--service-stdio")) return 2;
  wchar_t inherited_environment[64]{};
  if (GetEnvironmentVariableW(L"GOATCITADEL_TLS_TEST_CANARY", inherited_environment, 64) != 0) return 11;
  std::array<wchar_t, 2048> path{};
  if (!GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()))) return 3;
  const auto has = [&](const wchar_t* mode) { return std::wcsstr(path.data(), mode) != nullptr; };
  if (has(L"hang")) {
    HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    WaitForSingleObject(event, INFINITE); CloseHandle(event); return 4;
  }
  if (has(L"exit")) return 5;
  std::array<std::uint8_t, 401> request{};
  DWORD read = 0, total = 0;
  while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), request.data() + total,
      static_cast<DWORD>(request.size()) - total, &read, nullptr) && read) {
    total += read;
    if (total == request.size()) return 6;
  }
  RequestHeader parsed{};
  if (ParseHeader(request.data(), kHeaderBytes, &parsed) != HeaderStatus::Valid ||
      total != kHeaderBytes + parsed.payload_length) return 7;
  const auto* body = request.data() + kHeaderBytes;
  std::array<std::uint8_t, 512> signing{};
  std::size_t length = 0;
  DWORD response_size = 200;
  if (parsed.opcode == 0x15 && total == kRequestBytes) {
    length = request[108];
    if (!IsClientCertificateVerify(request.data() + 144, length)) return 8;
    std::memcpy(signing.data(), request.data() + 144, length);
  } else if (parsed.opcode == 0x14 && total == 400) {
    SignRuntimePopV2Request runtime{};
    if (!DecodeSignRuntimePopV2CallerRequest(body, 384, &runtime)) return 8;
    length = runtime.preimage.size();
    std::memcpy(signing.data(), runtime.preimage.data(), length);
  } else if (parsed.opcode == 0x12 && total == 400) {
    SignAdmissionEvidenceRequest admission{};
    if (!DecodeSignAdmissionEvidenceRequest(body, 384, &admission)) return 8;
    constexpr char domain[] = "goatcitadel.remote-worker.provisioning-evidence.signature.v1";
    length = sizeof(domain) + kAdmissionEvidenceEnvelopeBytes;
    std::memcpy(signing.data(), domain, sizeof(domain));
    std::memcpy(signing.data() + sizeof(domain), body + 96, kAdmissionEvidenceEnvelopeBytes);
    response_size = 336;
  } else return 8;
  Ed25519VectorResultForTest signed_value{};
  if (!RunEd25519VectorForTest(kFixtureSeed.data(), kFixtureSeed.size(), signing.data(), length, &signed_value)) return 9;
  std::array<std::uint8_t, 337> response{};
  std::memcpy(response.data(), request.data(), kHeaderBytes);
  response[6] |= 0x80;
  const DWORD payload_size = response_size - static_cast<DWORD>(kHeaderBytes);
  for (std::size_t i = 0; i < 4; ++i) response[12 + i] = static_cast<std::uint8_t>(payload_size >> (8 * i));
  response[16] = 1; response[18] = 1;
  std::array<std::uint8_t, 32> spki_hash{};
  if (!HashBytes(signed_value.spki.data(), signed_value.spki.size(), &spki_hash)) return 9;
  if (parsed.opcode == 0x12) {
    std::array<std::uint8_t, 32> envelope_hash{}, request_hash{};
    if (!HashBytes(body + 96, kAdmissionEvidenceEnvelopeBytes, &envelope_hash) ||
        !HashBytes(body, 384, &request_hash)) return 9;
    std::memcpy(response.data() + 24, body, 16);
    std::memcpy(response.data() + 40, body + 52, 8);
    std::memcpy(response.data() + 48, envelope_hash.data(), 32);
    std::memcpy(response.data() + 80, body + 60, 32);
    std::memcpy(response.data() + 112, spki_hash.data(), 32);
    std::memcpy(response.data() + 144, signed_value.spki.data(), 44);
    std::memcpy(response.data() + 188, signed_value.signature.data(), 64);
    std::memcpy(response.data() + 252, body + 16, 32);
    std::memcpy(response.data() + 284, request_hash.data(), 32);
  } else {
    std::memcpy(response.data() + 24, body + 60, 32);
    std::memcpy(response.data() + 56, spki_hash.data(), 32);
    std::memcpy(response.data() + 88, signed_value.spki.data(), 44);
    std::memcpy(response.data() + 132, signed_value.signature.data(), 64);
  }
  if (has(L"receipt")) response[24] ^= 1;
  if (has(L"signature")) response[132] ^= 1;
  DWORD written = 0;
  if (has(L"stderr")) WriteFile(GetStdHandle(STD_ERROR_HANDLE), "x", 1, &written, nullptr);
  const DWORD bytes = has(L"overflow") ? response_size + 1 : has(L"short") ? response_size - 1 : response_size;
  return WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), response.data(), bytes, &written, nullptr) && written == bytes ? 0 : 10;
}
