#include "tls_key.hpp"
#include <bcrypt.h>
#include <cstring>
#include <limits>

namespace goatcitadel::worker_tls {
namespace {
template<std::size_t N> bool Nonzero(const std::array<std::uint8_t,N>& bytes) noexcept {
  for (const auto byte:bytes) if (byte!=0) return true;
  return false;
}
std::uint16_t U16(const std::uint8_t* bytes) noexcept { return static_cast<std::uint16_t>(bytes[0]|(bytes[1]<<8)); }
void Put32(std::uint8_t* bytes,std::uint32_t value) noexcept { for (std::size_t i=0;i<4;i++) bytes[i]=static_cast<std::uint8_t>(value>>(8*i)); }
bool ValidPath(const wchar_t* path,std::size_t length) noexcept {
  if (length<4 || length>kMaximumHelperPathCharacters ||
      !((path[0]>=L'A'&&path[0]<=L'Z')||(path[0]>=L'a'&&path[0]<=L'z')) || path[1]!=L':' || path[2]!=L'\\') return false;
  std::size_t start=3;
  for (std::size_t i=3;i<=length;i++) {
    const wchar_t c=path[i];
    if (i==length || c==L'\\') {
      if (i==start || path[i-1]==L'.' || path[i-1]==L' ') return false;
      wchar_t name[5]{}; std::size_t n=0;
      while (start+n<i && path[start+n]!=L'.' && n<4) { const wchar_t v=path[start+n]; name[n++]=(v>=L'a'&&v<=L'z')?static_cast<wchar_t>(v-32):v; }
      const bool short_name=start+n==i || path[start+n]==L'.';
      if (short_name && ((n==3 && (std::memcmp(name,L"CON",6)==0 || std::memcmp(name,L"PRN",6)==0 ||
          std::memcmp(name,L"AUX",6)==0 || std::memcmp(name,L"NUL",6)==0)) ||
          (n==4 && (std::memcmp(name,L"COM",6)==0 || std::memcmp(name,L"LPT",6)==0) && name[3]>=L'1'&&name[3]<=L'9'))) return false;
      start=i+1; continue;
    }
    if (c<32 || c==L'<' || c==L'>' || c==L'"' || c==L'|' || c==L'?' || c==L'*' || c==L'/' || c==L':') return false;
    if (c>=0xd800 && c<=0xdbff) {
      if (++i>=length || path[i]<0xdc00 || path[i]>0xdfff) return false;
    } else if (c>=0xdc00 && c<=0xdfff) return false;
  }
  return true;
}
}
bool HashBytes(const std::uint8_t* bytes,std::size_t length,std::array<std::uint8_t,32>* hash) noexcept {
  if (!bytes || !hash || length>std::numeric_limits<ULONG>::max()) return false;
  hash->fill(0);
  return BCryptHash(BCRYPT_SHA256_ALG_HANDLE,nullptr,0,const_cast<PUCHAR>(bytes),static_cast<ULONG>(length),hash->data(),32)>=0;
}
bool DecodeIdentifier(const char* identifier,KeyAuthority* output) noexcept {
  if (!identifier || !output) return false;
  *output={};
  std::size_t length=0;
  while (length<=kMaximumIdentifierCharacters && identifier[length]!='\0') ++length;
  constexpr auto prefix_length=sizeof(kKeyPrefix)-1;
  if (length>kMaximumIdentifierCharacters || length<prefix_length+392 ||
      (length-prefix_length)%2!=0 || std::memcmp(identifier,kKeyPrefix,prefix_length)!=0) return false;
  const auto byte_length=(length-prefix_length)/2;
  std::array<std::uint8_t,kMaximumKeyBytes> bytes{};
  for (std::size_t i=0;i<byte_length*2;i++) {
    const char c=identifier[prefix_length+i];
    const int v=c>='0'&&c<='9'?c-'0':c>='a'&&c<='f'?c-'a'+10:-1;
    if (v<0) return false;
    bytes[i/2]=static_cast<std::uint8_t>(bytes[i/2]*16+v);
  }
  if (std::memcmp(bytes.data(),"GCTK",4)!=0 || U16(bytes.data()+4)!=1) return false;
  const auto path_length=U16(bytes.data()+6);
  if (path_length>kMaximumHelperPathCharacters || byte_length!=kKeyHeaderBytes+path_length*2) return false;
  KeyAuthority local{};
  for (std::size_t i=0;i<8;i++) local.generation|=static_cast<std::uint64_t>(bytes[8+i])<<(8*i);
  if (local.generation==0 || local.generation>9007199254740991ULL) return false;
  std::memcpy(local.state.data(),bytes.data()+16,32); std::memcpy(local.receipt.data(),bytes.data()+48,32);
  std::memcpy(local.spki_sha256.data(),bytes.data()+80,32); std::memcpy(local.spki.data(),bytes.data()+112,44);
  std::memcpy(local.helper_sha256.data(),bytes.data()+156,32);
  for (std::size_t i=0;i<path_length;i++) local.helper_path[i]=static_cast<wchar_t>(U16(bytes.data()+188+i*2));
  constexpr std::uint8_t prefix[]={0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00};
  std::array<std::uint8_t,32> computed{};
  bool public_nonzero=false; for (std::size_t i=12;i<44;i++) public_nonzero=public_nonzero||local.spki[i]!=0;
  if (!Nonzero(local.state)||!Nonzero(local.receipt)||!Nonzero(local.helper_sha256)||!public_nonzero ||
      std::memcmp(local.spki.data(),prefix,sizeof(prefix))!=0 || !ValidPath(local.helper_path.data(),path_length) ||
      !HashBytes(local.spki.data(),local.spki.size(),&computed) || computed!=local.spki_sha256) return false;
  *output=local;
  return true;
}
bool IsClientCertificateVerify(const std::uint8_t* bytes,std::size_t length) noexcept {
  if (!bytes || (length!=130 && length!=146)) return false;
  for (std::size_t i=0;i<64;i++) if (bytes[i]!=0x20) return false;
  constexpr char purpose[]="TLS 1.3, client CertificateVerify";
  return std::memcmp(bytes+64,purpose,sizeof(purpose))==0;
}
bool BuildRequest(const KeyAuthority& authority,const std::uint8_t* preimage,std::size_t length,
    std::array<std::uint8_t,kRequestBytes>* request) noexcept {
  if (!request) return false;
  request->fill(0);
  if (!IsClientCertificateVerify(preimage,length)) return false;
  auto* bytes=request->data(); std::memcpy(bytes,"GCPW",4); bytes[4]=1; bytes[6]=0x15; bytes[8]=1; Put32(bytes+12,280);
  auto* body=bytes+16; std::memcpy(body+16,authority.state.data(),32); body[48]=1; body[50]=4;
  for (std::size_t i=0;i<8;i++) body[52+i]=static_cast<std::uint8_t>(authority.generation>>(8*i));
  std::memcpy(body+60,authority.receipt.data(),32); Put32(body+92,static_cast<std::uint32_t>(length));
  std::memcpy(body+96,authority.spki_sha256.data(),32); std::memcpy(body+128,preimage,length);
  return true;
}
bool DecodeResponse(const KeyAuthority& authority,const std::array<std::uint8_t,kResponseBytes>& response,
    std::array<std::uint8_t,64>* signature) noexcept {
  if (!signature) return false;
  signature->fill(0);
  constexpr std::uint8_t header[]={0x47,0x43,0x50,0x57,1,0,0x95,0,1,0,0,0,184,0,0,0};
  const auto* body=response.data()+16;
  constexpr std::uint8_t result_header[]={1,0,1,0,0,0,0,0};
  if (std::memcmp(response.data(),header,sizeof(header))!=0 || std::memcmp(body,result_header,sizeof(result_header))!=0 ||
      std::memcmp(body+8,authority.receipt.data(),32)!=0 || std::memcmp(body+40,authority.spki_sha256.data(),32)!=0 ||
      std::memcmp(body+72,authority.spki.data(),44)!=0) return false;
  for (std::size_t i=180;i<184;i++) if (body[i]!=0) return false;
  std::memcpy(signature->data(),body+116,64);
  if (!Nonzero(*signature)) { signature->fill(0); return false; }
  return true;
}
}
