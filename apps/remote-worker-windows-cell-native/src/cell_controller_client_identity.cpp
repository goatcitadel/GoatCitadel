#include "cell_controller_client_identity.hpp"
#include <algorithm>
#include <cstring>

namespace goatcitadel::worker_cell {
namespace {
struct Handle final { HANDLE value = nullptr; ~Handle() { if (value) CloseHandle(value); } };
bool SameLuid(const LUID& a, const LUID& b) noexcept { return a.LowPart == b.LowPart && a.HighPart == b.HighPart; }
bool CurrentWorker(CellControllerToken* output) noexcept {
  worker_host::TokenIdentity worker;
  Handle token;
  return worker_host::CollectWorkerToken(&worker) && worker_host::ValidateWorkerToken(worker) &&
    OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value) && CollectCellControllerToken(token.value, output);
}
}
DWORD EncodeCellControllerCustodySnapshot(const std::wstring& parent_path,
  const CellControllerCustodyRecord& custody, std::vector<std::uint8_t>* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  output->clear();
  try {
    if (parent_path.empty() || parent_path.size() > 8192 || !IsLiteralCellPath(parent_path)) return ERROR_INVALID_DATA;
    const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, parent_path.data(),
      static_cast<int>(parent_path.size()), nullptr, 0, nullptr, nullptr);
    if (size <= 0 || size > 8192) return ERROR_INVALID_DATA;
    std::vector<std::uint8_t> record(120);
    std::memcpy(record.data(), "GCCUST01", 8);
    std::copy(custody.image_sha256.begin(), custody.image_sha256.end(), record.begin() + 8);
    std::copy(custody.provisioning_sha256.begin(), custody.provisioning_sha256.end(), record.begin() + 40);
    const auto write_identity = [&](std::size_t offset, const CellFileIdentity& identity) {
      for (unsigned index = 0; index < 8; ++index)
        record[offset + index] = static_cast<std::uint8_t>(identity.volume_serial >> (8 * index));
      std::copy(identity.file_id.begin(), identity.file_id.end(), record.begin() + offset + 8);
    };
    write_identity(72, custody.native_directory); write_identity(96, custody.parent);
    CellControllerCustodyRecord verified;
    if (!DecodeCellControllerCustody(record, &verified)) return ERROR_INVALID_DATA;
    std::vector<std::uint8_t> frame(132 + static_cast<std::size_t>(size));
    std::memcpy(frame.data(), "GCCINF01", 8);
    for (unsigned index = 0; index < 4; ++index) frame[8 + index] = static_cast<std::uint8_t>(static_cast<unsigned>(size) >> (8 * index));
    std::copy(record.begin(), record.end(), frame.begin() + 12);
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, parent_path.data(), static_cast<int>(parent_path.size()),
        reinterpret_cast<char*>(frame.data() + 132), size, nullptr, nullptr) != size) return ERROR_INVALID_DATA;
    *output = std::move(frame);
    return ERROR_SUCCESS;
  } catch (...) { output->clear(); return ERROR_NOT_ENOUGH_MEMORY; }
}
CellControllerServerIdentity::~CellControllerServerIdentity() { Close(); }
DWORD CellControllerServerIdentity::Prepare() noexcept {
  if (prepared_ || open_) return ERROR_ALREADY_INITIALIZED;
  const auto refuse = [&](DWORD error) { Close(); return error; };
  if (!CurrentWorker(&worker_)) return refuse(ERROR_ACCESS_DENIED);
  DWORD error = installed_.Open();
  if (!error) error = installed_.VerifyProvisioningProcess(GetCurrentProcess());
  if (error) return refuse(error);
  prepared_ = true;
  error = VerifyWorker();
  return error ? refuse(error) : ERROR_SUCCESS;
}
DWORD CellControllerServerIdentity::ReadCustodySnapshot(std::vector<std::uint8_t>* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  output->clear();
  DWORD error = VerifyWorker();
  if (!error) error = EncodeCellControllerCustodySnapshot(installed_.ParentPath(), installed_.Custody(), output);
  if (!error) error = VerifyWorker();
  if (error) output->clear();
  return error;
}
DWORD CellControllerServerIdentity::VerifyWorker() noexcept {
  if (!prepared_) return ERROR_INVALID_STATE;
  CellControllerToken current;
  if (!CurrentWorker(&current) || current.type != TokenPrimary || !SameLuid(worker_.token_id, current.token_id)) return ERROR_ACCESS_DENIED;
  // Compare all original groups and privilege attributes, ignoring only the OS
  // USED_FOR_ACCESS telemetry bit. This changes a projection, never an OS token.
  current.type = TokenImpersonation;
  if (!MatchCellPipeToken(worker_, current)) return ERROR_ACCESS_DENIED;
  DWORD error = installed_.Verify();
  return error ? error : installed_.VerifyProvisioningProcess(GetCurrentProcess());
}
bool CellControllerServerIdentity::CurrentService() noexcept {
  if (!service_ || !server_.ProcessId()) return false;
  worker_host::ServiceConfiguration config;
  worker_host::ServiceObjectSecurity security;
  SERVICE_STATUS_PROCESS status{}; DWORD size = 0;
  return QueryServiceStatusEx(service_, SC_STATUS_PROCESS_INFO, reinterpret_cast<LPBYTE>(&status), sizeof(status), &size) &&
    status.dwProcessId == server_.ProcessId() && status.dwServiceType == SERVICE_WIN32_OWN_PROCESS &&
    status.dwCurrentState == SERVICE_RUNNING && !status.dwServiceFlags &&
    worker_host::CollectServiceConfiguration(service_, &config) &&
    ValidateCellControllerConfiguration(config, installed_.QuotedImagePath(), SERVICE_RUNNING) &&
    worker_host::CollectServiceObjectSecurity(service_, &security) && worker_host::ValidateServiceObject(security);
}
DWORD CellControllerServerIdentity::Open(HANDLE pipe) noexcept {
  if (open_ || service_ || manager_) return ERROR_ALREADY_INITIALIZED;
  DWORD error = VerifyWorker();
  if (!error) error = server_.Open(pipe);
  const auto refuse = [&](DWORD value) { Close(); return value; };
  if (error) return refuse(error);
  manager_ = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
  if (!manager_) return refuse(ERROR_ACCESS_DENIED);
  service_ = OpenServiceW(manager_, kCellControllerServiceName, worker_host::kWorkerServiceRead);
  if (!service_) return refuse(ERROR_ACCESS_DENIED);
  open_ = true;
  error = Verify();
  return error ? refuse(error) : ERROR_SUCCESS;
}
DWORD CellControllerServerIdentity::Verify() noexcept {
  if (!open_) return ERROR_INVALID_STATE;
  DWORD error = VerifyWorker();
  if (!error) error = server_.Verify();
  Handle token; CellControllerToken controller;
  if (!error && (!OpenProcessToken(server_.Process(), TOKEN_QUERY, &token.value) ||
      !CollectCellControllerToken(token.value, &controller) || !ValidateCellControllerToken(controller, true) || !CurrentService()))
    error = ERROR_ACCESS_DENIED;
  if (!error) error = installed_.VerifyControllerProcess(server_.Process());
  // Inspecting SCM and files can take time; repeat process/pipe/token liveness
  // before permitting the caller's next I/O. It still needs canonical authority.
  return error ? error : server_.Verify();
}
void CellControllerServerIdentity::Close() noexcept {
  prepared_ = open_ = false;
  server_.Close(); installed_.Close(); worker_ = {};
  if (service_) CloseServiceHandle(service_);
  if (manager_) CloseServiceHandle(manager_);
  service_ = manager_ = nullptr;
}
DWORD CellControllerServerIdentity::VerifyBoundPipe(CellPipeServerEvidence& additional) noexcept {
  DWORD error = Verify();
  if (!error) error = server_.VerifySameProcess(additional);
  return error ? error : Verify();
}
}
