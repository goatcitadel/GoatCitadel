#include "local_transport.hpp"
#include "protocol.hpp"
#include <sddl.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace gc = goatcitadel::remote_worker_provisioner;
namespace {
int failures = 0;
unsigned checks = 0;
void Check(bool value, const char* message) noexcept {
  ++checks;
  if (!value) { ++failures; std::fprintf(stderr, "FAIL: caller authority %s\n", message); }
}
gc::SidProjection Sid(const wchar_t* text) noexcept {
  PSID sid = nullptr;
  gc::SidProjection result;
  if (!ConvertStringSidToSidW(text, &sid)) { Check(false, "fixture SID"); return result; }
  result.length = static_cast<std::uint16_t>(GetLengthSid(sid));
  if (result.length <= result.bytes.size()) std::memcpy(result.bytes.data(), sid, result.length);
  LocalFree(sid);
  return result;
}
gc::TokenProjection Worker() noexcept {
  gc::TokenProjection value;
  value.user = Sid(L"S-1-5-80-1804173726-3601835665-1843708740-3959121232-3866049905");
  value.logon = Sid(L"S-1-5-5-123-456");
  value.logon_sid_attributes = SE_GROUP_LOGON_ID | SE_GROUP_ENABLED | SE_GROUP_ENABLED_BY_DEFAULT | SE_GROUP_MANDATORY;
  value.authentication_id_low = 789;
  value.session_id = 0;
  value.elevation_type = TokenElevationTypeDefault;
  value.integrity_rid = SECURITY_MANDATORY_SYSTEM_RID;
  return value;
}
}
namespace {
void TestPipeRestartReadiness() noexcept {
  struct Fixture final {
    std::array<wchar_t, 180U> name{};
    HANDLE release = nullptr;
    HANDLE observed = nullptr;
    bool connected = false;
  } fixture;
  swprintf_s(fixture.name.data(), fixture.name.size(),
      L"\\\\.\\pipe\\LOCAL\\GoatCitadel.RestartFixture.%lu.%llu", GetCurrentProcessId(), GetTickCount64());
  fixture.release = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  fixture.observed = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  Check(fixture.release != nullptr && fixture.observed != nullptr, "pipe fixture events");
  if (!fixture.release || !fixture.observed) {
    if (fixture.release) CloseHandle(fixture.release);
    if (fixture.observed) CloseHandle(fixture.observed);
    return;
  }
  HANDLE thread = CreateThread(nullptr, 0U, [](void* raw) noexcept -> DWORD {
    auto& current = *static_cast<Fixture*>(raw);
    if (WaitForSingleObject(current.release, 100U) != WAIT_TIMEOUT) return 1U;
    HANDLE pipe = CreateNamedPipeW(current.name.data(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
        PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        1U, 512U, 512U, 0U, nullptr);
    if (pipe == INVALID_HANDLE_VALUE) return 2U;
    OVERLAPPED operation{};
    operation.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    bool connected = operation.hEvent && ConnectNamedPipe(pipe, &operation);
    const DWORD error = GetLastError();
    if (!connected && error == ERROR_PIPE_CONNECTED) connected = true;
    if (!connected && operation.hEvent && error == ERROR_IO_PENDING) {
      const HANDLE waits[] = {operation.hEvent, current.release};
      if (WaitForMultipleObjects(2U, waits, FALSE, 3000U) == WAIT_OBJECT_0) {
        DWORD transferred = 0U;
        connected = GetOverlappedResult(pipe, &operation, &transferred, FALSE) != FALSE;
      } else {
        CancelIoEx(pipe, &operation);
        DWORD transferred = 0U;
        GetOverlappedResult(pipe, &operation, &transferred, TRUE);
      }
    }
    current.connected = connected;
    SetEvent(current.observed);
    if (connected) WaitForSingleObject(current.release, 3000U);
    if (operation.hEvent) CloseHandle(operation.hEvent);
    CloseHandle(pipe);
    return connected ? 0U : 3U;
  }, &fixture, 0U, nullptr);
  Check(thread != nullptr, "pipe fixture thread");
  if (thread) {
    HANDLE client = gc::OpenProtectedClientPipeForTest(fixture.name.data(), 2000U);
    Check(client != nullptr && client != INVALID_HANDLE_VALUE, "client waits for pipe recreation before its sole exchange");
    if (client && client != INVALID_HANDLE_VALUE)
      Check(WaitForSingleObject(fixture.observed, 1000U) == WAIT_OBJECT_0, "server observes the delayed client");
    if (client && client != INVALID_HANDLE_VALUE) CloseHandle(client);
    SetEvent(fixture.release);
    const DWORD joined = WaitForSingleObject(thread, 5000U);
    Check(joined == WAIT_OBJECT_0, "pipe fixture stops within deadline");
    if (joined != WAIT_OBJECT_0) std::abort();
    Check(fixture.connected, "actual delayed pipe connection completed");
    CloseHandle(thread);
  }
  CloseHandle(fixture.release);
  CloseHandle(fixture.observed);
  const auto start = GetTickCount64();
  HANDLE missing = gc::OpenProtectedClientPipeForTest(fixture.name.data(), 80U);
  Check(missing == nullptr, "missing signer still refuses after bounded wait");
  Check(GetTickCount64() - start >= 70U && GetTickCount64() - start < 2000U,
      "missing-instance retries share the original deadline");
  if (missing && missing != INVALID_HANDLE_VALUE) CloseHandle(missing);
}
}

int RunProtectedCallerAuthorityTests() noexcept {
  const int initial = failures;
  const auto worker = Worker();
  Check(gc::ClassifyProtectedCaller(worker) == gc::ProtectedCallerRole::RuntimeWorker, "dedicated service role");
  auto administrator = worker;
  administrator.user = Sid(L"S-1-5-21-123-456-789-1001");
  administrator.session_id = 1;
  administrator.elevation_type = TokenElevationTypeFull;
  administrator.integrity_rid = SECURITY_MANDATORY_HIGH_RID;
  administrator.administrators_sid_attributes = SE_GROUP_ENABLED | SE_GROUP_ENABLED_BY_DEFAULT | SE_GROUP_MANDATORY;
  Check(gc::ClassifyProtectedCaller(administrator) == gc::ProtectedCallerRole::InteractiveOperator, "operator role retained");
  for (unsigned opcode = 0; opcode <= 255; ++opcode) {
    const auto code = static_cast<std::uint8_t>(opcode);
    const bool runtime = code == static_cast<std::uint8_t>(gc::Opcode::Inspect) ||
      code == static_cast<std::uint8_t>(gc::Opcode::SignRuntimePopV2) ||
      code == static_cast<std::uint8_t>(gc::Opcode::SignTlsClientCertificateVerify);
    Check(gc::IsProtectedCallerOperationAllowed(gc::ProtectedCallerRole::RuntimeWorker, code) == runtime,
      "worker has only inspect and runtime signing");
    Check(!gc::IsProtectedCallerOperationAllowed(gc::ProtectedCallerRole::Refused, code), "refused caller has no operation");
    const bool admin = opcode < 64 && (gc::kGcpaCallableOpcodeBitmap & (UINT64_C(1) << opcode)) != 0;
    Check(gc::IsProtectedCallerOperationAllowed(gc::ProtectedCallerRole::InteractiveOperator, code) == admin,
      "operator retains exact callable operations");
  }
  Check(gc::ProtectedCallerCallableOpcodes(gc::ProtectedCallerRole::RuntimeWorker) == UINT64_C(0x300002), "worker advertisement");
  Check(gc::ProtectedCallerCallableOpcodes(static_cast<gc::ProtectedCallerRole>(255)) == 0, "unknown role refused");
  for (unsigned mutation = 0; mutation < 12; ++mutation) {
    auto changed = worker;
    switch (mutation) {
      case 0: changed.user = Sid(L"S-1-5-18"); break;
      case 1: changed.user.bytes[changed.user.length - 1] ^= 1; break;
      case 2: changed.session_id = 1; break;
      case 3: changed.elevation_type = TokenElevationTypeFull; break;
      case 4: changed.administrators_sid_attributes = SE_GROUP_USE_FOR_DENY_ONLY; break;
      case 5: changed.has_restricted_sids = true; break;
      case 6: changed.logon_sid_attributes |= SE_GROUP_USE_FOR_DENY_ONLY; break;
      case 7: changed.logon_sid_attributes &= ~SE_GROUP_ENABLED; break;
      case 8: changed.logon = Sid(L"S-1-5-6"); break;
      case 9: changed.user.length = 1; break;
      case 10: changed.authentication_id_low = 0; break;
      case 11: changed.integrity_rid = SECURITY_MANDATORY_MEDIUM_RID; break;
    }
    Check(gc::ClassifyProtectedCaller(changed) == gc::ProtectedCallerRole::Refused, "worker identity substitution refused");
  }
  administrator.administrators_sid_attributes = SE_GROUP_USE_FOR_DENY_ONLY;
  Check(gc::ClassifyProtectedCaller(administrator) == gc::ProtectedCallerRole::Refused, "filtered administrator refused");
  for (const auto role : {gc::ProtectedCallerRole::InteractiveOperator, gc::ProtectedCallerRole::RuntimeWorker}) {
    gc::GcpaServerHelloFields hello;
    hello.service_start_nonce.fill(1);
    hello.connection_nonce.fill(2);
    hello.client_nonce.fill(3);
    hello.recognized_operation_bitmap = gc::kGcpaRecognizedOpcodeBitmap;
    hello.callable_operation_bitmap = gc::ProtectedCallerCallableOpcodes(role);
    std::array<std::uint8_t, gc::kGcpaHeaderBytes + gc::kGcpaServerHelloPayloadBytes> bytes{};
    std::size_t length = 0;
    gc::GcpaServerHelloFields decoded;
    Check(gc::EncodeGcpaServerHello(hello, bytes.data(), bytes.size(), &length) &&
        gc::DecodeGcpaServerHello(bytes.data(), length, &decoded) &&
        decoded.callable_operation_bitmap == hello.callable_operation_bitmap, "role advertisement roundtrip");
    hello.callable_operation_bitmap |= UINT64_C(1) << 63;
    Check(!gc::EncodeGcpaServerHello(hello, bytes.data(), bytes.size(), &length), "extra advertised authority refused");
    bytes.back() = 0x80;
    Check(!gc::DecodeGcpaServerHello(bytes.data(), bytes.size(), &decoded), "injected advertisement refused");
  }
  SECURITY_ATTRIBUTES attributes{};
  SECURITY_DESCRIPTOR descriptor{};
  alignas(16) std::array<std::uint8_t, 512U> acl_storage{};
  Check(gc::BuildProtectedPipeSecurityForTest(&attributes, &descriptor, &acl_storage), "pipe descriptor builds");
  const auto first = reinterpret_cast<std::uintptr_t>(acl_storage.data());
  const auto owner = reinterpret_cast<std::uintptr_t>(descriptor.Owner);
  const bool retained_owner = owner >= first && owner - first <= acl_storage.size() - 12U;
  Check(retained_owner, "pipe owner SID belongs to retained descriptor storage");
  if (retained_owner) {
    const auto system = Sid(L"S-1-5-18");
    Check(EqualSid(descriptor.Owner, const_cast<std::uint8_t*>(system.bytes.data())) != FALSE &&
        attributes.lpSecurityDescriptor == &descriptor && !attributes.bInheritHandle,
        "retained pipe owner remains SYSTEM");
  }
  BOOL dacl_present = FALSE;
  BOOL dacl_defaulted = TRUE;
  PACL pipe_dacl = nullptr;
  Check(GetSecurityDescriptorDacl(&descriptor, &dacl_present, &pipe_dacl, &dacl_defaulted) != FALSE &&
      dacl_present && !dacl_defaulted && pipe_dacl && pipe_dacl->AceCount == 4U,
      "pipe admits exactly SYSTEM, signer, administrators and worker");
  const std::array<gc::SidProjection, 4U> pipe_sids = {
      Sid(L"S-1-5-18"),
      Sid(L"S-1-5-80-1765223994-2719708455-3112291649-2938929260-976374647"),
      Sid(L"S-1-5-32-544"), worker.user};
  for (DWORD index = 0U; pipe_dacl && index < pipe_sids.size(); ++index) {
    void* raw_ace = nullptr;
    const bool found = GetAce(pipe_dacl, index, &raw_ace) != FALSE && raw_ace;
    Check(found, "required pipe caller ACE exists");
    if (!found) continue;
    const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(raw_ace);
    Check(ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && ace->Header.AceFlags == 0U &&
        ace->Mask == 0x0012008BU &&
        EqualSid(const_cast<DWORD*>(&ace->SidStart),
            const_cast<std::uint8_t*>(pipe_sids[index].bytes.data())) != FALSE,
        "pipe caller receives only exact non-inherited read/write access");
    Check((ace->Mask & (FILE_CREATE_PIPE_INSTANCE | WRITE_DAC | WRITE_OWNER | DELETE)) == 0U,
        "pipe caller cannot create an instance or alter pipe ownership");
  }
  HANDLE process_token = nullptr;
  Check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &process_token) != FALSE, "current process token opens");
  if (process_token) {
    gc::TokenProjection actual;
    const bool admitted = gc::CaptureProtectedCallerForTest(process_token, &actual);
    Check(!admitted || gc::ClassifyProtectedCaller(actual) == gc::ProtectedCallerRole::InteractiveOperator,
      "interactive test process cannot become worker");
    CloseHandle(process_token);
  }
  TestPipeRestartReadiness();
#if defined(GOATCITADEL_CALLER_AUTHORITY_STANDALONE)
  std::printf("{\"callerAuthorityChecks\":%u,\"failures\":%d,\"installedService\":false}\n", checks, failures - initial);
#endif
  return failures - initial;
}

#if defined(GOATCITADEL_CALLER_AUTHORITY_STANDALONE)
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "secur32.lib")
int main() { return RunProtectedCallerAuthorityTests(); }
#endif
