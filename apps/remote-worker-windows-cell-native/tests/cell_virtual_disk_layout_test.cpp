#include "cell_virtual_disk_layout.hpp"
#include <bcrypt.h>
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <functional>
#include <stdexcept>

using namespace goatcitadel::worker_cell;
namespace goatcitadel::worker_cell {
struct CellVirtualDiskLayoutTestPeer final {
  static DWORD Run(CellVirtualDiskLayout& owner, const CellDiskLayoutPlan& plan, const CellDiskLayoutCommitter& committer,
    DWORD (*verify)(void*) noexcept,
    DWORD (*io)(void*, DWORD, std::span<const std::uint8_t>, std::span<std::uint8_t>, DWORD*) noexcept,
    void* context, ULONGLONG deadline, HANDLE cancellation) {
    owner.plan_ = plan; owner.committer_ = committer; owner.records_.reserve(4);
    owner.attempted_ = true; owner.state_ = CellDiskLayoutState::unknown;
    return owner.Run({verify, io, context}, deadline, cancellation);
  }
};
}
namespace {
unsigned checks = 0;
std::vector<CellDiskLayoutCheckpoint> retained;
constexpr std::uint64_t mib = 1024 * 1024;
constexpr auto header_bytes = offsetof(DRIVE_LAYOUT_INFORMATION_EX, PartitionEntry);
constexpr DWORD volumes_ready = CTL_CODE(IOCTL_DISK_BASE, 0x0087, METHOD_BUFFERED, FILE_READ_ACCESS);
void Check(bool value, const char* message) {
  ++checks;
  if (!value) throw std::runtime_error(std::string(message) + " (layout check " + std::to_string(checks) + ")");
}
CellDiskLayoutPlan Plan() {
  CellDiskLayoutPlan value;
  value.disk.spec = {{0x11111111, 0x2222, 0x4333, {0x84, 5, 6, 7, 8, 9, 10, 11}}, 256 * mib, 384 * mib};
  value.disk.control.volume_serial = value.disk.backing.volume_serial = 101;
  value.disk.control.file_id.fill(0x21); value.disk.backing.file_id.fill(0x42);
  // Independently computed with Node's SHA256 and native little-endian GUIDs.
  value.gpt_disk_id = {0x42abdd4e, 0x4be2, 0x8f62, {0xbd, 0x6d, 0x3d, 0xaf, 0xae, 0xe7, 0x20, 0x85}};
  value.data_partition_id = {0x7b5304e5, 0x3926, 0x841f, {0xac, 0x32, 0xeb, 0x9e, 0x4b, 0x76, 0xe1, 0x0d}};
  return value;
}
// Independent OS response fixture, including real SDK field offsets. Production
// serializers/planners are not used to construct the expected disk readback.
std::vector<std::uint8_t> Layout(const CellDiskLayoutPlan& plan, unsigned count) {
  DRIVE_LAYOUT_INFORMATION_EX header{};
  header.PartitionStyle = count ? PARTITION_STYLE_GPT : PARTITION_STYLE_RAW;
  header.PartitionCount = count;
  if (count) {
    header.Gpt.DiskId = plan.gpt_disk_id; header.Gpt.MaxPartitionCount = 128;
    header.Gpt.StartingUsableOffset.QuadPart = 17408;
    header.Gpt.UsableLength.QuadPart = static_cast<LONGLONG>(plan.disk.spec.virtual_bytes - 34304);
  }
  std::vector<std::uint8_t> bytes(header_bytes + count * sizeof(PARTITION_INFORMATION_EX));
  std::memcpy(bytes.data(), &header, header_bytes);
  if (count) {
    PARTITION_INFORMATION_EX reserved{};
    reserved.PartitionStyle = PARTITION_STYLE_GPT; reserved.PartitionNumber = 1;
    reserved.StartingOffset.QuadPart = mib; reserved.PartitionLength.QuadPart = 16 * mib;
    reserved.Gpt.PartitionType = {0xe3c9e316, 0x0b5c, 0x4db8, {0x81, 0x7d, 0xf9, 0x2d, 0xf0, 0x02, 0x15, 0xae}};
    reserved.Gpt.PartitionId = {0x44444444, 0x5555, 0x4666, {0x87, 8, 9, 10, 11, 12, 13, 14}};
    constexpr wchar_t name[] = L"Microsoft reserved partition";
    std::copy(std::begin(name), std::end(name), reserved.Gpt.Name);
    std::memcpy(bytes.data() + header_bytes, &reserved, sizeof(reserved));
  }
  if (count == 2) {
    PARTITION_INFORMATION_EX data{};
    data.PartitionStyle = PARTITION_STYLE_GPT; data.PartitionNumber = 2;
    data.StartingOffset.QuadPart = 17 * mib; data.PartitionLength.QuadPart = static_cast<LONGLONG>(plan.disk.spec.virtual_bytes - 18 * mib);
    data.Gpt.PartitionType = {0xebd0a0a2, 0xb9e5, 0x4433, {0x87, 0xc0, 0x68, 0xb6, 0xb7, 0x26, 0x99, 0xc7}};
    data.Gpt.PartitionId = plan.data_partition_id; data.Gpt.Attributes = 0x8000000000000000ULL;
    constexpr wchar_t name[] = L"GoatCitadel cell";
    std::copy(std::begin(name), std::end(name), data.Gpt.Name);
    std::memcpy(bytes.data() + header_bytes + sizeof(data), &data, sizeof(data));
  }
  return bytes;
}
DRIVE_LAYOUT_INFORMATION_EX& Header(std::vector<std::uint8_t>& bytes) {
  return *reinterpret_cast<DRIVE_LAYOUT_INFORMATION_EX*>(bytes.data());
}
PARTITION_INFORMATION_EX& Part(std::vector<std::uint8_t>& bytes, std::size_t index = 0) {
  return *reinterpret_cast<PARTITION_INFORMATION_EX*>(bytes.data() + header_bytes + index * sizeof(PARTITION_INFORMATION_EX));
}
struct Fixture final {
  CellDiskLayoutPlan plan = Plan();
  CellVirtualDiskLayout owner;
  std::vector<std::uint8_t> current = Layout(plan, 0);
  std::vector<CellDiskLayoutCheckpoint> committed;
  unsigned writes = 0, io_calls = 0, verify_calls = 0, authority_calls = 0, waits = 0;
  unsigned fail_commit = 0, wrong_ack = 0, fail_io = 0, fail_verify = 0, fail_authority = 0;
  unsigned cancel_commit = 0;
  HANDLE cancellation = nullptr;
  bool input_valid = true, oversized = false, fail_after_write = false;
  std::function<void(Fixture&)> on_commit;
  static DWORD Authorize(void* context) noexcept {
    auto& self = *static_cast<Fixture*>(context);
    return ++self.authority_calls == self.fail_authority ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
  static DWORD Verify(void* context) noexcept {
    auto& self = *static_cast<Fixture*>(context);
    return ++self.verify_calls == self.fail_verify ? ERROR_FILE_INVALID : ERROR_SUCCESS;
  }
  static DWORD Io(void* context, DWORD code, std::span<const std::uint8_t> input, std::span<std::uint8_t> output, DWORD* used) noexcept {
    auto& self = *static_cast<Fixture*>(context); *used = 0;
    if (++self.io_calls == self.fail_io) return ERROR_IO_DEVICE;
    try {
      if (code == IOCTL_DISK_GET_DRIVE_LAYOUT_EX) {
        if (!input.empty() || output.size() < self.current.size()) return ERROR_INVALID_PARAMETER;
        std::copy(self.current.begin(), self.current.end(), output.begin());
        *used = static_cast<DWORD>(self.oversized ? output.size() + 1 : self.current.size());
      } else if (code == IOCTL_DISK_CREATE_DISK) {
        CREATE_DISK expected{}; expected.PartitionStyle = PARTITION_STYLE_GPT;
        expected.Gpt.DiskId = self.plan.gpt_disk_id; expected.Gpt.MaxPartitionCount = 128;
        self.input_valid = self.input_valid && input.size() == sizeof(expected) && output.empty() &&
          std::memcmp(input.data(), &expected, sizeof(expected)) == 0 && self.committed.size() == 1 && self.writes == 0;
        self.current = Layout(self.plan, 1); ++self.writes;
        if (self.fail_after_write) return ERROR_IO_DEVICE;
      } else if (code == IOCTL_DISK_SET_DRIVE_LAYOUT_EX) {
        auto expected = Layout(self.plan, 2); Part(expected).RewritePartition = Part(expected, 1).RewritePartition = TRUE;
        self.input_valid = self.input_valid && input.size() == expected.size() && output.size() == expected.size() &&
          std::equal(input.begin(), input.end(), expected.begin(), expected.end()) &&
          self.committed.size() == 3 && self.writes == 1 && self.waits == 1;
        self.current = Layout(self.plan, 2); ++self.writes;
        // The SET response is not accepted as readback authority.
        std::fill(output.begin(), output.end(), std::uint8_t{0xee}); *used = static_cast<DWORD>(output.size());
      } else if (code == volumes_ready) {
        self.input_valid = self.input_valid && input.empty() && output.empty() && self.writes == self.waits + 1;
        ++self.waits;
      } else if (code == IOCTL_DISK_UPDATE_PROPERTIES) {
        self.input_valid = self.input_valid && input.empty() && output.empty() && self.writes == self.waits + 1;
      } else return ERROR_INVALID_FUNCTION;
      return self.input_valid ? ERROR_SUCCESS : ERROR_INVALID_DATA;
    } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  }
  static DWORD Commit(void* context, const CellDiskLayoutCheckpoint& record, CellFileSha256* digest) noexcept {
    auto& self = *static_cast<Fixture*>(context);
    try {
      self.committed.push_back(record);
      const auto phase = self.committed.size();
      if (self.on_commit) self.on_commit(self);
      if (self.cancel_commit == phase) SetEvent(self.cancellation);
      if (self.fail_commit == phase) return ERROR_BROKEN_PIPE;
      std::copy(record.end() - 32, record.end(), digest->begin());
      if (self.wrong_ack == phase) (*digest)[0] ^= 1;
      return ERROR_SUCCESS;
    } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  }
  CellDiskLayoutCommitter Committer() { return {Commit, Authorize, this}; }
  DWORD Run(ULONGLONG deadline = 0) {
    return CellVirtualDiskLayoutTestPeer::Run(owner, plan, Committer(), Verify, Io, this,
      deadline ? deadline : GetTickCount64() + 10000, cancellation);
  }
};
void Rehash(std::vector<CellDiskLayoutCheckpoint>& records) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) throw std::runtime_error("Test hash unavailable.");
  bool okay = true;
  for (std::size_t index = 0; index < records.size(); ++index) {
    if (index) std::copy(records[index - 1].end() - 32, records[index - 1].end(), records[index].begin() + 16);
    if (BCryptHash(algorithm, nullptr, 0, records[index].data(), 480, records[index].data() + 480, 32) < 0) okay = false;
  }
  BCryptCloseAlgorithmProvider(algorithm, 0);
  if (!okay) throw std::runtime_error("Test hash failed.");
}
}

unsigned RunCellVirtualDiskLayoutTests() {
  checks = 0; retained.clear();
  const auto plan = Plan();
  CellFileSha256 binding, profile;
  binding.fill(0x31); profile.fill(0x42);
  CellDiskLayoutPlan derived;
  Check(DeriveCellDiskLayoutPlan(plan.disk, binding, profile, &derived) == ERROR_SUCCESS &&
    IsEqualGUID(derived.gpt_disk_id, plan.gpt_disk_id) && IsEqualGUID(derived.data_partition_id, plan.data_partition_id),
    "native identifiers match the independently computed Gateway derivation");
  binding[0] ^= 1;
  Check(DeriveCellDiskLayoutPlan(plan.disk, binding, profile, &derived) == ERROR_SUCCESS &&
    !IsEqualGUID(derived.gpt_disk_id, plan.gpt_disk_id) && !IsEqualGUID(derived.data_partition_id, plan.data_partition_id),
    "assignment binding changes both planned GPT identifiers");
  binding.fill(0);
  Check(DeriveCellDiskLayoutPlan(plan.disk, binding, profile, &derived) == ERROR_INVALID_PARAMETER &&
    IsEqualGUID(derived.gpt_disk_id, GUID{}), "absent canonical binding clears the derived plan");
  Check(IsValidCellDiskLayoutPlan(plan), "frozen disk identity and separate GPT/data identities are valid");
  for (unsigned variant = 0; variant < 8; ++variant) {
    auto bad = plan;
    if (variant == 0) bad.disk.spec.virtual_bytes = 16 * mib;
    if (variant == 1) bad.disk.control.volume_serial = 0;
    if (variant == 2) bad.disk.backing.file_id.fill(0);
    if (variant == 3) bad.disk.backing = bad.disk.control;
    if (variant == 4) bad.gpt_disk_id = {};
    if (variant == 5) bad.data_partition_id = bad.gpt_disk_id;
    if (variant == 6) bad.gpt_disk_id = bad.disk.spec.identifier;
    if (variant == 7) ++bad.disk.backing.volume_serial;
    Check(!IsValidCellDiskLayoutPlan(bad), "invalid or conflated planned identity is refused");
  }
  CellDiskLayoutSnapshot decoded;
  for (unsigned count : {1U, 2U}) {
    const auto bytes = Layout(plan, count);
    Check(InspectCellDiskLayout(bytes, plan, count == 2, &decoded) == ERROR_SUCCESS &&
      decoded.data_start == 17 * mib && decoded.data_length == 238 * mib, "independent SDK layout matches exact reserved and data extents");
  }
  const std::vector<std::function<void(std::vector<std::uint8_t>&)>> corruptions = {
    [](auto& b) { Header(b).PartitionStyle = PARTITION_STYLE_MBR; },
    [](auto& b) { Header(b).PartitionCount = MAXDWORD; },
    [](auto& b) { Header(b).Gpt.DiskId.Data1 ^= 1; },
    [](auto& b) { Header(b).Gpt.MaxPartitionCount = 129; },
    [](auto& b) { Header(b).Gpt.StartingUsableOffset.QuadPart = -1; },
    [](auto& b) { Header(b).Gpt.UsableLength.QuadPart += 512; },
    [](auto& b) { Part(b).PartitionNumber = 9; },
    [](auto& b) { Part(b).Gpt.PartitionType.Data1 ^= 1; },
    [](auto& b) { Part(b).Gpt.PartitionId = {}; },
    [](auto& b) { Part(b).Gpt.PartitionId = Part(b, 1).Gpt.PartitionId; },
    [](auto& b) { Part(b).StartingOffset.QuadPart = -1; },
    [](auto& b) { Part(b).StartingOffset.QuadPart += 1; },
    [](auto& b) { Part(b).PartitionLength.QuadPart = 0x7fffffffffffffffLL; },
    [](auto& b) { Part(b).Gpt.Attributes = 0x8000000000000000ULL; },
    [](auto& b) { std::fill(std::begin(Part(b).Gpt.Name), std::end(Part(b).Gpt.Name), L'x'); },
    [](auto& b) { Part(b).Gpt.Name[35] = L'x'; },
    [](auto& b) { Part(b, 1).PartitionStyle = PARTITION_STYLE_RAW; },
    [](auto& b) { Part(b, 1).PartitionNumber = 1; },
    [](auto& b) { Part(b, 1).StartingOffset.QuadPart += 512; },
    [](auto& b) { Part(b, 1).PartitionLength.QuadPart -= 512; },
    [](auto& b) { Part(b, 1).Gpt.PartitionType.Data1 ^= 1; },
    [](auto& b) { Part(b, 1).Gpt.PartitionId.Data1 ^= 1; },
    [](auto& b) { Part(b, 1).Gpt.Attributes = 0; },
    [](auto& b) { Part(b, 1).Gpt.Attributes |= 0x4000000000000000ULL; },
    [](auto& b) { Part(b, 1).Gpt.Name[0] = L'x'; },
    [](auto& b) { b.pop_back(); }, [](auto& b) { b.resize(b.size() + 1); },
  };
  for (const auto& corrupt : corruptions) {
    auto bytes = Layout(plan, 2); corrupt(bytes);
    decoded.data_start = 123;
    Check(InspectCellDiskLayout(bytes, plan, true, &decoded) != ERROR_SUCCESS && decoded.data_start == 0,
      "foreign, overlapping, aliased, malformed or truncated layout clears output and is refused");
  }
  for (std::size_t length : {0ULL, 4ULL, header_bytes - 1}) {
    const auto bytes = Layout(plan, 2);
    Check(InspectCellDiskLayout(std::span(bytes).first(length), plan, true, &decoded) == ERROR_INVALID_DATA,
      "truncated partition headers are bounded before dereferencing");
  }
  Fixture success;
  Check(success.Run() == ERROR_SUCCESS && success.owner.State() == CellDiskLayoutState::partitioned,
    "production sequence initializes, waits, preserves MSR and partitions after exact acknowledgements");
  Check(success.writes == 2 && success.waits == 2 && success.committed.size() == 4 && success.input_valid,
    "two native mutations and readiness waits use the independent expected SDK requests");
  const unsigned io_count = success.io_calls, verify_count = success.verify_calls, authority_count = success.authority_calls;
  retained = success.committed;
  Check(DecodeCellDiskLayoutCheckpoints(plan, retained, &decoded) == ERROR_SUCCESS && decoded.data_length == 238 * mib,
    "complete independently retained chain decodes its exact planned identity and readback");
  CellVirtualDiskDevice absent; CellWorkspaceDirectories roots;
  Check(success.owner.Create(absent, roots, plan, success.Committer(), 1000) == ERROR_ALREADY_INITIALIZED && success.writes == 2,
    "completed owner cannot initialize again");
  for (unsigned phase = 1; phase <= 4; ++phase) {
    for (const bool bad_ack : {false, true}) {
      Fixture failure; (bad_ack ? failure.wrong_ack : failure.fail_commit) = phase;
      Check(failure.Run() == static_cast<DWORD>(bad_ack ? ERROR_INVALID_DATA : ERROR_BROKEN_PIPE) &&
        failure.owner.State() == CellDiskLayoutState::unknown, "lost or mismatched durable acknowledgement never returns readiness");
      Check(failure.writes == (phase == 1 ? 0U : phase == 4 ? 2U : 1U) && failure.committed.size() == phase,
        "no subsequent disk mutation follows an uncertain acknowledgement");
      Check(failure.owner.Create(absent, roots, plan, failure.Committer(), 1000) == ERROR_ALREADY_INITIALIZED,
        "an uncertain owner cannot retry the disk write");
    }
  }
  for (unsigned call = 1; call <= io_count; ++call) {
    Fixture f; f.fail_io = call;
    Check(f.Run() == ERROR_IO_DEVICE && f.io_calls == call && f.owner.State() == CellDiskLayoutState::unknown,
      "any failed driver operation stops the sequence at that exact I/O");
  }
  for (unsigned call = 1; call <= verify_count; ++call) {
    Fixture f; f.fail_verify = call;
    Check(f.Run() == ERROR_FILE_INVALID && f.verify_calls == call && f.owner.State() == CellDiskLayoutState::unknown,
      "any backing/device identity loss stops current work");
  }
  for (unsigned call = 1; call <= authority_count; ++call) {
    Fixture f; f.fail_authority = call;
    Check(f.Run() == ERROR_ACCESS_DENIED && f.authority_calls == call && f.owner.State() == CellDiskLayoutState::unknown,
      "authorization is rechecked through final acknowledgement and cannot fall back");
  }
  for (unsigned phase = 1; phase <= 4; ++phase) {
    Fixture f; f.cancel_commit = phase; f.cancellation = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    Check(f.cancellation != nullptr, "create task-owned cancellation event");
    const DWORD result = f.Run(); CloseHandle(f.cancellation); f.cancellation = nullptr;
    Check(result == ERROR_CANCELLED && f.writes == (phase == 1 ? 0U : phase == 4 ? 2U : 1U) &&
      f.owner.State() == CellDiskLayoutState::unknown, "cancellation while persisting never permits another disk write");
  }
  for (unsigned variant = 0; variant < 5; ++variant) {
    Fixture f;
    f.on_commit = [variant](Fixture& current) {
      if (variant == 0 && current.committed.size() == 1) current.current = Layout(current.plan, 2);
      if (variant == 1 && current.committed.size() == 3) Part(current.current).Gpt.PartitionId.Data1 ^= 1;
      if (variant == 2 && current.committed.size() == 4) Part(current.current).Gpt.PartitionId.Data1 ^= 1;
      if (variant == 3 && current.committed.size() == 3) Part(current.current).Gpt.Name[0] = L'x';
      if (variant == 4 && current.committed.size() == 3) Header(current.current).Gpt.DiskId.Data1 ^= 1;
    };
    Check(f.Run() != ERROR_SUCCESS && f.writes == (variant == 0 ? 0U : variant == 2 ? 2U : 1U) &&
      f.owner.State() == CellDiskLayoutState::unknown, "layout drift across persistence cannot be overwritten or accepted");
  }
  {
    Fixture f; f.current = Layout(f.plan, 1);
    Check(f.Run() == ERROR_ALREADY_EXISTS && f.writes == 0 && f.committed.empty(), "an initialized image is never adopted as fresh RAW");
    Fixture raw_padding; raw_padding.current.resize(sizeof(DRIVE_LAYOUT_INFORMATION_EX));
    std::fill(raw_padding.current.begin() + 8, raw_padding.current.end(), std::uint8_t{0xcc});
    Check(raw_padding.Run() == ERROR_SUCCESS && raw_padding.writes == 2,
      "undefined RAW union and unused array bytes do not masquerade as GPT fields");
    Fixture raw_partition; Header(raw_partition.current).PartitionCount = 1;
    Check(raw_partition.Run() == ERROR_ALREADY_EXISTS && raw_partition.writes == 0,
      "a claimed partition on a RAW response is refused before initialization");
    Fixture oversized; oversized.oversized = true;
    Check(oversized.Run() != ERROR_SUCCESS && oversized.writes == 0, "oversized driver count cannot become a span or a write");
    Fixture uncertain; uncertain.fail_after_write = true;
    Check(uncertain.Run() == ERROR_IO_DEVICE && uncertain.writes == 1 && uncertain.committed.size() == 1 &&
      uncertain.owner.State() == CellDiskLayoutState::unknown, "lost initialization reply retains intent without repeating the mutation");
    Fixture expired;
    Check(expired.Run(GetTickCount64() - 1) == ERROR_TIMEOUT && expired.io_calls == 0 && expired.committed.empty(),
      "expired work does not enter any device I/O or persistence callback");
  }
  for (std::size_t length = 0; length < 4; ++length) {
    Check(DecodeCellDiskLayoutCheckpoints(plan, std::span(retained).first(length), &decoded) == ERROR_IO_INCOMPLETE,
      "incomplete checkpoint chains never establish layout completion");
    CellVirtualDiskLayout recovery;
    Check(recovery.OpenRecorded(absent, roots, plan, std::span(retained).first(length), 1000) == ERROR_IO_INCOMPLETE &&
      recovery.State() == CellDiskLayoutState::unknown, "recovery refuses uncertain prefixes before opening any disk");
    Check(recovery.Create(absent, roots, plan, success.Committer(), 1000) == ERROR_ALREADY_INITIALIZED,
      "recovery cannot turn an uncertain prefix into write authority");
  }
  for (const std::size_t offset : {0ULL, 8ULL, 12ULL, 16ULL, 48ULL, 64ULL, 80ULL, 104ULL, 128ULL, 144ULL,
    160ULL, 176ULL, 180ULL, 196ULL, 220ULL, 292ULL, 300ULL, 308ULL, 316ULL, 388ULL, 392ULL, 480ULL}) {
    auto corrupt = retained; corrupt[1][offset] ^= 1;
    Check(DecodeCellDiskLayoutCheckpoints(plan, corrupt, &decoded) != ERROR_SUCCESS,
      "checkpoint corruption of header, custody, layout, reserved bytes or digest is refused");
  }
  for (unsigned variant = 0; variant < 5; ++variant) {
    auto forged = retained;
    if (variant == 0) forged[0][160] = 1;
    if (variant == 1) forged[1][292] ^= 1;
    if (variant == 2) forged[2][180] ^= 1;
    if (variant == 3) forged[3][8] = 3;
    if (variant == 4) forged[1][392] = 1;
    Rehash(forged);
    Check(DecodeCellDiskLayoutCheckpoints(plan, forged, &decoded) != ERROR_SUCCESS,
      "correctly rehashed but inconsistent or noncanonical records are rejected");
  }
  auto other = plan; other.gpt_disk_id.Data1 ^= 1;
  Check(DecodeCellDiskLayoutCheckpoints(other, retained, &decoded) != ERROR_SUCCESS,
    "another frozen plan cannot adopt an otherwise valid completed journal");
  CellVirtualDiskLayout no_device;
  Check(no_device.Create(absent, roots, plan, {}, 1000) == ERROR_INVALID_PARAMETER, "durable commit and authority ports are mandatory");
  Check(no_device.Create(absent, roots, plan, success.Committer(), 0) == ERROR_INVALID_PARAMETER, "unbounded creation is refused");
  Check(no_device.Create(absent, roots, plan, success.Committer(), 1000, INVALID_HANDLE_VALUE) == ERROR_INVALID_HANDLE,
    "invalid cancellation is refused before opening a disk");
  Check(no_device.Create(absent, roots, plan, success.Committer(), 1000) == ERROR_FILE_INVALID &&
    no_device.State() == CellDiskLayoutState::unknown, "a missing independently bound device cannot initialize a disk");
  Check(no_device.Verify(roots, 1000) == ERROR_INVALID_STATE, "an uncreated layout has no verification readiness");
  no_device.Close(); no_device.Close();
  Check(!absent.Ready(), "layout close never opens, repairs or detaches its source");
  return checks;
}
std::string CellDiskLayoutCheckpointRecordsJson() {
  std::string output = "[";
  for (const auto& record : retained) {
    if (output.size() > 1) output += ',';
    output += '"';
    for (const auto byte : record) { char hex[3]{}; sprintf_s(hex, "%02x", byte); output += hex; }
    output += '"';
  }
  return output + ']';
}

// Drives the real layout sequence through independent SDK-shaped driver replies
// while using the real provisioning journal's durable checkpoint callback.
DWORD RunCellVirtualDiskLayoutJournalFixture(const CellDiskLayoutPlan& plan, const CellDiskLayoutCommitter& sink) noexcept {
  try {
    Fixture fixture;
    fixture.plan = plan; fixture.current = Layout(plan, 0);
    struct Context { Fixture* fixture; const CellDiskLayoutCommitter* sink; } context{&fixture, &sink};
    const CellDiskLayoutCommitter bridge{
      [](void* raw, const CellDiskLayoutCheckpoint& record, CellFileSha256* digest) noexcept -> DWORD {
        auto& value = *static_cast<Context*>(raw);
        try { value.fixture->committed.push_back(record); } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
        return value.sink->commit(value.sink->context, record, digest);
      },
      [](void* raw) noexcept -> DWORD {
        auto& value = *static_cast<Context*>(raw);
        return value.sink->authorize(value.sink->context);
      }, &context,
    };
    const DWORD error = CellVirtualDiskLayoutTestPeer::Run(fixture.owner, plan, bridge, Fixture::Verify, Fixture::Io,
      &fixture, GetTickCount64() + 10000, nullptr);
    if (error) return error;
    return fixture.input_valid && fixture.writes == 2 && fixture.committed.size() == 4 ? ERROR_SUCCESS : ERROR_INVALID_DATA;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
