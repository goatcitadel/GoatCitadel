#include "cell_install_capacity_pipe.hpp"
#include <cstdio>
#include <stdexcept>
#include <string>
#include <thread>
#include <bcrypt.h>

using namespace goatcitadel::worker_cell;
namespace goatcitadel::worker_cell {
struct CellInstallCapacityPipeAdmissionTestPeer {
  static void Retain(CellInstallCapacityPipeAdmission& admission, ULONGLONG deadline,
      std::shared_ptr<CellControllerAttestationSigner> signer) {
    admission.consumed_ = true; admission.deadline_ = deadline; admission.signer_ = std::move(signer);
  }
};
}
namespace {
unsigned checks = 0;
void Check(bool value, const char* message) { ++checks; if (!value) throw std::runtime_error(message); }
struct Handle final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
struct Key final {
  NCRYPT_PROV_HANDLE provider = 0; NCRYPT_KEY_HANDLE key = 0;
  ~Key() { if (key) NCryptFreeObject(key); if (provider) NCryptFreeObject(provider); }
  bool Open() {
    DWORD usage = NCRYPT_ALLOW_SIGNING_FLAG, policy = 0;
    return !NCryptOpenStorageProvider(&provider, MS_KEY_STORAGE_PROVIDER, 0) &&
      !NCryptCreatePersistedKey(provider, &key, NCRYPT_ECDSA_P256_ALGORITHM, nullptr, 0, 0) &&
      !NCryptSetProperty(key, NCRYPT_KEY_USAGE_PROPERTY, reinterpret_cast<PBYTE>(&usage), sizeof(usage), 0) &&
      !NCryptSetProperty(key, NCRYPT_EXPORT_POLICY_PROPERTY, reinterpret_cast<PBYTE>(&policy), sizeof(policy), 0) &&
      !NCryptFinalizeKey(key, 0);
  }
};
struct Authority final {
  std::string mode;
  unsigned calls = 0;
  CellInstallCapacityPipe* channel = nullptr;
  HANDLE pipe = nullptr, stop = nullptr;
  ULONGLONG deadline = 0;
  NCRYPT_KEY_HANDLE key = 0;
  ControllerAttestationState state{};
  static DWORD Local(void*) noexcept { return ERROR_SUCCESS; }
  static DWORD Current(void* raw, const CellInstallCapacityBinding& binding, std::uint32_t ordinal) noexcept {
    auto& self = *static_cast<Authority*>(raw); ++self.calls;
    if (ordinal != self.calls || binding.connection[0] != 0x11 || binding.byte_length != 1013) return ERROR_INVALID_DATA;
    if (self.mode == "deny") return ERROR_ACCESS_DENIED;
    if (self.mode == "reentrant") {
      if (self.channel->Request() != ERROR_INVALID_STATE) return ERROR_GEN_FAILURE;
    }
    if (self.mode == "attest" || self.mode.starts_with("terminal")) {
      std::array<std::uint8_t, 36> challenge{};
      ControllerDigest nonce{}; nonce.fill(static_cast<std::uint8_t>(ordinal));
      std::copy(nonce.begin(), nonce.end(), challenge.begin());
      for (unsigned i = 0; i < 4; ++i) challenge[32 + i] = static_cast<std::uint8_t>(ordinal >> (8 * i));
      auto error = WriteCellControllerMessage(self.pipe, CellControllerMessage::controller_attestation_challenge,
        challenge.data(), 36, self.stop, self.deadline);
      std::array<std::uint8_t, 460> proof{};
      if (!error) error = ReadCellControllerMessage(self.pipe, CellControllerMessage::controller_attestation_proof,
        proof.data(), 460, self.stop, self.deadline);
      ControllerStatement expected{};
      if (!error && (!EncodeControllerAttestation(self.state, nonce, ordinal, &expected) ||
          !std::equal(expected.begin(), expected.end(), proof.begin()))) error = ERROR_INVALID_DATA;
      BCRYPT_ALG_HANDLE algorithm = nullptr; ControllerDigest hash{};
      if (!error && BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) error = ERROR_GEN_FAILURE;
      if (!error && BCryptHash(algorithm, nullptr, 0, proof.data(), 396, hash.data(), 32) < 0) error = ERROR_GEN_FAILURE;
      if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
      if (!error && NCryptVerifySignature(self.key, nullptr, hash.data(), 32, proof.data() + 396, 64, 0)) error = ERROR_INVALID_DATA;
      if (error) return error;
    }
    return ERROR_SUCCESS;
  }
};
CellInstallCapacityBinding Binding() {
  CellInstallCapacityBinding binding; binding.connection.fill(0x11); binding.installation.nonce.fill(0x22);
  binding.installation.request_sha256.fill(0x33); binding.capture_sha256.fill(0x44); binding.byte_length = 1013;
  return binding;
}
void Exchange(const std::string& mode, unsigned sequence) {
  const auto name = L"\\\\.\\pipe\\LOCAL\\GoatInstallCapacityTest-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(sequence);
  Handle server{CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 4096, 4096, 0, nullptr)};
  Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(server.value != INVALID_HANDLE_VALUE && stop.value, "private pipe and cancellation event");
  const auto deadline = GetTickCount64() + 5000; const auto expected = Binding();
  Key key; Check(key.Open(), "ephemeral signing key");
  ControllerAttestationState state; ControllerPublicPoint point{};
  Check(!ReadControllerAttestationPublicPoint(key.key, &point, &state.key_sha256), "signing fingerprint");
  state.instance.fill(2); state.authority.fill(3); state.installation_nonce = expected.installation.nonce;
  state.request_sha256 = expected.installation.request_sha256;
  for (unsigned i = 0; i < 6; ++i) state.window[i].fill(static_cast<std::uint8_t>(7 + i));
  DWORD server_result = ERROR_GEN_FAILURE, server_retry = ERROR_SUCCESS, first_result = ERROR_GEN_FAILURE;
  std::thread thread([&] {
    server_result = ConnectCellPipe(server.value, stop.value, deadline);
    if (!server_result) {
      auto signer = std::make_shared<CellControllerAttestationSigner>(key.key, state,
        ControllerAttestationGuard{nullptr, Authority::Local, stop.value, deadline});
      CellInstallCapacityPipe channel(server.value, stop.value, deadline, expected, {Authority::Local, nullptr, stop.value},
        mode == "attest" || mode.starts_with("terminal") ? signer.get() : nullptr);
      server_result = first_result = channel.Request();
      if (!server_result) server_result = channel.Request();
      if (!server_result && mode.starts_with("terminal")) {
        CellInstallCapacityPipeAdmission admission(server.value, stop.value, expected.connection, L"fixture", L"fixture",
          {Authority::Local, nullptr, stop.value});
        CellInstallCapacityPipeAdmissionTestPeer::Retain(admission, deadline, signer);
        signer.reset(); // Admission now retains signing after the copy scope.
        server_result = admission.Finish();
        server_retry = admission.Finish();
      }
      if (server_result && !mode.starts_with("terminal")) server_retry = channel.Request();
    }
  });
  Handle client{CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr)};
  if (client.value == INVALID_HANDLE_VALUE) { SetEvent(stop.value); thread.join(); Check(false, "connect private pipe"); }
  auto supplied = expected;
  if (mode == "wrong-binding") supplied.capture_sha256[0] ^= 1;
  Authority authority; authority.mode = mode;
  authority.pipe = client.value; authority.stop = stop.value; authority.deadline = deadline; authority.key = key.key; authority.state = state;
  CellInstallCapacityPipe channel(client.value, stop.value, deadline, supplied, {Authority::Local, nullptr, stop.value});
  authority.channel = &channel;
  supplied.connection.fill(0); // Channel owns its immutable copy.
  DWORD client_result = ERROR_SUCCESS, client_retry = ERROR_SUCCESS;
  if (mode == "replay" || mode == "wrong-kind") {
    for (unsigned i = 1; i <= 2 && !client_result; ++i) {
      CellInstallCapacityChallenge incoming;
      client_result = ReadCellControllerMessage(client.value, CellControllerMessage::install_capacity_authority,
        incoming.data(), static_cast<DWORD>(incoming.size()), stop.value, deadline);
      if (!client_result && i == 2) EncodeCellInstallCapacityChallenge(expected, 1, &incoming);
      if (!client_result) client_result = WriteCellControllerMessage(client.value,
        mode == "wrong-kind" ? CellControllerMessage::install_authorized : CellControllerMessage::install_capacity_authorized,
        incoming.data(), mode == "wrong-kind" ? 136 : static_cast<DWORD>(incoming.size()), stop.value, deadline);
      if (mode == "wrong-kind") break;
    }
  } else {
    client_result = channel.Reply({&authority, Authority::Current});
    if (!client_result && mode == "switch-role") client_result = channel.Request();
    if (!client_result) client_result = channel.Reply({&authority, Authority::Current});
    if (!client_result && mode.starts_with("terminal")) {
      client_result = Authority::Current(&authority, expected, 3);
      auto finish = expected.connection;
      if (mode == "terminal-wrong-nonce") finish[0] ^= 1;
      if (!client_result) client_result = WriteCellControllerMessage(client.value, CellControllerMessage::finish,
        finish.data(), 32, stop.value, deadline);
    }
    if (client_result) { client_retry = channel.Reply({&authority, Authority::Current}); SetEvent(stop.value); }
  }
  thread.join();
  const bool success = mode == "success" || mode == "attest" || mode == "terminal";
  Check(success ? !server_result && !client_result && authority.calls == (mode == "terminal" ? 3u : 2u) : server_result != ERROR_SUCCESS, "only current matching reservation completes both checks");
  if (mode.starts_with("terminal")) Check(server_retry == ERROR_INVALID_STATE, "terminal signer cannot be reused");
  if (!success) Check(server_retry == ERROR_INVALID_STATE, "failed controller channel cannot retry");
  if (client_result && mode != "replay" && mode != "wrong-kind") Check(client_retry == ERROR_INVALID_STATE, "failed client channel cannot retry");
  if (mode == "wrong-binding") Check(authority.calls == 0, "foreign capture never reaches canonical owner");
  if (mode == "deny" || mode == "reentrant" || mode == "switch-role") Check(authority.calls == 1, "refused exchange invokes canonical owner at most once");
  if (mode == "replay") Check(!first_result && server_result == ERROR_INVALID_DATA, "second reply cannot reuse the first ordinal");
  if (mode == "wrong-kind") Check(server_result == ERROR_INVALID_DATA, "legacy installation acknowledgement cannot authorize capacity");
}
}
int main() {
  try {
    unsigned sequence = 0;
    for (const auto mode : {"success", "attest", "terminal", "terminal-wrong-nonce", "wrong-binding", "deny", "reentrant", "switch-role", "replay", "wrong-kind"}) Exchange(mode, ++sequence);
    for (unsigned mode = 0; mode < 4; ++mode) {
      Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
      auto binding = Binding(); if (mode == 0) binding.connection.fill(0);
      if (mode == 1) SetEvent(stop.value);
      const auto deadline = mode == 2 ? GetTickCount64() : GetTickCount64() + 5000;
      CellInstallCapacityPipe channel(INVALID_HANDLE_VALUE, stop.value, deadline, binding, {mode == 3 ? nullptr : Authority::Local, nullptr, stop.value});
      Check(channel.Request() != ERROR_SUCCESS, "invalid channel refuses before I/O");
      Check(channel.Request() == ERROR_INVALID_STATE, "invalid channel stays poisoned");
    }
    std::printf("{\"passed\":true,\"checks\":%u,\"installedService\":false,\"volumeOperations\":false}\n", checks);
    return 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); return 1; }
}
