#include "cell_capacity_wire.hpp"
#include <algorithm>
#include <cstring>
#include <set>

namespace goatcitadel::worker_cell {
namespace {
void Put(std::uint8_t* bytes, std::uint64_t value, unsigned count = 4) noexcept {
  for (unsigned i = 0; i < count; ++i) bytes[i] = static_cast<std::uint8_t>(value >> (8 * i));
}
bool Nonzero(const CellFileSha256& value) noexcept {
  return std::any_of(value.begin(), value.end(), [](auto byte) { return byte != 0; });
}
void Identity(std::uint8_t* output, const CellFileIdentity& identity) noexcept {
  Put(output, identity.volume_serial, 8); std::copy(identity.file_id.begin(), identity.file_id.end(), output + 8);
}
using Key = std::pair<std::uint64_t, std::array<std::uint8_t, 16>>;
Key KeyOf(const CellFileIdentity& identity) noexcept { return {identity.volume_serial, identity.file_id}; }
}
DWORD EncodeCellCapacityLayout(const CellCapacityLayoutRecord& value, CellCapacityLayoutBytes* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  const auto record = value; *output = {};
  try {
    if (!Nonzero(record.assignment_binding) || !Nonzero(record.profile_sha256)) return ERROR_INVALID_DATA;
    std::set<Key> roots;
    for (const auto& root : record.roots)
      if (root.file_id == std::array<std::uint8_t, 16>{} || !roots.insert(KeyOf(root)).second) return ERROR_INVALID_DATA;
    CellCapacityLayoutBytes bytes{}; std::memcpy(bytes.data(), "GCLAY001", 8);
    std::copy(record.assignment_binding.begin(), record.assignment_binding.end(), bytes.begin() + 8);
    std::copy(record.profile_sha256.begin(), record.profile_sha256.end(), bytes.begin() + 40);
    for (std::size_t i = 0; i < record.roots.size(); ++i) Identity(bytes.data() + 72 + 24 * i, record.roots[i]);
    *output = bytes; return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD DecodeCellCapacityLayout(std::span<const std::uint8_t> input, CellCapacityLayoutRecord* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  if (input.size() != CellCapacityLayoutBytes{}.size()) return ERROR_INVALID_DATA;
  // Freeze before validation; a caller must own and serialize its source bytes.
  CellCapacityLayoutBytes bytes{}; std::copy(input.begin(), input.end(), bytes.begin());
  if (std::memcmp(bytes.data(), "GCLAY001", 8)) return ERROR_INVALID_DATA;
  CellCapacityLayoutRecord record{};
  std::copy_n(bytes.begin() + 8, 32, record.assignment_binding.begin());
  std::copy_n(bytes.begin() + 40, 32, record.profile_sha256.begin());
  for (std::size_t i = 0; i < record.roots.size(); ++i) {
    const auto start = 72 + 24 * i;
    for (unsigned n = 0; n < 8; ++n) record.roots[i].volume_serial |= std::uint64_t(bytes[start + n]) << (8 * n);
    std::copy_n(bytes.begin() + start + 8, 16, record.roots[i].file_id.begin());
  }
  CellCapacityLayoutBytes canonical{};
  const auto error = EncodeCellCapacityLayout(record, &canonical);
  if (error) return error;
  if (canonical != bytes) return ERROR_INVALID_DATA;
  *output = record; return ERROR_SUCCESS;
}
DWORD CellCapacityLayout::OpenRecordedBytes(std::span<const std::uint8_t> bytes, const CellFileSha256& assignment_binding,
  const CellFileSha256& profile_sha256, const CellCapacityAreaRoots& roots,
  const std::wstring& owner_sid, const std::wstring& controller_sid) noexcept {
  if (scanning_) { interrupted_ = true; return ERROR_BUSY; }
  CellCapacityLayoutRecord record{};
  const auto error = DecodeCellCapacityLayout(bytes, &record);
  if (error || record.assignment_binding != assignment_binding || record.profile_sha256 != profile_sha256) {
    Close(); return error ? error : ERROR_INVALID_DATA;
  }
  return OpenRecorded(record, roots, owner_sid, controller_sid);
}
DWORD EncodeCellCapacityCapture(const CellCapacityLayoutRecord& record, const CellFileSha256& nonce,
  const CellCapacityAreaInventories& areas, std::vector<std::uint8_t>* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  output->clear();
  try {
    CellCapacityLayoutBytes layout{};
    if (!Nonzero(nonce) || EncodeCellCapacityLayout(record, &layout)) return ERROR_INVALID_DATA;
    std::size_t total = 0;
    for (const auto& area : areas) {
      if (area.entries.empty() || area.entries.size() > 20000 - total) return ERROR_INVALID_DATA;
      total += area.entries.size();
    }
    std::vector<std::uint8_t> bytes(840 + 48 * total);
    std::memcpy(bytes.data(), "GCCAP001", 8); std::copy(nonce.begin(), nonce.end(), bytes.begin() + 8);
    std::copy(layout.begin(), layout.end(), bytes.begin() + 40);
    std::set<Key> identities; std::size_t position = 840;
    for (std::size_t i = 0; i < areas.size(); ++i) {
      const auto& area = areas[i]; CellDirectoryFootprint count; count.root = record.roots[i];
      bool root_found = false; Key previous{}; bool has_previous = false;
      for (const auto& entry : area.entries) {
        const auto key = KeyOf(entry.identity);
        if (entry.identity.file_id == std::array<std::uint8_t, 16>{} || key.first != count.root.volume_serial ||
            (has_previous && key <= previous) || !identities.insert(key).second ||
            (entry.directory && entry.logical_file_bytes) || entry.logical_file_bytes > 9007199254740991ULL - count.logical_file_bytes ||
            entry.allocated_bytes > 9007199254740991ULL - count.allocated_bytes) return ERROR_INVALID_DATA;
        previous = key; has_previous = true;
        if (entry.identity == count.root) { if (!entry.directory) return ERROR_INVALID_DATA; root_found = true; }
        count.logical_file_bytes += entry.logical_file_bytes; count.allocated_bytes += entry.allocated_bytes;
        if (entry.directory) ++count.directory_count; else ++count.file_count;
        Identity(bytes.data() + position, entry.identity); Put(bytes.data() + position + 24, entry.directory ? 2 : 1);
        Put(bytes.data() + position + 32, entry.logical_file_bytes, 8); Put(bytes.data() + position + 40, entry.allocated_bytes, 8);
        position += 48;
      }
      if (!root_found || count != area.footprint) return ERROR_INVALID_DATA;
      auto summary = bytes.data() + 424 + 32 * i;
      Put(summary, area.entries.size()); Put(summary + 4, count.file_count); Put(summary + 8, count.directory_count);
      Put(summary + 16, count.logical_file_bytes, 8); Put(summary + 24, count.allocated_bytes, 8);
    }
    *output = std::move(bytes); return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellCapacityLayout::Capture(const CellCapacityLayoutRecord& supplied_record, const CellFileSha256& supplied_nonce,
  const CellFootprintScanLimits& supplied_limits, const CellFootprintScanGuard& supplied_guard, std::vector<std::uint8_t>* output,
  const CellCapacityBorrowedFiles* borrowed, const CellCapacityCaptureObserver* observer) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  output->clear();
  detail::CellCapacityObservation observation(observer);
  if (!observation.Valid()) return ERROR_INVALID_PARAMETER;
  const auto record = supplied_record; const auto nonce = supplied_nonce; const auto limits = supplied_limits; const auto guard = supplied_guard;
  const auto borrowed_guard = borrowed ? borrowed->guard : CellFootprintScanGuard{};
  if (!Nonzero(nonce) || !limits.wall_limit_ms || limits.wall_limit_ms > 60000) return ERROR_INVALID_PARAMETER;
  const auto deadline = GetTickCount64() + limits.wall_limit_ms;
  CellCapacityAreaInventories areas;
  auto error = Scan(record, limits, guard, &areas, borrowed, observation.Bridge());
  if (!error) error = EncodeCellCapacityCapture(record, nonce, areas, output);
  if (!error) error = Verify();
  if (!error && guard.cancellation && WaitForSingleObject(guard.cancellation, 0) != WAIT_TIMEOUT) error = ERROR_CANCELLED;
  if (!error && borrowed_guard.cancellation && WaitForSingleObject(borrowed_guard.cancellation, 0) != WAIT_TIMEOUT) error = ERROR_CANCELLED;
  if (!error && GetTickCount64() >= deadline) error = ERROR_TIMEOUT;
  if (error) output->clear();
  else observation.Complete();
  return error;
}
}
