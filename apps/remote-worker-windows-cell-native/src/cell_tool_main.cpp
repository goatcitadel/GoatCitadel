#include "cell_filesystem.hpp"
#include <algorithm>
#include <cstring>

namespace {
using namespace goatcitadel::worker_cell;
constexpr std::size_t kHeaderBytes = 52;
constexpr std::size_t kMaximumInput = kHeaderBytes + 8192 + 4096 + 2 * 32768;
constexpr std::uint32_t kAbsent = 0xffffffff;

std::uint64_t Integer(const std::uint8_t* bytes, unsigned count) {
  std::uint64_t value = 0;
  for (unsigned index = 0; index < count; ++index) value |= static_cast<std::uint64_t>(bytes[index]) << (8 * index);
  return value;
}
void Put(std::uint8_t* bytes, std::uint64_t value, unsigned count) {
  for (unsigned index = 0; index < count; ++index) bytes[index] = static_cast<std::uint8_t>(value >> (8 * index));
}
bool DecodePath(const std::uint8_t* bytes, std::size_t length, std::wstring* output) {
  if (!length || std::memchr(bytes, 0, length)) return false;
  const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, reinterpret_cast<const char*>(bytes),
    static_cast<int>(length), nullptr, 0);
  if (!required) return false;
  output->resize(static_cast<std::size_t>(required));
  return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, reinterpret_cast<const char*>(bytes),
    static_cast<int>(length), output->data(), required) == required;
}
DWORD Execute(const std::vector<std::uint8_t>& bytes, CellFileIdentity* identity, CellToolWriteResult* result) {
  if (bytes.size() < kHeaderBytes || std::memcmp(bytes.data(), "GCFILES1", 8)) return ERROR_INVALID_PARAMETER;
  const auto operation = Integer(bytes.data() + 8, 4);
  const auto root_bytes = Integer(bytes.data() + 12, 4), path_bytes = Integer(bytes.data() + 16, 4);
  const auto content_bytes = Integer(bytes.data() + 20, 4), expected_bytes = Integer(bytes.data() + 24, 4);
  if ((operation != 1 && operation != 2) || !root_bytes || root_bytes > 8192 || path_bytes > 4096 ||
      content_bytes > 32768 || (expected_bytes != kAbsent && expected_bytes > 32768) ||
      bytes.size() != kHeaderBytes + root_bytes + path_bytes + content_bytes + (expected_bytes == kAbsent ? 0 : expected_bytes))
    return ERROR_INVALID_PARAMETER;
  CellFileIdentity expected_identity{};
  expected_identity.volume_serial = Integer(bytes.data() + 28, 8);
  std::copy_n(bytes.data() + 36, 16, expected_identity.file_id.begin());
  if (operation == 1 && (path_bytes || content_bytes || expected_bytes != kAbsent || expected_identity != CellFileIdentity{}))
    return ERROR_INVALID_PARAMETER;
  if (operation == 2 && (!path_bytes || expected_identity == CellFileIdentity{})) return ERROR_INVALID_PARAMETER;
  std::wstring root, relative;
  const auto* cursor = bytes.data() + kHeaderBytes;
  if (!DecodePath(cursor, static_cast<std::size_t>(root_bytes), &root)) return ERROR_INVALID_PARAMETER;
  cursor += root_bytes;
  if (operation == 2 && !DecodePath(cursor, static_cast<std::size_t>(path_bytes), &relative)) return ERROR_INVALID_PARAMETER;
  cursor += path_bytes;
  std::vector<std::uint8_t> content(cursor, cursor + content_bytes);
  cursor += content_bytes;
  std::optional<std::vector<std::uint8_t>> expected;
  if (expected_bytes != kAbsent) expected.emplace(cursor, cursor + expected_bytes);
  PinnedCellToolDirectory directory;
  DWORD error = directory.Open(root, operation == 1 ? nullptr : &expected_identity);
  if (error) return error;
  *identity = directory.Identity();
  return operation == 1 ? ERROR_SUCCESS : directory.Write(relative, content, expected, result);
}
}

int wmain(int argc, wchar_t**) {
  if (argc != 1 || GetFileType(GetStdHandle(STD_INPUT_HANDLE)) != FILE_TYPE_PIPE ||
      GetFileType(GetStdHandle(STD_OUTPUT_HANDLE)) != FILE_TYPE_PIPE) return 2;
  CellFileIdentity identity{};
  CellToolWriteResult result{};
  DWORD error = ERROR_INVALID_PARAMETER;
  try {
    std::vector<std::uint8_t> bytes;
    std::array<std::uint8_t, 8192> buffer{};
    bool complete = false;
    for (;;) {
      DWORD received = 0;
      if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), buffer.data(), static_cast<DWORD>(buffer.size()), &received, nullptr)) {
        complete = GetLastError() == ERROR_BROKEN_PIPE;
        break;
      }
      if (!received) { complete = true; break; }
      if (bytes.size() + received > kMaximumInput) break;
      bytes.insert(bytes.end(), buffer.begin(), buffer.begin() + received);
    }
    if (complete) error = Execute(bytes, &identity, &result);
  } catch (...) { error = ERROR_NOT_ENOUGH_MEMORY; }
  std::array<std::uint8_t, 80> response{};
  std::memcpy(response.data(), "GCFILER1", 8);
  Put(response.data() + 8, error, 4);
  Put(response.data() + 12, result.effect_started ? 1 : 0, 4);
  Put(response.data() + 16, result.created ? 1 : 0, 4);
  Put(response.data() + 20, result.bytes, 4);
  Put(response.data() + 24, identity.volume_serial, 8);
  std::copy(identity.file_id.begin(), identity.file_id.end(), response.begin() + 32);
  std::copy(result.sha256.begin(), result.sha256.end(), response.begin() + 48);
  DWORD sent = 0;
  return WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), response.data(), static_cast<DWORD>(response.size()), &sent, nullptr) &&
    sent == response.size() ? 0 : 3;
}
