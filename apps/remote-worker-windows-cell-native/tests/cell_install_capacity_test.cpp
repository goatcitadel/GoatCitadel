#include "cell_install_capacity.hpp"
#include "cell_install_capacity_stdio.hpp"
#include <algorithm>
#include <cstdio>
#include <stdexcept>
#include <string>

using namespace goatcitadel::worker_cell;
namespace goatcitadel::worker_cell {
struct CellInstallCapacityTestPeer final {
  template<class Owner> static RuntimeBundleInstallResult Run(Owner& owner, CellProvisioningJournal& journal,
      const CellControllerRequest& request, CellControllerMeasurementHold& hold, const CellFootprintScanLimits& limits,
      const CellFootprintScanGuard& guard, const CellInstallCapacityAdmission& admission, PinnedCellRuntimeBundle& output) {
    return CellInstallCapacity::Run({&owner, Owner::Capture, Owner::Copy}, journal, request, hold, limits, guard, admission, output);
  }
};
}
namespace {
unsigned checks = 0;
void Check(bool value, const char* message) { ++checks; if (!value) throw std::runtime_error(message); }
CellControllerRequest Request() {
  CellControllerRequest request; request.operation = kCellControllerPoolCapacityOperation; request.nonce.fill(1);
  request.anchor.file.volume_serial = 1; request.anchor.file.file_id.fill(2); request.anchor.prepared_sha256.fill(3);
  request.installation.nonce.fill(4); request.installation.checkpoint_sha256.fill(5);
  std::copy(request.installation.checkpoint_sha256.begin(), request.installation.checkpoint_sha256.end(), request.mounted_workspace_records.back().begin() + 992);
  auto& bytes = request.installation_bytes; std::memcpy(bytes.data(), "GCRINST1", 8);
  std::copy(request.installation.nonce.begin(), request.installation.nonce.end(), bytes.begin() + 8);
  std::memcpy(bytes.data() + 40, &request.anchor.file.volume_serial, 8);
  std::copy(request.anchor.file.file_id.begin(), request.anchor.file.file_id.end(), bytes.begin() + 48);
  std::copy(request.anchor.prepared_sha256.begin(), request.anchor.prepared_sha256.end(), bytes.begin() + 64);
  std::copy(request.installation.checkpoint_sha256.begin(), request.installation.checkpoint_sha256.end(), bytes.begin() + 96);
  std::fill(bytes.begin() + 128, bytes.begin() + 160, std::uint8_t{6});
  std::vector<CellRuntimeBundleFile> files{{L"node.exe", 100, {}}, {L"worker-host-receipt.json", 20, {}}};
  files[0].sha256.fill(7); files[1].sha256.fill(8); CellFileSha256 digest;
  Check(!HashRuntimeBundleManifest(files, &digest), "fixture manifest");
  std::copy(digest.begin(), digest.end(), bytes.begin() + 160);
  for (unsigned i = 0; i < 2; ++i) {
    std::memcpy(bytes.data() + 192 + i * 40, &files[i].bytes, 8);
    std::copy(files[i].sha256.begin(), files[i].sha256.end(), bytes.begin() + 200 + i * 40);
  }
  Check(!HashCellRuntimeInstall(bytes, &request.installation.request_sha256), "fixture request");
  return request;
}
struct Owner final : CellControllerMeasurementHold {
  std::string mode;
  unsigned captures = 0, reserves = 0, copies = 0, released = 0, reservation_checks = 0, hold_checks = 0;
  HANDLE stop = nullptr;
  CellControllerRequest* supplied = nullptr;
  DWORD Verify() noexcept override {
    ++hold_checks;
    return mode == "missing-exclusion" || (mode == "lost-exclusion" && reserves) ? ERROR_LOCK_VIOLATION : ERROR_SUCCESS;
  }
  static DWORD Authorize(void* raw) noexcept {
    const auto& self = *static_cast<Owner*>(raw);
    return self.mode == "revoked-authority" && self.captures ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
  struct Reservation final : CellInstallCapacityReservation {
    Owner& owner;
    explicit Reservation(Owner& value) : owner(value) {}
    ~Reservation() override { ++owner.released; }
    DWORD Verify() noexcept override {
      ++owner.reservation_checks;
      return owner.mode == "revoked-reservation" || (owner.mode == "mid-copy-revoke" && owner.copies) ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
    }
  };
  static DWORD Capture(void* raw, CellProvisioningJournal&, const CellControllerRequest& request,
      const CellFootprintScanLimits&, const CellFootprintScanGuard& guard, CellCapacityLayoutRecord* layout, CellPoolJoinedCapacity* captured) noexcept {
    auto& self = *static_cast<Owner*>(raw); ++self.captures;
    if (self.reserves || self.copies || !self.hold_checks || request.anchor.file.volume_serial != 1 ||
        request.operation != kCellControllerPoolCapacityOperation ||
        request.installation != CellControllerRuntimeBinding{} ||
        std::any_of(request.installation_bytes.begin(), request.installation_bytes.end(), [](auto byte) { return byte != 0; })) return ERROR_INVALID_DATA;
    const auto error = guard.authorize(guard.context); if (error) return error;
    if (self.mode == "capture-failed") return ERROR_DISK_FULL;
    if (self.mode == "mutated-input") self.supplied->installation_bytes.fill(0);
    layout->profile_sha256.fill(9); captured->guests.resize(2);
    return ERROR_SUCCESS;
  }
  static DWORD Reserve(void* raw, const CellControllerRequest& request, const CellCapacityLayoutRecord& layout,
      const CellPoolJoinedCapacity& captured, ULONGLONG deadline, std::unique_ptr<CellInstallCapacityReservation>* output) noexcept {
    auto& self = *static_cast<Owner*>(raw); ++self.reserves;
    if (self.captures != 1 || self.copies || layout.profile_sha256[0] != 9 || captured.guests.size() != 2 ||
        request.installation_bytes[0] != 'G' || deadline <= GetTickCount64()) return ERROR_INVALID_DATA;
    if (self.mode == "empty-reservation") return ERROR_SUCCESS;
    try { *output = std::make_unique<Reservation>(self); } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
    if (self.mode == "cancelled") SetEvent(self.stop);
    return self.mode == "admission-denied" ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
  static RuntimeBundleInstallResult Copy(void* raw, CellProvisioningJournal&, const CellControllerRequest& request,
      DWORD wall_ms, const CellFootprintScanGuard& guard, PinnedCellRuntimeBundle&) noexcept {
    auto& self = *static_cast<Owner*>(raw); ++self.copies; RuntimeBundleInstallResult result;
    result.files_created = 1; result.bytes_written = 60;
    if (self.reserves != 1 || !self.reservation_checks || self.released || !wall_ms || wall_ms > 10000 || request.installation_bytes[0] != 'G') {
      result.error = ERROR_INVALID_DATA; return result;
    }
    result.error = guard.authorize(guard.context);
    if (result.error) return result;
    result.files_created = 2; result.bytes_written = self.mode == "wrong-copy-result" ? 121 : 120; result.verified = true;
    return result;
  }
};
struct Stdio final {
  std::string mode;
  HANDLE stop = nullptr;
  CellInstallCapacityClientAdmission admission{};
  std::vector<std::uint8_t>* input = nullptr;
  std::vector<unsigned> frames;
  CellInstallCapacityChallenge challenge{};
  bool reentered = false;
  static DWORD Current(void* raw) noexcept {
    const auto& self = *static_cast<Stdio*>(raw);
    return self.mode == "revoked" && self.frames.size() >= 3 ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
  static DWORD Frame(void* raw, std::uint8_t kind, std::span<const std::uint8_t> bytes) noexcept {
    auto& self = *static_cast<Stdio*>(raw);
    try {
      self.frames.push_back(kind);
      if (kind == 16 && self.mode == "mutated-capture") self.input->assign(self.input->size(), 0);
      if (kind == 16 && self.mode == "reentrant") {
        std::unique_ptr<CellInstallCapacityReservation> output;
        self.reentered = self.admission.reserve(self.admission.context, {}, {}, 0, &output) == ERROR_INVALID_STATE;
      }
      if (kind == 17 && (bytes.size() != 1312 || bytes.back() != 0xab)) return ERROR_INVALID_DATA;
      if (kind == 18) {
        if (bytes.size() != self.challenge.size()) return ERROR_INVALID_DATA;
        std::copy(bytes.begin(), bytes.end(), self.challenge.begin());
        if (self.mode == "cancelled") SetEvent(self.stop);
      }
      return self.mode == "frame-failure" ? ERROR_BROKEN_PIPE : ERROR_SUCCESS;
    } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  }
  static DWORD Read(void* raw, std::span<std::uint8_t> bytes) noexcept {
    auto& self = *static_cast<Stdio*>(raw);
    if (self.mode == "read-failure") return ERROR_BROKEN_PIPE;
    if (bytes.size() != 149) return ERROR_INVALID_DATA;
    bytes[0] = 19; bytes[1] = 144;
    std::copy(self.challenge.begin(), self.challenge.end(), bytes.begin() + 5);
    if (self.mode == "wrong-echo") bytes[5 + 128] ^= 1;
    return ERROR_SUCCESS;
  }
};
void StdioCases() {
  for (const auto mode : {"success", "wrong-echo", "read-failure", "frame-failure", "revoked", "cancelled",
      "mutated-capture", "reentrant", "wrong-binding", "wrong-hash", "wrong-deadline"}) {
    Stdio owner; owner.mode = mode; owner.stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    Check(owner.stop != nullptr, "stdio cancellation event");
    CellControllerNonce connection{}; connection.fill(1);
    CellRuntimeInstallBinding installation{}; installation.nonce.fill(2); installation.request_sha256.fill(3);
    const auto deadline = GetTickCount64() + 10000;
    CellInstallCapacityStdio bridge(connection, installation, deadline, {Stdio::Current, &owner, owner.stop},
      {&owner, Stdio::Frame, Stdio::Read});
    owner.admission = bridge.Admission();
    std::vector<std::uint8_t> capture(1312); capture.back() = 0xab; owner.input = &capture;
    CellInstallCapacityBinding binding{connection, installation, {}, 1312};
    Check(!HashCellInstallCapacityCapture(capture, &binding.capture_sha256), "stdio full capture digest");
    if (owner.mode == "wrong-binding") binding.connection[0] ^= 1;
    if (owner.mode == "wrong-hash") binding.capture_sha256[0] ^= 1;
    std::unique_ptr<CellInstallCapacityReservation> reservation;
    auto error = owner.admission.reserve(owner.admission.context, capture, binding,
      owner.mode == "wrong-deadline" ? deadline + 1 : deadline, &reservation);
    if (!error) {
      Check(reservation != nullptr, "stdio capture retains challenge proxy");
      error = reservation->Verify();
      if (!error) error = reservation->Verify();
    }
    const bool success = owner.mode == "success" || owner.mode == "mutated-capture";
    Check(success ? !error : error != ERROR_SUCCESS, "only exact current parent replies authorize installation");
    if (success) Check(owner.frames == std::vector<unsigned>({16, 17, 18, 18}) && owner.challenge[128] == 2,
      "capture precedes exact consecutive authority challenges");
    if (owner.mode == "reentrant") Check(owner.reentered && !reservation, "reentrant capture poisons admission");
    if (owner.mode == "wrong-binding" || owner.mode == "wrong-hash" || owner.mode == "wrong-deadline")
      Check(owner.frames.empty(), "foreign capture refuses before parent I/O");
    std::unique_ptr<CellInstallCapacityReservation> retry;
    Check(owner.admission.reserve(owner.admission.context, capture, binding, deadline, &retry) == ERROR_INVALID_STATE && !retry,
      "stdio never retries capture admission");
    if (reservation) Check(reservation->Verify() == ERROR_INVALID_STATE, "failed or repeated admission poisons later checks");
    reservation.reset(); CloseHandle(owner.stop);
  }
}
}
int main() {
  try {
    StdioCases();
    for (const auto operation : {kCellControllerPoolCapacityOperation, kCellControllerInstallCapacityOperation})
    for (const auto mode : {"success", "mutated-input", "missing-exclusion", "lost-exclusion", "revoked-authority",
        "capture-failed", "empty-reservation", "admission-denied", "cancelled", "revoked-reservation", "mid-copy-revoke",
        "wrong-copy-result", "wrong-binding", "missing-admission", "invalid-deadline"}) {
      Owner owner; owner.mode = mode; owner.stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
      Check(owner.stop != nullptr, "cancellation event"); auto request = Request(); owner.supplied = &request;
      request.operation = operation;
      CellFootprintScanLimits limits{20000, 64, 10000}; CellInstallCapacityAdmission admission{&owner, Owner::Reserve};
      if (owner.mode == "wrong-binding") request.anchor.file.volume_serial++;
      if (owner.mode == "missing-admission") admission.reserve = nullptr;
      if (owner.mode == "invalid-deadline") limits.wall_limit_ms = 60001;
      CellProvisioningJournal journal; PinnedCellRuntimeBundle output;
      const auto result = CellInstallCapacityTestPeer::Run(owner, journal, request, owner, limits, {Owner::Authorize, &owner, owner.stop}, admission, output);
      const bool success = owner.mode == "success" || owner.mode == "mutated-input";
      Check(success ? !result.error && result.verified && result.bytes_written == 120 : result.error && !result.verified, "only complete authorized copy succeeds");
      Check(owner.released == (owner.reserves && owner.mode != "empty-reservation" ? 1u : 0u), "owned reservation releases on every exit");
      const bool copied = success || owner.mode == "mid-copy-revoke" || owner.mode == "wrong-copy-result";
      Check(owner.copies == (copied ? 1u : 0u), "failed preflight never copies");
      if (owner.mode == "mid-copy-revoke") Check(result.files_created == 1 && result.bytes_written == 60, "partial copy counters survive revocation");
      if (owner.mode == "wrong-binding" || owner.mode == "missing-admission" || owner.mode == "invalid-deadline")
        Check(!owner.captures && !owner.reserves, "invalid input has no collector or admission effects");
      CloseHandle(owner.stop);
    }
    std::printf("{\"passed\":true,\"checks\":%u,\"installedService\":false,\"volumeOperations\":false}\n", checks);
    return 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); return 1; }
}
