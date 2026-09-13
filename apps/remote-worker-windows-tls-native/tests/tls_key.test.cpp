#include "tls_key.hpp"
#include <cstdio>
#include <cstring>
#include <string>
using namespace goatcitadel::worker_tls;

int main(int argc, char** argv) {
  if (argc != 2) return 2;
  KeyAuthority authority{};
  if (!DecodeIdentifier(argv[1], &authority)) return 3;
  const std::string identifier(argv[1]);
  for (std::size_t i = 0; i < identifier.size(); ++i) {
    KeyAuthority rejected{};
    if (DecodeIdentifier(identifier.substr(0, i).c_str(), &rejected)) return 4;
  }
  std::array<std::uint8_t, 146> preimage{};
  for (std::size_t i = 0; i < 64; ++i) preimage[i] = 0x20;
  constexpr char purpose[] = "TLS 1.3, client CertificateVerify";
  std::memcpy(preimage.data() + 64, purpose, sizeof(purpose));
  std::array<std::uint8_t, kRequestBytes> request{};
  for (const std::size_t length : {130U, 146U}) {
    if (!BuildRequest(authority, preimage.data(), length, &request)) return 5;
    constexpr std::uint8_t header[] = {0x47,0x43,0x50,0x57,1,0,0x15,0,1,0,0,0,0x18,1,0,0};
    if (std::memcmp(request.data(), header, sizeof(header)) || request[66] != 4 || request[108] != length ||
        std::memcmp(request.data() + 144, preimage.data(), length)) return 6;
    for (std::size_t i = 144 + length; i < request.size(); ++i) if (request[i]) return 7;
  }
  for (std::size_t i = 0; i < 98; ++i) {
    preimage[i] ^= 1;
    if (BuildRequest(authority, preimage.data(), preimage.size(), &request)) return 8;
    preimage[i] ^= 1;
  }
  std::array<std::uint8_t, kResponseBytes> response{};
  constexpr std::uint8_t header[] = {0x47,0x43,0x50,0x57,1,0,0x95,0,1,0,0,0,184,0,0,0,1,0,1,0};
  std::memcpy(response.data(), header, sizeof(header));
  std::memcpy(response.data() + 24, authority.receipt.data(), 32);
  std::memcpy(response.data() + 56, authority.spki_sha256.data(), 32);
  std::memcpy(response.data() + 88, authority.spki.data(), 44);
  response[132] = 1;
  std::array<std::uint8_t, 64> signature{};
  if (!DecodeResponse(authority, response, &signature)) return 9;
  for (std::size_t i = 0; i < response.size(); ++i) {
    if (i >= 132 && i < 196) continue;  // The engine independently verifies these signature bytes.
    response[i] ^= 1;
    if (DecodeResponse(authority, response, &signature)) return 10;
    for (const auto byte : signature) if (byte) return 11;
    response[i] ^= 1;
  }
  std::printf("Native identifier truncation corpus and TLS wire checks passed.\n");
  return 0;
}
