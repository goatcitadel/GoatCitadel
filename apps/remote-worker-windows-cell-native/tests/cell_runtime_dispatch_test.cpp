#include "cell_runtime_dispatch.hpp"
#include "cell_stdio_protocol.hpp"
#include <algorithm>
#include <stdexcept>

using namespace goatcitadel::worker_cell;
namespace {
using Bytes = std::vector<std::uint8_t>;
void Integer(Bytes& bytes, std::uint64_t value, unsigned size = 4) {
  for (unsigned index = 0; index < size; ++index) bytes.push_back(static_cast<std::uint8_t>(value >> (8 * index)));
}
void Text(Bytes& bytes, const std::string& text) { Integer(bytes, text.size()); bytes.insert(bytes.end(), text.begin(), text.end()); }
void Set32(Bytes& bytes, std::size_t offset, std::uint32_t value) {
  for (unsigned index = 0; index < 4; ++index) bytes[offset + index] = static_cast<std::uint8_t>(value >> (8 * index));
}
CellFileSha256 Hex(const char* text) {
  CellFileSha256 result{};
  const auto digit = [](char value) { return value <= '9' ? value - '0' : value - 'a' + 10; };
  for (std::size_t index = 0; index < result.size(); ++index) result[index] = static_cast<std::uint8_t>(digit(text[index * 2]) * 16 + digit(text[index * 2 + 1]));
  return result;
}
void Identity(Bytes& bytes, std::uint8_t id) { bytes.insert(bytes.end(), 8, 0x11); bytes.insert(bytes.end(), 16, id); }
struct Fixture final { Bytes bytes; std::size_t wall_offset; };
Fixture Golden() {
  const std::string name = "gc-cell-" + std::string(32, '1'), root = "C:\\cells\\" + name, image = root + "\\runtime\\entry.exe";
  Bytes body;
  for (const auto& text : {name, "GoatCitadel.Worker." + std::string(32, '1'), image, "\"" + image + "\" serve", root + "\\work", root + "\\runtime"}) Text(body, text);
  body.insert(body.end(), 32, 0xaa); Identity(body, 0x55); Identity(body, 0x44);
  const auto manifest = Hex("bb305edf2b2097380184b30042f0315a4077b7d4e7468d502b9b886c97834801");
  body.insert(body.end(), manifest.begin(), manifest.end());
  Integer(body, 1); Integer(body, 64ULL * 1024 * 1024, 8); Integer(body, 1000);
  const auto wall_offset = 156 + body.size();
  Integer(body, 150000); Integer(body, 65536, 8); Integer(body, 1024); Integer(body, 4096);
  Integer(body, 1); Text(body, "SystemRoot=C:\\Windows");
  Integer(body, 1); Text(body, "entry.exe"); Integer(body, 3, 8); body.insert(body.end(), 32, 0xaa);
  for (const auto& text : {"C:\\cells", "S-1-5-21-1-2-3-1001", "S-1-5-80-1-2-3-4-5"}) Text(body, text);
  for (const unsigned id : {0x11, 0x22, 0x33, 0x44, 0x55}) Identity(body, static_cast<std::uint8_t>(id));
  Bytes bytes{'G','C','R','U','N','0','0','1'};
  bytes.insert(bytes.end(), 32, 0x99); Identity(bytes, 0x66);
  bytes.insert(bytes.end(), 32, 0x77); bytes.insert(bytes.end(), 32, 0x88);
  Integer(bytes, 20000); Integer(bytes, 64); Integer(bytes, 10000); Integer(bytes, body.size() + 12);
  const std::string magic = "GCSTDIO2"; bytes.insert(bytes.end(), magic.begin(), magic.end()); Integer(bytes, body.size());
  bytes.insert(bytes.end(), body.begin(), body.end());
  return {std::move(bytes), wall_offset};
}
bool Empty(const CellRuntimeDispatch& value) {
  return value.command.launch.job_name.empty() && value.reference.checkpoint_sha256 == CellFileSha256{} &&
    value.binding.request_sha256 == CellFileSha256{} && value.limits.wall_ms == 0 && !value.file_staging;
}
}
std::vector<std::uint8_t> CellRuntimeDispatchGoldenBytes() { return Golden().bytes; }
unsigned RunCellRuntimeDispatchTests() {
  unsigned checks = 0;
  const auto check = [&](bool passed, const char* message) { ++checks; if (!passed) throw std::runtime_error(message); };
  const auto fixture = Golden();
  CellRuntimeDispatchBinding binding; binding.nonce.fill(0x99);
  binding.request_sha256 = Hex("9e914f87f794f1de2e53a0bc5d96a63cd21c0094e797ad0caaee04bad9bc8c03");
  CellFileSha256 digest{};
  check(fixture.bytes.size() == 935 && HashCellRuntimeDispatch(fixture.bytes, &digest) == 0 && digest == binding.request_sha256,
    "Native runtime dispatch must match the independently encoded worker golden digest");
  CellRuntimeDispatch output;
  check(DecodeCellRuntimeDispatch(fixture.bytes, binding, &output) == 0 && output.command.protected_workspace && output.limits.wall_ms == 150000 &&
    output.reference.inventory_limits.max_entries == 20000 && output.command.protected_workspace->identities.directories[3] == output.command.launch.expected_directory_identity,
    "Bound dispatch decodes the protected runtime and separate long-workload and capture limits");
  const auto poison = output;
  for (std::size_t index = 0; index < fixture.bytes.size(); ++index) {
    auto changed = fixture.bytes; changed[index] ^= 1; output = poison;
    check(DecodeCellRuntimeDispatch(changed, binding, &output) == ERROR_ACCESS_DENIED && Empty(output),
      "Every request byte is bound before executable metadata is exposed");
  }
  for (unsigned kind = 0; kind < 16; ++kind) {
    auto changed = fixture.bytes;
    switch (kind) {
      case 0: changed[0] ^= 1; break;
      case 1: std::fill(changed.begin() + 40, changed.begin() + 48, std::uint8_t{}); break;
      case 2: std::fill(changed.begin() + 48, changed.begin() + 64, std::uint8_t{}); break;
      case 3: std::fill(changed.begin() + 64, changed.begin() + 96, std::uint8_t{}); break;
      case 4: std::fill(changed.begin() + 96, changed.begin() + 128, std::uint8_t{}); break;
      case 5: Set32(changed, 128, 0); break;
      case 6: Set32(changed, 128, 20001); break;
      case 7: Set32(changed, 132, 65); break;
      case 8: Set32(changed, 136, 0); break;
      case 9: Set32(changed, 136, 60001); break;
      case 10: Set32(changed, 140, 0); break;
      case 11: changed[151] = '1'; break;
      case 12: Set32(changed, 152, 1); break;
      case 13: Set32(changed, 156, 0); break;
      case 14: Set32(changed, fixture.wall_offset, 86'400'001); break;
      case 15: changed.push_back(0); Set32(changed, 140, static_cast<std::uint32_t>(changed.size() - 144));
        Set32(changed, 152, static_cast<std::uint32_t>(changed.size() - 156)); break;
    }
    auto matched = binding; check(HashCellRuntimeDispatch(changed, &matched.request_sha256) == 0, "Hash malformed fixture failed");
    output = poison;
    check(DecodeCellRuntimeDispatch(changed, matched, &output) == ERROR_INVALID_PARAMETER && Empty(output),
      "Matching bytes still refuse malformed identity, bounds, downgrade, length and configuration data");
  }
  for (const auto size : {0U, 143U, 156U, 934U, static_cast<unsigned>(kMaximumRuntimeDispatchBytes + 1)}) {
    auto changed = fixture.bytes; changed.resize(size); output = poison;
    check(DecodeCellRuntimeDispatch(changed, binding, &output) != 0 && Empty(output), "Truncated or oversized dispatch withholds stale output");
  }
  auto wrong = binding; wrong.nonce.back() ^= 1; output = poison;
  check(DecodeCellRuntimeDispatch(fixture.bytes, wrong, &output) == ERROR_ACCESS_DENIED && Empty(output), "Independent connection nonce cannot be replaced");
  wrong = binding; wrong.request_sha256.fill(0); output = poison;
  check(DecodeCellRuntimeDispatch(fixture.bytes, wrong, &output) == ERROR_ACCESS_DENIED && Empty(output), "Missing independent request digest refuses");
  output = poison; output.command.launch.standard_input = fixture.bytes;
  check(DecodeCellRuntimeDispatch(output.command.launch.standard_input, output.binding, &output) == 0 && output.limits.wall_ms == 150000,
    "Decoder snapshots aliased input and expected binding before clearing output");
  RuntimeJobCommand local; JobLimits local_limits;
  check(DecodeWorkerStdioConfiguration(Bytes(fixture.bytes.begin() + 156, fixture.bytes.end()), &local, &local_limits, true) == ERROR_INVALID_PARAMETER,
    "Local stdio helper cannot inherit the dispatch path's longer deadline");
  CellProvisioningJournal journal; unsigned calls = 0;
  const CellFootprintScanGuard guard{[](void* raw) noexcept -> DWORD { ++*static_cast<unsigned*>(raw); return ERROR_SUCCESS; }, &calls, nullptr};
  unsigned selections = 0;
  const CellRuntimeFileStaging staging{&selections, [](void* raw, const CellDirectoryInventory&,
      std::vector<CellDirectoryInventoryEntry>*) noexcept -> DWORD { ++*static_cast<unsigned*>(raw); return ERROR_SUCCESS; }};
  const auto refused = RunCellRuntimeDispatch(journal, fixture.bytes, wrong, guard, nullptr, &staging);
  check(!refused.binding_verified && refused.execution.runtime.job.error == ERROR_ACCESS_DENIED && !calls && !refused.execution.runtime.job.process_id,
    "Substituted dispatch refuses before journal reads, authority callbacks and launch");
  const auto unavailable = RunCellRuntimeDispatch(journal, fixture.bytes, binding, guard, nullptr, &staging);
  check(unavailable.binding_verified && unavailable.execution.runtime.job.error == ERROR_INVALID_STATE && !calls && !unavailable.execution.inventory_verified,
    "Correct request binding does not replace native journal custody or authorize a workload");
  check(!selections && refused.execution.staged_files.empty() && unavailable.execution.staged_files.empty(),
    "Opt-in file staging cannot bypass request binding or absent journal custody");
  auto planned = fixture.bytes; planned[7] = '2';
  const std::string plan_magic = "GCFPLAN1";
  planned.insert(planned.end(), plan_magic.begin(), plan_magic.end());
  Integer(planned, 2); Integer(planned, 1024); Integer(planned, 2048);
  Text(planned, "report.txt"); Text(planned, "nested/result.json");
  auto planned_binding = binding;
  check(planned.size() == 991 && HashCellRuntimeDispatch(planned, &planned_binding.request_sha256) == 0 &&
    planned_binding.request_sha256 == Hex("1783e213b609cfe59493ad9c4eaaebd1b0119b8312ad54e68a9ac35753544040") &&
    DecodeCellRuntimeDispatch(planned, planned_binding, &output) == 0 && output.file_staging &&
    output.file_staging->paths == std::vector<std::wstring>{L"report.txt", L"nested/result.json"} &&
    output.file_staging->maximum_file_bytes == 1024 && output.file_staging->maximum_total_bytes == 2048,
    "Bound collection plan decodes exact work paths and byte ceilings");
  for (std::size_t index = 0; index < planned.size(); ++index) {
    auto changed = planned; changed[index] ^= 1;
    check(DecodeCellRuntimeDispatch(changed, planned_binding, &output) == ERROR_ACCESS_DENIED && Empty(output),
      "Every collection plan byte remains covered by independently approved binding");
  }
  for (unsigned kind = 0; kind < 12; ++kind) {
    auto changed = planned;
    switch (kind) {
      case 0: changed.resize(935); break;
      case 1: changed.push_back(0); break;
      case 2: Set32(changed, 943, 0); break;
      case 3: Set32(changed, 943, 65); break;
      case 4: Set32(changed, 947, 0); break;
      case 5: Set32(changed, 947, 1048577); break;
      case 6: Set32(changed, 951, 67108865); break;
      case 7: Set32(changed, 955, 513); break;
      case 8: changed[959] = 255; break;
      case 9: changed[959] = '/'; break;
      case 10: changed[7] = '1'; break;
      case 11: changed.resize(969); Text(changed, "REPORT.TXT"); break;
    }
    auto matched = planned_binding;
    check(HashCellRuntimeDispatch(changed, &matched.request_sha256) == 0, "Malformed plan hash failed");
    check(DecodeCellRuntimeDispatch(changed, matched, &output) == ERROR_INVALID_PARAMETER && Empty(output),
      "Recomputed binding cannot authorize malformed or ambiguous file collection");
  }
  const auto overridden = RunCellRuntimeDispatch(journal, planned, planned_binding, guard, nullptr, &staging);
  check(overridden.binding_verified && overridden.execution.runtime.job.error == ERROR_INVALID_PARAMETER && !calls && !selections &&
    overridden.execution.staged_files.empty(), "External selector cannot override the approved collection plan");
  const auto absent = RunCellRuntimeDispatch(journal, planned, planned_binding, guard);
  check(absent.binding_verified && absent.execution.runtime.job.error == ERROR_INVALID_STATE && !calls && absent.execution.staged_files.empty(),
    "Bound collection still requires native journal custody");
  return checks;
}
