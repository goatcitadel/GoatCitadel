#include "cell_runtime_file_transfer.hpp"
#include <algorithm>
#include <bcrypt.h>
#include <cstring>
#include <utility>

namespace goatcitadel::worker_cell {
namespace {
using Header = std::array<std::uint8_t, 112>;
void Put(std::uint8_t* bytes, std::uint64_t value, unsigned count = 4) noexcept {
  for (unsigned i = 0; i < count; ++i) bytes[i] = static_cast<std::uint8_t>(value >> (8 * i));
}
std::uint64_t Number(const std::uint8_t* bytes, unsigned count = 4) noexcept {
  std::uint64_t value = 0; for (unsigned i = 0; i < count; ++i) value |= std::uint64_t{bytes[i]} << (8 * i); return value;
}
template<class T> bool Nonzero(const T& value) noexcept { return std::any_of(value.begin(), value.end(), [](auto byte) { return byte != 0; }); }
bool Valid(const CellRuntimeFileExpectation& expected) noexcept {
  return Nonzero(expected.binding.nonce) && Nonzero(expected.binding.request_sha256) && Nonzero(expected.result_sha256) &&
    expected.work.volume_serial && Nonzero(expected.work.file_id) && expected.work.volume_serial == expected.file.identity.volume_serial &&
    Nonzero(expected.file.identity.file_id) && expected.work != expected.file.identity && !expected.file.directory &&
    expected.maximum_bytes && expected.maximum_bytes <= 1048576 && expected.file.logical_file_bytes <= expected.maximum_bytes &&
    expected.file.allocated_bytes <= 9007199254740991ULL;
}
DWORD Hash(std::span<const std::uint8_t> bytes, CellFileSha256* result) noexcept {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return ERROR_NOT_SUPPORTED;
  const auto status = BCryptHash(algorithm, nullptr, 0, const_cast<PUCHAR>(bytes.data()), static_cast<ULONG>(bytes.size()), result->data(), 32);
  BCryptCloseAlgorithmProvider(algorithm, 0); return status < 0 ? ERROR_INVALID_DATA : ERROR_SUCCESS;
}
Header Frame(const char* magic, const CellRuntimeFileExpectation& expected, const CellFileSha256& digest) noexcept {
  Header bytes{}; std::memcpy(bytes.data(), magic, 8);
  std::copy(expected.binding.nonce.begin(), expected.binding.nonce.end(), bytes.begin() + 8);
  std::copy(expected.binding.request_sha256.begin(), expected.binding.request_sha256.end(), bytes.begin() + 40);
  std::copy(digest.begin(), digest.end(), bytes.begin() + 72);
  Put(bytes.data() + 104, 200 + expected.file.logical_file_bytes); Put(bytes.data() + 108, 4096); return bytes;
}
bool Identity(const std::uint8_t* bytes, const CellFileIdentity& identity) noexcept {
  return Number(bytes, 8) == identity.volume_serial && std::equal(identity.file_id.begin(), identity.file_id.end(), bytes + 8);
}
DWORD ValidateRecord(std::span<const std::uint8_t> bytes, const CellRuntimeFileExpectation& expected) noexcept {
  if (!Valid(expected) || bytes.size() != 200 + expected.file.logical_file_bytes || std::memcmp(bytes.data(), "GCRFA001", 8) ||
      !std::equal(expected.binding.nonce.begin(), expected.binding.nonce.end(), bytes.begin() + 8) ||
      !std::equal(expected.binding.request_sha256.begin(), expected.binding.request_sha256.end(), bytes.begin() + 40) ||
      !std::equal(expected.result_sha256.begin(), expected.result_sha256.end(), bytes.begin() + 72) ||
      !Identity(bytes.data() + 104, expected.work) || !Identity(bytes.data() + 128, expected.file.identity) ||
      Number(bytes.data() + 152, 8) != expected.file.logical_file_bytes || Number(bytes.data() + 160, 8) != expected.file.allocated_bytes)
    return ERROR_INVALID_DATA;
  CellFileSha256 digest{}; const auto error = Hash(bytes.subspan(200), &digest);
  return error ? error : std::equal(digest.begin(), digest.end(), bytes.begin() + 168) ? ERROR_SUCCESS : ERROR_CRC;
}
struct PrivateBytes final {
  std::vector<std::uint8_t> value;
  ~PrivateBytes() { if (!value.empty()) SecureZeroMemory(value.data(), value.size()); }
};
}
DWORD MakeCellRuntimeFileExpectation(const CellRuntimeDispatch& dispatch, const CellRuntimeDispatchResult& retained,
  const CellFileIdentity& identity, DWORD maximum_bytes, CellRuntimeFileExpectation* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  try {
    std::vector<std::uint8_t> bytes; auto error = EncodeCellRuntimeResult(dispatch, retained, &bytes);
    if (error || !retained.execution.inventory_verified) return error ? error : ERROR_INVALID_DATA;
    const auto& entries = retained.execution.inventory.inventory.entries;
    const auto file = std::find_if(entries.begin(), entries.end(), [&](const auto& item) { return item.identity == identity; });
    if (file == entries.end()) return ERROR_FILE_NOT_FOUND;
    CellRuntimeFileExpectation expected{dispatch.binding, {},
      dispatch.command.protected_workspace->identities.directories[static_cast<std::size_t>(CellDirectory::work)], *file, maximum_bytes};
    error = HashCellRuntimeResult(bytes, &expected.result_sha256);
    if (error || !Valid(expected)) return error ? error : ERROR_INVALID_DATA;
    *output = expected; return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD DecodeCellRuntimeFileSelections(const CellRuntimeDispatch& request, const CellRuntimeDispatchResult& retained,
  std::span<const std::uint8_t> bytes, std::vector<CellRuntimeFileSelection>* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  output->clear();
  try {
    if (!request.file_staging || request.file_staging->paths.empty() || request.file_staging->paths.size() > 64 ||
        !request.file_staging->maximum_total_bytes || request.file_staging->maximum_total_bytes > 64 * 1048576 ||
        bytes.size() != 108 + 24 * request.file_staging->paths.size() || std::memcmp(bytes.data(), "GCFSL001", 8) ||
        Number(bytes.data() + 104) != request.file_staging->paths.size() ||
        !std::equal(request.binding.nonce.begin(), request.binding.nonce.end(), bytes.begin() + 8) ||
        !std::equal(request.binding.request_sha256.begin(), request.binding.request_sha256.end(), bytes.begin() + 40)) return ERROR_INVALID_DATA;
    std::vector<CellRuntimeFileSelection> selected;
    std::uint64_t total = 0;
    for (std::size_t index = 0; index < request.file_staging->paths.size(); ++index) {
      const auto& path = request.file_staging->paths[index];
      if (!IsCellRuntimeFileSelectionPath(path)) return ERROR_INVALID_DATA;
      CellFileIdentity identity; identity.volume_serial = Number(bytes.data() + 108 + index * 24, 8);
      std::copy_n(bytes.begin() + 116 + index * 24, 16, identity.file_id.begin());
      for (const auto& previous : selected)
        if (previous.expected.file.identity == identity || CompareStringOrdinal(previous.relative_path.data(),
            static_cast<int>(previous.relative_path.size()), path.data(), static_cast<int>(path.size()), TRUE) == CSTR_EQUAL) return ERROR_INVALID_DATA;
      CellRuntimeFileSelection selection; selection.relative_path = path;
      const auto error = MakeCellRuntimeFileExpectation(request, retained, identity, request.file_staging->maximum_file_bytes, &selection.expected);
      if (error || !std::equal(selection.expected.result_sha256.begin(), selection.expected.result_sha256.end(), bytes.begin() + 72))
        return error ? error : ERROR_INVALID_DATA;
      total += selection.expected.file.logical_file_bytes;
      if (total > request.file_staging->maximum_total_bytes) return ERROR_INVALID_DATA;
      selected.push_back(std::move(selection));
    }
    *output = std::move(selected); return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD EncodeCellRuntimeFileAuthorization(const CellRuntimeFileSelection& selection, CellRuntimeFileAuthorizationBytes* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  try {
    const auto& expected = selection.expected;
    if (!Valid(expected) || !IsCellRuntimeFileSelectionPath(selection.relative_path)) return ERROR_INVALID_DATA;
    CellRuntimeFileAuthorizationBytes bytes{};
    std::copy(expected.result_sha256.begin(), expected.result_sha256.end(), bytes.begin());
    for (const auto& entry : {std::pair<std::size_t, CellFileIdentity>{32, expected.work}, {56, expected.file.identity}}) {
      Put(bytes.data() + entry.first, entry.second.volume_serial, 8);
      std::copy(entry.second.file_id.begin(), entry.second.file_id.end(), bytes.begin() + entry.first + 8);
    }
    Put(bytes.data() + 80, expected.file.logical_file_bytes, 8); Put(bytes.data() + 88, expected.file.allocated_bytes, 8);
    Put(bytes.data() + 96, expected.maximum_bytes);
    const auto size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, selection.relative_path.data(),
      static_cast<int>(selection.relative_path.size()), reinterpret_cast<char*>(bytes.data() + 104), 512, nullptr, nullptr);
    if (!size) return ERROR_INVALID_DATA;
    Put(bytes.data() + 100, static_cast<unsigned>(size)); *output = bytes; return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD DecodeCellRuntimeFileAuthorization(const CellRuntimeDispatchBinding& supplied_binding, const CellRuntimeFileAuthorizationBytes& bytes,
  CellRuntimeFileSelection* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  const auto binding = supplied_binding; *output = {};
  try {
    const auto size = Number(bytes.data() + 100);
    if (!size || size > 512 || std::any_of(bytes.begin() + 104 + size, bytes.end(), [](auto value) { return value != 0; })) return ERROR_INVALID_DATA;
    CellRuntimeFileSelection value; auto& expected = value.expected; expected.binding = binding;
    std::copy_n(bytes.begin(), 32, expected.result_sha256.begin());
    expected.work.volume_serial = Number(bytes.data() + 32, 8); std::copy_n(bytes.begin() + 40, 16, expected.work.file_id.begin());
    expected.file.identity.volume_serial = Number(bytes.data() + 56, 8); std::copy_n(bytes.begin() + 64, 16, expected.file.identity.file_id.begin());
    expected.file.logical_file_bytes = Number(bytes.data() + 80, 8); expected.file.allocated_bytes = Number(bytes.data() + 88, 8);
    expected.maximum_bytes = static_cast<DWORD>(Number(bytes.data() + 96));
    const auto* text = reinterpret_cast<const char*>(bytes.data() + 104);
    const auto length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, static_cast<int>(size), nullptr, 0);
    if (!length) return ERROR_INVALID_DATA;
    value.relative_path.resize(static_cast<std::size_t>(length));
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, static_cast<int>(size), value.relative_path.data(), length) != length) return ERROR_INVALID_DATA;
    CellRuntimeFileAuthorizationBytes canonical{};
    const auto error = EncodeCellRuntimeFileAuthorization(value, &canonical);
    if (error || canonical != bytes) return error ? error : ERROR_INVALID_DATA;
    *output = std::move(value); return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD EncodeCellRuntimeFileSelections(const CellRuntimeDispatch& request, const CellRuntimeDispatchResult& retained,
  std::vector<std::uint8_t>* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  try {
    const auto encode = [&]() -> DWORD {
      if (!request.file_staging || request.file_staging->paths.empty() || request.file_staging->paths.size() > 64 ||
          retained.execution.staged_files.size() != request.file_staging->paths.size()) return ERROR_INVALID_DATA;
      std::vector<std::uint8_t> bytes(108 + 24 * request.file_staging->paths.size());
      std::memcpy(bytes.data(), "GCFSL001", 8);
      std::copy(request.binding.nonce.begin(), request.binding.nonce.end(), bytes.begin() + 8);
      std::copy(request.binding.request_sha256.begin(), request.binding.request_sha256.end(), bytes.begin() + 40);
      Put(bytes.data() + 104, request.file_staging->paths.size());
      for (std::size_t index = 0; index < request.file_staging->paths.size(); ++index) {
        const auto& staged = retained.execution.staged_files[index];
        if (staged.relative_path != request.file_staging->paths[index]) return ERROR_INVALID_DATA;
        PrivateBytes content;
        const auto error = EncodeCellRuntimeStagedFile(request, retained, staged.entry.identity, &content.value);
        if (error) return error;
        std::copy_n(content.value.begin() + 72, 32, bytes.begin() + 72);
        Put(bytes.data() + 108 + index * 24, staged.entry.identity.volume_serial, 8);
        std::copy(staged.entry.identity.file_id.begin(), staged.entry.identity.file_id.end(), bytes.begin() + 116 + index * 24);
      }
      std::vector<CellRuntimeFileSelection> selected;
      const auto error = DecodeCellRuntimeFileSelections(request, retained, bytes, &selected);
      if (error) return error;
      *output = std::move(bytes); return ERROR_SUCCESS;
    };
    const auto error = encode(); if (error) output->clear(); return error;
  } catch (...) { output->clear(); return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellRuntimeFileTransfer::Fail(DWORD error) noexcept { if (error && !failure_) failure_ = error; return failure_; }
DWORD CellRuntimeFileTransfer::Check() noexcept {
  if (failure_) return failure_;
  const auto control = [&]() noexcept -> DWORD {
    if (!authority_.authorize || !authority_.cancellation || authority_.cancellation == INVALID_HANDLE_VALUE || !Valid(expected_)) return ERROR_INVALID_PARAMETER;
    const auto state = WaitForSingleObject(authority_.cancellation, 0);
    if (state != WAIT_TIMEOUT) return state == WAIT_OBJECT_0 ? ERROR_OPERATION_ABORTED : ERROR_INVALID_HANDLE;
    const auto now = GetTickCount64(); return now >= deadline_ ? ERROR_TIMEOUT : deadline_ - now > 600000 ? ERROR_INVALID_PARAMETER : ERROR_SUCCESS;
  };
  auto error = control(); if (!error) error = authority_.authorize(authority_.context);
  if (!error) error = control(); return Fail(error);
}
DWORD CellRuntimeFileTransfer::Begin() noexcept { if (attempted_) return Fail(ERROR_INVALID_STATE); attempted_ = true; return Check(); }
DWORD CellRuntimeFileTransfer::Write(std::span<const std::uint8_t> supplied) noexcept {
  if (attempted_) return Fail(ERROR_INVALID_STATE);
  try {
    if (!Valid(expected_) || supplied.size() != 200 + expected_.file.logical_file_bytes) { attempted_ = true; return Fail(ERROR_INVALID_DATA); }
    PrivateBytes bytes; bytes.value.assign(supplied.begin(), supplied.end()); // Freeze before callbacks.
    auto error = ValidateRecord(bytes.value, expected_);
    if (error) { attempted_ = true; return Fail(error); }
    error = Begin(); CellFileSha256 digest{};
    if (!error) error = Hash(bytes.value, &digest);
    const auto header = Frame("GCFHS001", expected_, digest);
    if (!error) error = WriteCellPipe(pipe_, header.data(), 112, authority_.cancellation, deadline_);
    for (DWORD offset = 0; !error && offset < bytes.value.size();) {
      error = Check(); if (error) break;
      const auto count = std::min(DWORD{4096}, static_cast<DWORD>(bytes.value.size()) - offset);
      std::array<std::uint8_t, 16> chunk{}; std::memcpy(chunk.data(), "GCFHC001", 8); Put(chunk.data() + 8, offset); Put(chunk.data() + 12, count);
      error = WriteCellPipe(pipe_, chunk.data(), 16, authority_.cancellation, deadline_);
      if (!error) error = WriteCellPipe(pipe_, bytes.value.data() + offset, count, authority_.cancellation, deadline_);
      if (!error) error = Check(); offset += count;
    }
    Header ack{};
    if (!error) error = ReadCellPipe(pipe_, ack.data(), 112, authority_.cancellation, deadline_);
    if (!error && ack != Frame("GCFHA001", expected_, digest)) error = ERROR_INVALID_DATA;
    if (!error) error = Check(); if (!error) validated_ = true;
    return Fail(error);
  } catch (...) { attempted_ = true; return Fail(ERROR_NOT_ENOUGH_MEMORY); }
}
DWORD CellRuntimeFileTransfer::Read(std::vector<std::uint8_t>* output) noexcept {
  if (output) { if (!output->empty()) SecureZeroMemory(output->data(), output->size()); output->clear(); }
  if (!output) { attempted_ = true; return Fail(ERROR_INVALID_PARAMETER); }
  auto error = Begin(); if (error) return error;
  try {
    Header header{}; error = ReadCellPipe(pipe_, header.data(), 112, authority_.cancellation, deadline_);
    if (!error) error = Check(); if (error) return Fail(error);
    CellFileSha256 digest{}; std::copy_n(header.begin() + 72, 32, digest.begin());
    if (!Nonzero(digest) || header != Frame("GCFHS001", expected_, digest)) return Fail(ERROR_INVALID_DATA);
    PrivateBytes bytes; bytes.value.resize(200 + expected_.file.logical_file_bytes);
    for (DWORD offset = 0; offset < bytes.value.size();) {
      error = Check(); if (error) return error;
      std::array<std::uint8_t, 16> chunk{}; error = ReadCellPipe(pipe_, chunk.data(), 16, authority_.cancellation, deadline_);
      if (error) return Fail(error);
      const auto count = std::min(DWORD{4096}, static_cast<DWORD>(bytes.value.size()) - offset);
      if (std::memcmp(chunk.data(), "GCFHC001", 8) || Number(chunk.data() + 8) != offset || Number(chunk.data() + 12) != count) return Fail(ERROR_INVALID_DATA);
      error = ReadCellPipe(pipe_, bytes.value.data() + offset, count, authority_.cancellation, deadline_);
      if (!error) error = Check(); if (error) return Fail(error); offset += count;
    }
    CellFileSha256 actual{}; error = Hash(bytes.value, &actual);
    if (!error && actual != digest) error = ERROR_CRC;
    if (!error) error = ValidateRecord(bytes.value, expected_);
    if (!error) error = Check(); const auto ack = Frame("GCFHA001", expected_, digest);
    if (!error) error = WriteCellPipe(pipe_, ack.data(), 112, authority_.cancellation, deadline_);
    if (!error) error = Check();
    if (!error) { output->swap(bytes.value); validated_ = true; }
    return Fail(error);
  } catch (...) { return Fail(ERROR_NOT_ENOUGH_MEMORY); }
}

DWORD CellRuntimeFileBatchTransfer::Fail(DWORD error) noexcept {
  if (error && !failure_) failure_ = error; return failure_;
}
DWORD CellRuntimeFileBatchTransfer::Check() noexcept {
  if (failure_) return failure_;
  const auto check = [&]() -> DWORD {
    if (!authority_.authorize || !owner_.authorize || !authority_.cancellation || authority_.cancellation == INVALID_HANDLE_VALUE)
      return ERROR_INVALID_PARAMETER;
    const auto state = WaitForSingleObject(authority_.cancellation, 0);
    if (state != WAIT_TIMEOUT) return state == WAIT_OBJECT_0 ? ERROR_OPERATION_ABORTED : ERROR_INVALID_HANDLE;
    const auto now = GetTickCount64();
    return now >= deadline_ ? ERROR_TIMEOUT : deadline_ - now > 600000 ? ERROR_INVALID_PARAMETER : ERROR_SUCCESS;
  };
  auto error = check();
  if (!error) error = authority_.authorize(authority_.context);
  if (!error) error = failure_ ? failure_ : check();
  return Fail(error);
}
struct CellRuntimeFileBatchTransfer::SelectionGuard final {
  CellRuntimeFileBatchTransfer& batch;
  const CellRuntimeFileSelection& selection;
  static DWORD Authorize(void* raw) noexcept {
    auto& self = *static_cast<SelectionGuard*>(raw);
    auto error = self.batch.Check();
    if (!error) error = self.batch.owner_.authorize(self.batch.owner_.context, self.selection, self.batch.deadline_);
    if (!error) error = self.batch.Check();
    return self.batch.Fail(error);
  }
};
namespace {
std::array<std::uint8_t, 40> FileBatchReceipt(const char* magic, const CellFileSha256& digest) noexcept {
  std::array<std::uint8_t, 40> bytes{}; std::memcpy(bytes.data(), magic, 8);
  std::copy(digest.begin(), digest.end(), bytes.begin() + 8); return bytes;
}
}
DWORD CellRuntimeFileBatchTransfer::Write(const CellRuntimeDispatchResult& retained) noexcept {
  if (attempted_) return Fail(ERROR_INVALID_STATE); attempted_ = true;
  try {
    // Freeze metadata and content before any caller-controlled callback.
    std::vector<std::uint8_t> manifest;
    auto error = EncodeCellRuntimeFileSelections(request_, retained, &manifest);
    std::vector<CellRuntimeFileSelection> selected;
    if (!error) error = DecodeCellRuntimeFileSelections(request_, retained, manifest, &selected);
    if (error) return Fail(error);
    std::vector<PrivateBytes> records(selected.size());
    for (std::size_t index = 0; index < selected.size(); ++index) {
      error = EncodeCellRuntimeStagedFile(request_, retained, selected[index].expected.file.identity, &records[index].value);
      if (error) return Fail(error);
    }
    CellFileSha256 digest{}; error = Hash(manifest, &digest);
    if (!error) error = Check();
    if (!error) error = WriteCellPipe(pipe_, manifest.data(), static_cast<DWORD>(manifest.size()), authority_.cancellation, deadline_);
    if (!error) error = Check();
    std::array<std::uint8_t, 40> receipt{};
    if (!error) error = ReadCellPipe(pipe_, receipt.data(), 40, authority_.cancellation, deadline_);
    if (!error && receipt != FileBatchReceipt("GCFSA001", digest)) error = ERROR_INVALID_DATA;
    for (std::size_t index = 0; !error && index < selected.size(); ++index) {
      SelectionGuard guard{*this, selected[index]};
      CellRuntimeFileTransfer transfer(pipe_, deadline_, selected[index].expected, {SelectionGuard::Authorize, &guard, authority_.cancellation});
      error = transfer.Write(records[index].value);
      if (!error && !transfer.ValidatedReceipt()) error = ERROR_INVALID_STATE;
    }
    if (!error) error = Check();
    if (!error) error = ReadCellPipe(pipe_, receipt.data(), 40, authority_.cancellation, deadline_);
    if (!error && receipt != FileBatchReceipt("GCFSD001", digest)) error = ERROR_INVALID_DATA;
    if (!error) error = Check();
    if (!error) validated_ = true;
    return Fail(error);
  } catch (...) { return Fail(ERROR_NOT_ENOUGH_MEMORY); }
}
DWORD CellRuntimeFileBatchTransfer::Read(const CellRuntimeDispatchResult& retained, std::vector<CellRuntimeStagedFile>* output) noexcept {
  if (output) output->clear();
  if (attempted_) return Fail(ERROR_INVALID_STATE); attempted_ = true;
  if (!output) return Fail(ERROR_INVALID_PARAMETER);
  try {
    if (!request_.file_staging || request_.file_staging->paths.empty() || request_.file_staging->paths.size() > 64)
      return Fail(ERROR_INVALID_PARAMETER);
    std::vector<std::uint8_t> terminal;
    auto error = EncodeCellRuntimeResult(request_, retained, &terminal);
    CellRuntimeDispatchResult snapshot;
    if (!error) error = DecodeCellRuntimeResult(request_, terminal, &snapshot);
    if (!error) error = Check();
    std::vector<std::uint8_t> manifest(108 + 24 * request_.file_staging->paths.size());
    if (!error) error = ReadCellPipe(pipe_, manifest.data(), static_cast<DWORD>(manifest.size()), authority_.cancellation, deadline_);
    if (!error) error = Check();
    std::vector<CellRuntimeFileSelection> selected;
    if (!error) error = DecodeCellRuntimeFileSelections(request_, snapshot, manifest, &selected);
    for (std::size_t index = 0; !error && index < selected.size(); ++index) {
      SelectionGuard guard{*this, selected[index]}; error = SelectionGuard::Authorize(&guard);
    }
    CellFileSha256 digest{}; if (!error) error = Hash(manifest, &digest);
    const auto receipt = FileBatchReceipt("GCFSA001", digest);
    if (!error) error = WriteCellPipe(pipe_, receipt.data(), 40, authority_.cancellation, deadline_);
    std::vector<CellRuntimeStagedFile> received;
    for (std::size_t index = 0; !error && index < selected.size(); ++index) {
      SelectionGuard guard{*this, selected[index]};
      CellRuntimeFileTransfer transfer(pipe_, deadline_, selected[index].expected, {SelectionGuard::Authorize, &guard, authority_.cancellation});
      PrivateBytes record; error = transfer.Read(&record.value);
      if (!error && !transfer.ValidatedReceipt()) error = ERROR_INVALID_STATE;
      if (!error) {
        CellRuntimeStagedFile file; file.entry = selected[index].expected.file; file.relative_path = selected[index].relative_path;
        file.bytes.assign(record.value.begin() + 200, record.value.end()); received.push_back(std::move(file));
      }
    }
    if (!error) error = Check();
    const auto complete = FileBatchReceipt("GCFSD001", digest);
    if (!error) error = WriteCellPipe(pipe_, complete.data(), 40, authority_.cancellation, deadline_);
    if (!error) error = Check();
    if (!error) { *output = std::move(received); validated_ = true; }
    return Fail(error);
  } catch (...) { return Fail(ERROR_NOT_ENOUGH_MEMORY); }
}
}
