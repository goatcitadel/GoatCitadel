#include "protected_operations.hpp"

#if defined(GOATCITADEL_PROVISIONER_TESTING)

#include <windows.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace gc = goatcitadel::remote_worker_provisioner;

namespace {

static_assert(gc::kStateHeaderBytes == 224U);
static_assert(gc::kGenerationEntryBytes == 448U);
static_assert(gc::kOperationEntryBytes == 64U);
static_assert(gc::kResidueEntryBytes == 84U);
static_assert(gc::kMaximumBurnedGenerations == 16U);
static_assert(gc::kMaximumOperationIds == 256U);
static_assert(gc::kMaximumResidues == 256U);
static_assert(gc::kMaximumPublicationSequence == 864U);
static_assert(gc::kMaximumHistoricalCustodyKeys == 64U);
static_assert(sizeof(gc::ProtectedGenerationProjection) == 449U);
static_assert(sizeof(gc::ProtectedOperationProjection) == 65U);
static_assert(sizeof(gc::ProtectedResidueProjection) == 85U);
static_assert(sizeof(gc::HistoricalCustodyKey) == 76U);

constexpr char kStateDomain[] =
    "goatcitadel.remote-worker.provisioner.custody-state.v1";
constexpr std::size_t kMaximumCanonicalStateBytes =
    gc::kStateHeaderBytes +
    gc::kMaximumBurnedGenerations * gc::kGenerationEntryBytes +
    gc::kMaximumOperationIds * gc::kOperationEntryBytes +
    gc::kMaximumResidues * gc::kResidueEntryBytes;
static_assert(kMaximumCanonicalStateBytes == 45280U);
static_assert(sizeof(kStateDomain) + kMaximumCanonicalStateBytes == 45335U);

void WriteU16(std::uint8_t* bytes, std::uint16_t value) noexcept {
  bytes[0] = static_cast<std::uint8_t>(value & 0xffU);
  bytes[1] = static_cast<std::uint8_t>((value >> 8U) & 0xffU);
}

void WriteU32(std::uint8_t* bytes, std::uint32_t value) noexcept {
  for (std::size_t index = 0U; index < 4U; ++index) {
    bytes[index] = static_cast<std::uint8_t>(
        (value >> (index * 8U)) & UINT32_C(0xff));
  }
}

void WriteU64(std::uint8_t* bytes, std::uint64_t value) noexcept {
  for (std::size_t index = 0U; index < 8U; ++index) {
    bytes[index] = static_cast<std::uint8_t>(
        (value >> (index * 8U)) & UINT64_C(0xff));
  }
}

std::uint16_t ReadU16(const std::uint8_t* bytes) noexcept {
  return static_cast<std::uint16_t>(bytes[0]) |
         static_cast<std::uint16_t>(bytes[1] << 8U);
}

std::uint32_t ReadU32(const std::uint8_t* bytes) noexcept {
  std::uint32_t value = 0U;
  for (std::size_t index = 0U; index < 4U; ++index) {
    value |= static_cast<std::uint32_t>(bytes[index]) << (index * 8U);
  }
  return value;
}

std::uint64_t ReadU64(const std::uint8_t* bytes) noexcept {
  std::uint64_t value = 0U;
  for (std::size_t index = 0U; index < 8U; ++index) {
    value |= static_cast<std::uint64_t>(bytes[index]) << (index * 8U);
  }
  return value;
}

bool AllZero(const std::uint8_t* bytes, std::size_t size) noexcept {
  std::uint8_t aggregate = 0U;
  for (std::size_t index = 0U; index < size; ++index) {
    aggregate = static_cast<std::uint8_t>(aggregate | bytes[index]);
  }
  return aggregate == 0U;
}

bool HashStateHeader(
    const std::array<std::uint8_t, gc::kStateHeaderBytes>& header,
    gc::Byte32* digest) noexcept {
  std::array<std::uint8_t, sizeof(kStateDomain) + gc::kStateHeaderBytes> projection{};
  std::memcpy(projection.data(), kStateDomain, sizeof(kStateDomain));
  std::memcpy(
      projection.data() + sizeof(kStateDomain),
      header.data(),
      header.size());
  return gc::ComputeSha256(projection.data(), projection.size(), digest);
}

std::array<std::uint8_t, gc::kCreateKeysetRequestBytes> CreateBody(
    const gc::Byte32& state,
    std::uint64_t generation,
    std::uint64_t predecessor) noexcept {
  std::array<std::uint8_t, gc::kCreateKeysetRequestBytes> body{};
  for (std::size_t index = 0U; index < 16U; ++index) {
    body[index] = static_cast<std::uint8_t>(index + 1U);
  }
  std::memcpy(body.data() + 16U, state.data(), state.size());
  WriteU16(body.data() + 48U, 1U);
  WriteU64(body.data() + 52U, generation);
  WriteU64(body.data() + 60U, predecessor);
  return body;
}

std::array<std::uint8_t, gc::kRevokeKeysetRequestBytes> RevokeBody(
    const gc::Byte32& state,
    std::uint64_t generation,
    std::uint32_t reason,
    const gc::Byte32* expected_receipt = nullptr) noexcept {
  std::array<std::uint8_t, gc::kRevokeKeysetRequestBytes> body{};
  for (std::size_t index = 0U; index < 16U; ++index) {
    body[index] = static_cast<std::uint8_t>(0x20U + index);
  }
  std::memcpy(body.data() + 16U, state.data(), state.size());
  WriteU16(body.data() + 48U, 1U);
  WriteU64(body.data() + 52U, generation);
  WriteU32(body.data() + 60U, reason);
  if (expected_receipt == nullptr) {
    body[68] = 1U;
  } else {
    std::memcpy(
        body.data() + 68U,
        expected_receipt->data(),
        expected_receipt->size());
  }
  return body;
}

template <std::size_t BodyBytes>
void SeedReplay(
    gc::ProtectedOperationReplayState* replay,
    std::uint8_t opcode,
    const std::array<std::uint8_t, BodyBytes>& body,
    const std::array<std::uint8_t, 12U>& sid,
    bool quarantined,
    std::uint16_t disposition,
    std::uint32_t result_length) noexcept {
  if (replay == nullptr) return;
  *replay = gc::ProtectedOperationReplayState{};
  replay->present = true;
  replay->quarantined = quarantined;
  replay->opcode = opcode;
  std::memcpy(replay->operation_id.data(), body.data(), replay->operation_id.size());
  replay->operator_sid_length = static_cast<std::uint16_t>(sid.size());
  std::memcpy(replay->operator_sid.data(), sid.data(), sid.size());
  replay->body_length = static_cast<std::uint16_t>(body.size());
  std::memcpy(replay->body.data(), body.data(), body.size());
  replay->attempt_count = 1U;
  replay->next_sequence = 4U;
  replay->result_length = result_length;
  WriteU16(replay->result.data(), 1U);
  WriteU16(replay->result.data() + 2U, disposition);
  std::memcpy(replay->result.data() + 8U, body.data(), 16U);
}

gc::ProtectedGenerationProjection GenerationProjection(
    std::uint64_t generation,
    std::uint8_t lifecycle,
    std::uint8_t seed) noexcept {
  gc::ProtectedGenerationProjection projection{};
  projection.present = true;
  WriteU64(projection.bytes.data(), generation);
  WriteU64(
      projection.bytes.data() + 8U,
      generation > 1U ? generation - 1U : 0U);
  projection.bytes[16] = lifecycle;
  projection.bytes[24] = seed == 0U ? 1U : seed;
  if (lifecycle == 4U) return projection;
  projection.bytes[40] = static_cast<std::uint8_t>(seed + 1U);
  if (lifecycle == 5U) {
    projection.bytes[416] = static_cast<std::uint8_t>(seed + 2U);
    return projection;
  }
  constexpr std::array<std::size_t, 5U> kIdentityOffsets = {
      64U, 88U, 112U, 136U, 160U};
  constexpr std::array<std::size_t, 4U> kHashOffsets = {
      184U, 216U, 248U, 280U};
  for (std::size_t index = 0U; index < kIdentityOffsets.size(); ++index) {
    projection.bytes[kIdentityOffsets[index]] =
        static_cast<std::uint8_t>(seed + 2U + index);
  }
  for (std::size_t index = 0U; index < kHashOffsets.size(); ++index) {
    projection.bytes[kHashOffsets[index]] =
        static_cast<std::uint8_t>(seed + 7U + index);
  }
  projection.bytes[312] = static_cast<std::uint8_t>(seed + 11U);
  if (lifecycle == 3U) {
    projection.bytes[344] = static_cast<std::uint8_t>(seed + 4U);
    projection.bytes[368] = static_cast<std::uint8_t>(seed + 5U);
    projection.bytes[400] = static_cast<std::uint8_t>(seed + 6U);
  }
  return projection;
}

gc::ProtectedOperationProjection OperationProjection(
    std::uint16_t ordinal,
    gc::Opcode opcode,
    std::uint8_t status,
    std::uint64_t generation) noexcept {
  gc::ProtectedOperationProjection projection{};
  projection.present = true;
  projection.bytes[0] = static_cast<std::uint8_t>(ordinal & 0xffU);
  projection.bytes[1] = static_cast<std::uint8_t>((ordinal >> 8U) & 0xffU);
  if (ordinal == 0U) projection.bytes[0] = 1U;
  projection.bytes[16] = static_cast<std::uint8_t>(opcode);
  projection.bytes[17] = status;
  WriteU64(projection.bytes.data() + 24U, generation);
  projection.bytes[32] = static_cast<std::uint8_t>(
      (ordinal % UINT16_C(254)) + 1U);
  return projection;
}

gc::ProtectedResidueProjection ResidueProjection(
    std::uint16_t operation_ordinal,
    std::uint8_t residue_ordinal,
    std::uint8_t kind,
    std::uint16_t publication_sequence) noexcept {
  gc::ProtectedResidueProjection projection{};
  projection.present = true;
  projection.bytes[0] = static_cast<std::uint8_t>(operation_ordinal & 0xffU);
  projection.bytes[1] =
      static_cast<std::uint8_t>((operation_ordinal >> 8U) & 0xffU);
  if (operation_ordinal == 0U) projection.bytes[0] = 1U;
  projection.bytes[16] = residue_ordinal;
  projection.bytes[17] = kind;
  WriteU16(projection.bytes.data() + 18U, publication_sequence);
  WriteU64(projection.bytes.data() + 20U, kind == 3U ? 255U : 1023U);
  projection.bytes[28] = static_cast<std::uint8_t>(residue_ordinal + 1U);
  projection.bytes[52] = static_cast<std::uint8_t>(
      (operation_ordinal % UINT16_C(254)) + 1U);
  return projection;
}

bool HashCanonicalProjection(
    const std::array<std::uint8_t,
                     gc::kMaximumStateProjectionBytesForTest>& projection,
    std::size_t projection_length,
    gc::Byte32* digest) noexcept {
  if (digest == nullptr ||
      projection_length > gc::kMaximumStateProjectionBytesForTest) {
    return false;
  }
  std::array<std::uint8_t,
             sizeof(kStateDomain) +
                 gc::kMaximumStateProjectionBytesForTest> input{};
  std::memcpy(input.data(), kStateDomain, sizeof(kStateDomain));
  std::memcpy(
      input.data() + sizeof(kStateDomain),
      projection.data(),
      projection_length);
  return gc::ComputeSha256(
      input.data(), sizeof(kStateDomain) + projection_length, digest);
}

void CanonicalFailure(int* failures, const char* message) noexcept {
  if (failures == nullptr || message == nullptr) return;
  ++*failures;
  std::size_t length = 0U;
  while (message[length] != '\0') ++length;
  DWORD written = 0U;
  WriteFile(
      GetStdHandle(STD_ERROR_HANDLE),
      message,
      static_cast<DWORD>(length),
      &written,
      nullptr);
}

void DiagnosticCount(const char* label, std::uint32_t value) noexcept {
  if (label == nullptr) return;
  std::array<char, 96U> bytes{};
  std::size_t offset = 0U;
  while (label[offset] != '\0' && offset + 16U < bytes.size()) {
    bytes[offset] = label[offset];
    ++offset;
  }
  std::array<char, 10U> digits{};
  std::size_t digit_count = 0U;
  do {
    digits[digit_count++] = static_cast<char>('0' + value % 10U);
    value /= 10U;
  } while (value != 0U && digit_count < digits.size());
  for (std::size_t index = 0U; index < digit_count; ++index) {
    bytes[offset++] = digits[digit_count - index - 1U];
  }
  bytes[offset++] = '\n';
  DWORD written = 0U;
  WriteFile(
      GetStdHandle(STD_ERROR_HANDLE),
      bytes.data(),
      static_cast<DWORD>(offset),
      &written,
      nullptr);
}

struct IsolatedRecoveryFixture final {
  std::array<wchar_t, gc::kProtectedPathCharacters> normal_root{};
  std::array<wchar_t, gc::kProtectedPathCharacters> extended_root{};
  std::size_t normal_length = 0U;
  std::size_t extended_length = 0U;
};

bool AppendTestPath(
    const wchar_t* parent,
    const wchar_t* component,
    std::array<wchar_t, gc::kProtectedPathCharacters>* output) noexcept {
  if (parent == nullptr || component == nullptr || output == nullptr) {
    return false;
  }
  output->fill(L'\0');
  std::size_t offset = 0U;
  while (parent[offset] != L'\0') {
    if (offset + 2U >= output->size()) return false;
    (*output)[offset] = parent[offset];
    ++offset;
  }
  if (offset != 0U && (*output)[offset - 1U] != L'\\') {
    (*output)[offset++] = L'\\';
  }
  for (std::size_t index = 0U; component[index] != L'\0'; ++index) {
    if (offset + 1U >= output->size()) return false;
    (*output)[offset++] = component[index];
  }
  return true;
}

bool CreateIsolatedRecoveryFixture(
    IsolatedRecoveryFixture* fixture) noexcept {
  if (fixture == nullptr) return false;
  *fixture = IsolatedRecoveryFixture{};
  std::array<wchar_t, MAX_PATH + 1U> temporary{};
  const DWORD temporary_length = GetTempPathW(
      static_cast<DWORD>(temporary.size()), temporary.data());
  if (temporary_length == 0U || temporary_length >= temporary.size() ||
      GetTempFileNameW(
          temporary.data(), L"gcr", 0U, fixture->normal_root.data()) == 0U ||
      DeleteFileW(fixture->normal_root.data()) == FALSE ||
      CreateDirectoryW(fixture->normal_root.data(), nullptr) == FALSE) {
    return false;
  }
  while (fixture->normal_root[fixture->normal_length] != L'\0') {
    ++fixture->normal_length;
  }
  constexpr wchar_t kExtendedPrefix[] = L"\\\\?\\";
  for (std::size_t index = 0U;
       index < std::size(kExtendedPrefix) - 1U;
       ++index) {
    fixture->extended_root[fixture->extended_length++] =
        kExtendedPrefix[index];
  }
  if (fixture->extended_length + fixture->normal_length + 1U >=
      fixture->extended_root.size()) {
    RemoveDirectoryW(fixture->normal_root.data());
    return false;
  }
  std::memcpy(
      fixture->extended_root.data() + fixture->extended_length,
      fixture->normal_root.data(),
      (fixture->normal_length + 1U) * sizeof(wchar_t));
  fixture->extended_length += fixture->normal_length;
  constexpr std::array<const wchar_t*, 4U> kChildren = {
      L"journal", L"keysets", L"controls", L"quarantine"};
  for (const wchar_t* child : kChildren) {
    std::array<wchar_t, gc::kProtectedPathCharacters> path{};
    if (!AppendTestPath(fixture->normal_root.data(), child, &path) ||
        CreateDirectoryW(path.data(), nullptr) == FALSE) {
      return false;
    }
  }
  return gc::SetProtectedFilesystemIsolatedRootForTest(
      fixture->extended_root.data(), fixture->extended_length);
}

bool RemoveTestTree(
    const wchar_t* root,
    std::size_t depth = 0U) noexcept {
  if (root == nullptr || root[0] == L'\0' || depth > 8U) return false;
  std::array<wchar_t, gc::kProtectedPathCharacters> pattern{};
  if (!AppendTestPath(root, L"*", &pattern)) return false;
  WIN32_FIND_DATAW found{};
  HANDLE search = FindFirstFileW(pattern.data(), &found);
  bool valid = search != INVALID_HANDLE_VALUE;
  if (valid) {
    do {
      if ((found.cFileName[0] == L'.' && found.cFileName[1] == L'\0') ||
          (found.cFileName[0] == L'.' && found.cFileName[1] == L'.' &&
           found.cFileName[2] == L'\0')) {
        continue;
      }
      std::array<wchar_t, gc::kProtectedPathCharacters> child{};
      if (!AppendTestPath(root, found.cFileName, &child)) {
        valid = false;
        break;
      }
      if ((found.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0U) {
        valid = RemoveTestTree(child.data(), depth + 1U) && valid;
      } else {
        SetFileAttributesW(child.data(), FILE_ATTRIBUTE_NORMAL);
        valid = DeleteFileW(child.data()) != FALSE && valid;
      }
    } while (FindNextFileW(search, &found) != FALSE);
    FindClose(search);
  }
  return RemoveDirectoryW(root) != FALSE && valid;
}

void RemoveIsolatedRecoveryFixture(
    IsolatedRecoveryFixture* fixture) noexcept {
  gc::ResetProtectedFilesystemIsolatedRootForTest();
  if (fixture == nullptr || fixture->normal_length == 0U) return;
  RemoveTestTree(fixture->normal_root.data());
  *fixture = IsolatedRecoveryFixture{};
}

bool TestPathExists(
    const IsolatedRecoveryFixture& fixture,
    const wchar_t* relative_path,
    bool directory) noexcept {
  std::array<wchar_t, gc::kProtectedPathCharacters> path{};
  if (!AppendTestPath(fixture.normal_root.data(), relative_path, &path)) {
    return false;
  }
  const DWORD attributes = GetFileAttributesW(path.data());
  return attributes != INVALID_FILE_ATTRIBUTES &&
      ((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0U) == directory;
}

bool CreateTestDirectory(
    const IsolatedRecoveryFixture& fixture,
    const wchar_t* relative_path) noexcept {
  std::array<wchar_t, gc::kProtectedPathCharacters> path{};
  return AppendTestPath(fixture.normal_root.data(), relative_path, &path) &&
      CreateDirectoryW(path.data(), nullptr) != FALSE;
}

bool WriteTestFile(
    const IsolatedRecoveryFixture& fixture,
    const wchar_t* relative_path,
    std::size_t length,
    std::uint8_t seed) noexcept {
  if (length > 2048U) return false;
  std::array<wchar_t, gc::kProtectedPathCharacters> path{};
  std::array<std::uint8_t, 2048U> bytes{};
  for (std::size_t index = 0U; index < length; ++index) {
    bytes[index] = static_cast<std::uint8_t>(seed + index);
  }
  if (!AppendTestPath(fixture.normal_root.data(), relative_path, &path)) {
    return false;
  }
  HANDLE file = CreateFileW(
      path.data(),
      GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ,
      nullptr,
      CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL,
      nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  DWORD written = 0U;
  const bool valid =
      (length == 0U ||
       (WriteFile(
            file,
            bytes.data(),
            static_cast<DWORD>(length),
            &written,
            nullptr) != FALSE &&
        written == length)) &&
      FlushFileBuffers(file) != FALSE;
  CloseHandle(file);
  return valid;
}

bool TestFileMatches(
    const IsolatedRecoveryFixture& fixture,
    const wchar_t* relative_path,
    std::size_t length,
    std::uint8_t seed) noexcept {
  if (length > 2048U) return false;
  std::array<wchar_t, gc::kProtectedPathCharacters> path{};
  std::array<std::uint8_t, 2048U> bytes{};
  if (!AppendTestPath(fixture.normal_root.data(), relative_path, &path)) {
    return false;
  }
  HANDLE file = CreateFileW(
      path.data(),
      GENERIC_READ,
      FILE_SHARE_READ,
      nullptr,
      OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL,
      nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  DWORD read = 0U;
  const bool valid =
      ReadFile(
          file,
          bytes.data(),
          static_cast<DWORD>(bytes.size()),
          &read,
          nullptr) != FALSE &&
      read == length;
  CloseHandle(file);
  if (!valid) return false;
  for (std::size_t index = 0U; index < length; ++index) {
    if (bytes[index] != static_cast<std::uint8_t>(seed + index)) return false;
  }
  return true;
}

enum class MoveCandidateShape : std::uint8_t {
  Empty = 0U,
  Partial = 1U,
  InconsistentFull = 2U,
  InvalidFull = 3U,
  OverCapacity = 4U,
};

bool CreateDirectoryMoveTree(
    const IsolatedRecoveryFixture& fixture,
    const wchar_t* source_component,
    MoveCandidateShape shape) noexcept {
  std::array<wchar_t, gc::kProtectedPathCharacters> source_relative{};
  std::array<wchar_t, gc::kProtectedPathCharacters> candidate_relative{};
  std::array<wchar_t, gc::kProtectedPathCharacters> prepared_relative{};
  if (source_component == nullptr ||
      !AppendTestPath(L"journal", source_component, &source_relative) ||
      !AppendTestPath(
          source_relative.data(), L"keyset.pending", &candidate_relative) ||
      !AppendTestPath(
          source_relative.data(),
          L"s00000000-prepared.gcjr",
          &prepared_relative) ||
      !CreateTestDirectory(fixture, source_relative.data()) ||
      !WriteTestFile(
          fixture,
          prepared_relative.data(),
          64U,
          0x31U) ||
      !CreateTestDirectory(fixture, candidate_relative.data())) {
    return false;
  }
  struct CandidateFile final {
    const wchar_t* name;
    std::size_t length;
    std::uint8_t seed;
  };
  constexpr std::array<CandidateFile, 6U> kFiles = {{
      {L"runtime-manifest.pk8", 17U, 0x41U},
      {L"runtime-manifest.spki", 12U, 0x51U},
      {L"admission-evidence.pk8", 23U, 0x61U},
      {L"admission-evidence.spki", 7U, 0x71U},
      {L"keyset-receipt.gckr", 31U, 0x81U},
      {L"unexpected.bin", 5U, 0x91U},
  }};
  std::size_t count = 0U;
  if (shape == MoveCandidateShape::Partial) count = 2U;
  if (shape == MoveCandidateShape::InconsistentFull ||
      shape == MoveCandidateShape::InvalidFull) count = 5U;
  if (shape == MoveCandidateShape::OverCapacity) count = 6U;
  for (std::size_t index = 0U; index < count; ++index) {
    const CandidateFile& specification = kFiles[index];
    const wchar_t* name = specification.name;
    if (shape == MoveCandidateShape::InvalidFull && index == count - 1U) {
      name = L"unexpected.bin";
    }
    std::array<wchar_t, gc::kProtectedPathCharacters> relative{};
    if (!AppendTestPath(candidate_relative.data(), name, &relative) ||
        !WriteTestFile(
            fixture, relative.data(), specification.length, specification.seed)) {
      return false;
    }
  }
  return true;
}

bool DirectoryMoveTreeMatches(
    const IsolatedRecoveryFixture& fixture,
    const wchar_t* parent,
    const wchar_t* component,
    MoveCandidateShape shape) noexcept {
  std::array<wchar_t, gc::kProtectedPathCharacters> root{};
  std::array<wchar_t, gc::kProtectedPathCharacters> prepared{};
  std::array<wchar_t, gc::kProtectedPathCharacters> candidate{};
  if (!AppendTestPath(parent, component, &root) ||
      !AppendTestPath(root.data(), L"s00000000-prepared.gcjr", &prepared) ||
      !AppendTestPath(root.data(), L"keyset.pending", &candidate) ||
      !TestPathExists(fixture, root.data(), true) ||
      !TestPathExists(fixture, candidate.data(), true) ||
      !TestFileMatches(fixture, prepared.data(), 64U, 0x31U)) {
    return false;
  }
  if (shape == MoveCandidateShape::Empty) return true;
  constexpr std::array<const wchar_t*, 5U> kNames = {
      L"runtime-manifest.pk8",
      L"runtime-manifest.spki",
      L"admission-evidence.pk8",
      L"admission-evidence.spki",
      L"keyset-receipt.gckr"};
  constexpr std::array<std::size_t, 5U> kLengths = {17U, 12U, 23U, 7U, 31U};
  constexpr std::array<std::uint8_t, 5U> kSeeds = {
      0x41U, 0x51U, 0x61U, 0x71U, 0x81U};
  const std::size_t count = shape == MoveCandidateShape::Partial ? 2U : 5U;
  for (std::size_t index = 0U; index < count; ++index) {
    std::array<wchar_t, gc::kProtectedPathCharacters> relative{};
    if (!AppendTestPath(candidate.data(), kNames[index], &relative) ||
        !TestFileMatches(
            fixture, relative.data(), kLengths[index], kSeeds[index])) {
      return false;
    }
  }
  return true;
}

template <std::size_t BodyBytes>
bool BuildPreparedPublication(
    const std::array<std::uint8_t, BodyBytes>& body,
    std::uint8_t opcode,
    std::uint16_t publication_sequence,
    gc::ProtectedRecoveryPublicationForTest* publication) noexcept {
  if (publication == nullptr) return false;
  constexpr std::array<std::uint8_t, 12U> kSid = {
      1U, 1U, 0U, 0U, 0U, 0U, 0U, 5U, 18U, 0U, 0U, 0U};
  gc::PreparedJournalInput input{};
  std::memcpy(input.operation_id.data(), body.data(), input.operation_id.size());
  input.opcode = opcode;
  input.operator_sid = kSid.data();
  input.operator_sid_length = static_cast<std::uint16_t>(kSid.size());
  input.body = body.data();
  input.body_length = static_cast<std::uint16_t>(body.size());
  std::memcpy(
      input.expected_state_sha256.data(), body.data() + 16U,
      input.expected_state_sha256.size());
  input.authenticated_binding.fill(0x5aU);
  input.creation_file_time = UINT64_C(0x01db5b629d340000);
  input.publication_sequence = publication_sequence;
  if (!gc::ComputeSha256(
          body.data(), body.size(), &input.body_sha256) ||
      !gc::ComputeStableOperationBinding(
          input.operator_sid,
          input.operator_sid_length,
          input.operation_id,
          input.opcode,
          input.schema,
          input.body,
          input.body_length,
          &input.stable_binding) ||
      !gc::EncodePreparedJournalRecord(input, &publication->record)) {
    return false;
  }
  *publication = gc::ProtectedRecoveryPublicationForTest{
      gc::ProtectedRecoveryPublicationKindForTest::Prepared,
      opcode,
      0U,
      true,
      input.operation_id,
      publication->record,
      {},
      {}};
  return true;
}

bool BuildFollowingPublication(
    gc::JournalRecordKind kind,
    std::uint8_t flags,
    const gc::ProtectedRecoveryPublicationForTest& prepared,
    const gc::ProtectedRecoveryPublicationForTest& prior,
    std::uint16_t publication_sequence,
    gc::ProtectedRecoveryPublicationKindForTest publication_kind,
    gc::ProtectedRecoveryPublicationForTest* publication) noexcept {
  if (publication == nullptr) return false;
  std::array<std::uint8_t, 432U> outcome{};
  std::size_t outcome_length = 0U;
  if (kind == gc::JournalRecordKind::Outcome ||
      kind == gc::JournalRecordKind::Committed) {
    const bool create = prepared.opcode ==
        static_cast<std::uint8_t>(gc::Opcode::CreateKeyset);
    WriteU16(outcome.data(), create ? 1U : 2U);
    WriteU16(outcome.data() + 2U, 1U);
    WriteU32(
        outcome.data() + 4U,
        create ? static_cast<std::uint32_t>(gc::kCreateKeysetResultBytes)
               : static_cast<std::uint32_t>(gc::kRevokeKeysetResultBytes));
    WriteU32(outcome.data() + 8U, create ? 1U : 2U);
    outcome[16] = 0x11U;
    outcome[48] = 0x22U;
    outcome[80] = 0x33U;
    outcome[112] = 0x44U;
    outcome_length = outcome.size();
  } else if (kind == gc::JournalRecordKind::Quarantined) {
    WriteU16(outcome.data(), 3U);
    WriteU16(outcome.data() + 2U, 1U);
    WriteU32(outcome.data() + 8U, 3U);
    outcome[16] = 0x11U;
    outcome[48] = 0x22U;
    outcome[80] = 0x33U;
    outcome_length = 112U;
  }
  gc::Byte32 authenticated_binding{};
  authenticated_binding.fill(0x5aU);
  gc::JournalRecord record{};
  if (!gc::EncodeFollowingJournalRecord(
          kind,
          flags,
          prepared.record,
          prior.record,
          flags == 0U && kind == gc::JournalRecordKind::Attempt
              ? &authenticated_binding
              : flags == 2U ? &authenticated_binding : nullptr,
          outcome_length == 0U ? nullptr : outcome.data(),
          outcome_length,
          UINT64_C(0x01db5b629d340000) + publication_sequence,
          publication_sequence,
          &record)) {
    return false;
  }
  *publication = gc::ProtectedRecoveryPublicationForTest{
      publication_kind,
      prepared.opcode,
      0U,
      true,
      prepared.operation_id,
      record,
      {},
      {}};
  return true;
}

int TestCanonicalStateCalculator() noexcept {
  int failures = 0;
  gc::ProtectedOperationsState state{};
  state.filesystem.ready = true;
  std::array<std::uint8_t,
             gc::kMaximumStateProjectionBytesForTest> projection{};
  std::size_t projection_length = 99U;
  gc::Byte32 digest{};
  gc::Byte32 reference{};
  if (!gc::CalculateProtectedStateForTest(
          state,
          nullptr,
          nullptr,
          nullptr,
          &projection,
          &projection_length,
          &digest) ||
      projection_length != gc::kStateHeaderBytes ||
      ReadU16(projection.data()) != 1U ||
      ReadU32(projection.data() + 156U) != gc::kMaximumOperationIds ||
      ReadU32(projection.data() + 160U) != gc::kMaximumBurnedGenerations ||
      ReadU32(projection.data() + 164U) != gc::kMaximumResidues ||
      !AllZero(projection.data() + 168U, 56U) ||
      !HashCanonicalProjection(projection, projection_length, &reference) ||
      digest != reference) {
    CanonicalFailure(&failures, "protected_operations: empty canonical state\n");
  }

  // Unordered tables serialize canonically as generation, operation ID, then
  // residue (operation ID, ordinal), with exact header counts and row widths.
  state.generations[0] = GenerationProjection(3U, 4U, 3U);
  state.generations[7] = GenerationProjection(1U, 4U, 1U);
  state.operations[0] = OperationProjection(
      0x30U, gc::Opcode::CreateKeyset, 1U, 3U);
  state.operations[11] = OperationProjection(
      0x10U, gc::Opcode::CreateKeyset, 1U, 1U);
  state.residues[0] = ResidueProjection(0x30U, 2U, 1U, 2U);
  state.residues[13] = ResidueProjection(0x10U, 1U, 3U, 1U);
  if (!gc::CalculateProtectedStateForTest(
          state,
          nullptr,
          nullptr,
          nullptr,
          &projection,
          &projection_length,
          &digest) ||
      projection_length !=
          gc::kStateHeaderBytes + 2U * gc::kGenerationEntryBytes +
              2U * gc::kOperationEntryBytes + 2U * gc::kResidueEntryBytes ||
      ReadU32(projection.data() + 168U) != 2U ||
      ReadU32(projection.data() + 172U) != 2U ||
      ReadU32(projection.data() + 176U) != 0U ||
      ReadU32(projection.data() + 180U) != 2U ||
      ReadU32(projection.data() + 184U) != 2U ||
      ReadU64(projection.data() + 200U) != 3U ||
      ReadU64(projection.data() + 208U) != 0U ||
      ReadU64(projection.data() + gc::kStateHeaderBytes) != 1U ||
      ReadU64(
          projection.data() + gc::kStateHeaderBytes +
          gc::kGenerationEntryBytes) != 3U ||
      projection[gc::kStateHeaderBytes + 2U * gc::kGenerationEntryBytes] !=
          0x10U ||
      projection[gc::kStateHeaderBytes + 2U * gc::kGenerationEntryBytes +
                 gc::kOperationEntryBytes] != 0x30U ||
      projection[gc::kStateHeaderBytes + 2U * gc::kGenerationEntryBytes +
                 2U * gc::kOperationEntryBytes] != 0x10U ||
      !HashCanonicalProjection(projection, projection_length, &reference) ||
      digest != reference) {
    CanonicalFailure(&failures, "protected_operations: canonical sorting\n");
  }

  // Generic extra projections cover committed CREATE, quarantine, and revoke
  // without a single-generation serializer fork.
  state = gc::ProtectedOperationsState{};
  state.filesystem.ready = true;
  constexpr std::array<std::uint8_t, 3U> kLifecycles = {1U, 5U, 3U};
  for (const std::uint8_t lifecycle : kLifecycles) {
    const auto generation = GenerationProjection(1U, lifecycle, lifecycle);
    const auto operation = OperationProjection(
        lifecycle,
        lifecycle == 3U ? gc::Opcode::RevokeLocalKeyset
                        : gc::Opcode::CreateKeyset,
        lifecycle == 5U ? 2U : 1U,
        1U);
    if (!gc::CalculateProtectedStateForTest(
            state,
            &generation,
            &operation,
            nullptr,
            &projection,
            &projection_length,
            &digest) ||
        projection_length != gc::kStateHeaderBytes +
                                 gc::kGenerationEntryBytes +
                                 gc::kOperationEntryBytes ||
        ReadU32(projection.data() + 168U) != 1U ||
        ReadU32(projection.data() + 176U) != (lifecycle == 5U ? 1U : 0U) ||
        ReadU32(projection.data() + 184U) != 1U ||
        ReadU32(projection.data() + 188U) != (lifecycle == 5U ? 0U : 1U) ||
        ReadU32(projection.data() + 192U) != (lifecycle == 3U ? 1U : 0U) ||
        ReadU64(projection.data() + 216U) != (lifecycle == 1U ? 1U : 0U) ||
        std::memcmp(
            projection.data() + gc::kStateHeaderBytes,
            generation.bytes.data(),
            generation.bytes.size()) != 0 ||
        std::memcmp(
            projection.data() + gc::kStateHeaderBytes +
                gc::kGenerationEntryBytes,
            operation.bytes.data(),
            operation.bytes.size()) != 0 ||
        (lifecycle != 5U &&
         (AllZero(generation.bytes.data() + 64U, 120U) ||
          AllZero(generation.bytes.data() + 184U, 160U))) ||
        (lifecycle == 5U &&
         (AllZero(generation.bytes.data() + 40U, 24U) ||
          AllZero(generation.bytes.data() + 416U, 32U)))) {
      CanonicalFailure(&failures, "protected_operations: generic lifecycle calculator\n");
    }
  }

  for (const std::uint16_t invalid_sequence : {std::uint16_t{0U},
                                               std::uint16_t{865U}}) {
    const auto invalid_residue =
        ResidueProjection(1U, 0U, 1U, invalid_sequence);
    projection.fill(0xa5U);
    projection_length = projection.size();
    digest.fill(0xa5U);
    if (gc::CalculateProtectedStateForTest(
            state,
            nullptr,
            nullptr,
            &invalid_residue,
            &projection,
            &projection_length,
            &digest) ||
        projection_length != 0U ||
        !AllZero(projection.data(), projection.size()) ||
        !AllZero(digest.data(), digest.size())) {
      CanonicalFailure(
          &failures,
          "protected_operations: residue publication sequence range\n");
    }
  }
  const auto maximum_sequence_residue =
      ResidueProjection(1U, 0U, 1U, 864U);
  if (!gc::CalculateProtectedStateForTest(
          state,
          nullptr,
          nullptr,
          &maximum_sequence_residue,
          &projection,
          &projection_length,
          &digest) ||
      projection_length != gc::kStateHeaderBytes + gc::kResidueEntryBytes ||
      ReadU16(projection.data() + gc::kStateHeaderBytes + 18U) != 864U) {
    CanonicalFailure(
        &failures,
        "protected_operations: residue publication sequence 864\n");
  }

  // Fill every fixed table to its exact boundary and prove the maximum
  // 45,280-byte body / 45,335-byte domain input and fail-closed over-cap extras.
  state = gc::ProtectedOperationsState{};
  state.filesystem.ready = true;
  for (std::size_t index = 0U; index < state.generations.size(); ++index) {
    state.generations[index] = GenerationProjection(
        static_cast<std::uint64_t>(index + 1U),
        4U,
        static_cast<std::uint8_t>(index + 1U));
  }
  for (std::size_t index = 0U; index < state.operations.size(); ++index) {
    state.operations[index] = OperationProjection(
        static_cast<std::uint16_t>(index + 1U),
        gc::Opcode::CreateKeyset,
        1U,
        static_cast<std::uint64_t>((index % state.generations.size()) + 1U));
  }
  for (std::size_t index = 0U; index < state.residues.size(); ++index) {
    state.residues[index] = ResidueProjection(
        static_cast<std::uint16_t>(index + 1U),
        static_cast<std::uint8_t>(index % 8U),
        static_cast<std::uint8_t>((index % 3U) + 1U),
        static_cast<std::uint16_t>(index + 1U));
  }
  if (!gc::CalculateProtectedStateForTest(
          state,
          nullptr,
          nullptr,
          nullptr,
          &projection,
          &projection_length,
          &digest) ||
      projection_length != gc::kMaximumStateProjectionBytesForTest ||
      !HashCanonicalProjection(projection, projection_length, &reference) ||
      digest != reference ||
      ReadU32(projection.data() + 168U) != gc::kMaximumOperationIds ||
      ReadU32(projection.data() + 180U) != gc::kMaximumResidues ||
      ReadU32(projection.data() + 184U) != gc::kMaximumBurnedGenerations) {
    CanonicalFailure(&failures, "protected_operations: maximum canonical body\n");
  }
  const auto over_generation = GenerationProjection(17U, 4U, 17U);
  const auto over_operation = OperationProjection(
      257U, gc::Opcode::CreateKeyset, 1U, 1U);
  const auto over_residue = ResidueProjection(257U, 0U, 1U, 257U);
  for (const int kind : {0, 1, 2}) {
    projection.fill(0xa5U);
    projection_length = projection.size();
    digest.fill(0xa5U);
    const bool accepted = gc::CalculateProtectedStateForTest(
        state,
        kind == 0 ? &over_generation : nullptr,
        kind == 1 ? &over_operation : nullptr,
        kind == 2 ? &over_residue : nullptr,
        &projection,
        &projection_length,
        &digest);
    if (accepted || projection_length != 0U ||
        !AllZero(projection.data(), projection.size()) ||
        !AllZero(digest.data(), digest.size())) {
      CanonicalFailure(&failures, "protected_operations: over-cap projection\n");
    }
  }

  // Duplicate and inactive-nonzero table rows are never silently canonicalized.
  state = gc::ProtectedOperationsState{};
  state.filesystem.ready = true;
  state.operations[0] = OperationProjection(
      7U, gc::Opcode::CreateKeyset, 1U, 1U);
  state.operations[1] = state.operations[0];
  if (gc::CalculateProtectedStateForTest(
          state,
          nullptr,
          nullptr,
          nullptr,
          &projection,
          &projection_length,
          &digest)) {
    CanonicalFailure(&failures, "protected_operations: duplicate projection key\n");
  }
  state = gc::ProtectedOperationsState{};
  state.filesystem.ready = true;
  state.operations[0].bytes[0] = 1U;
  if (gc::CalculateProtectedStateForTest(
          state,
          nullptr,
          nullptr,
          nullptr,
          &projection,
          &projection_length,
          &digest)) {
    CanonicalFailure(&failures, "protected_operations: inactive nonzero projection\n");
  }
  return failures;
}

int TestRecoveryActionSelector() noexcept {
  using Action = gc::ProtectedRecoveryTestAction;
  using Effect = gc::ProtectedRecoveryTestEffect;
  using Opcode = gc::ProtectedRecoveryTestOpcode;
  using Phase = gc::ProtectedRecoveryTestPhase;
  int failures = 0;
  constexpr std::array<Opcode, 2U> kOpcodes = {
      Opcode::Create, Opcode::Revoke};
  constexpr std::array<Phase, 4U> kPhases = {
      Phase::PreparedOnly,
      Phase::Attempted,
      Phase::OutcomeOnly,
      Phase::Terminal};
  constexpr std::array<Effect, 7U> kEffects = {
      Effect::Absent,
      Effect::CreateEmpty,
      Effect::BoundedPartialPending,
      Effect::ExactPending,
      Effect::ExactFinal,
      Effect::FinalResidueSourceAbsent,
      Effect::InvalidOrConflicting};
  constexpr std::array<std::uint32_t, 5U> kAttemptCounts = {
      0U, 1U, 15U, gc::kMaximumJournalAttempts,
      gc::kMaximumJournalAttempts + 1U};

  const auto invalid_combination = [](
      Opcode opcode,
      Phase phase,
      Effect effect,
      std::uint32_t attempts) noexcept {
    return attempts > gc::kMaximumJournalAttempts ||
           ((phase == Phase::PreparedOnly) != (attempts == 0U)) ||
           (opcode == Opcode::Create &&
            effect == Effect::FinalResidueSourceAbsent) ||
           (opcode == Opcode::Revoke && effect == Effect::CreateEmpty);
  };
  const auto expected_action = [](
      Opcode opcode,
      Phase phase,
      Effect effect,
      std::uint32_t attempts) noexcept {
    if (phase == Phase::Terminal) return Action::StableTerminal;
    if (attempts >= gc::kMaximumJournalAttempts ||
        effect == Effect::InvalidOrConflicting) {
      return Action::RejectPreserve;
    }
    if (phase == Phase::OutcomeOnly) {
      return effect == Effect::ExactFinal
          ? Action::AppendAttemptThenCommitExistingOutcome
          : Action::RejectPreserve;
    }
    if (opcode == Opcode::Create) {
      if (phase == Phase::PreparedOnly) {
        if (effect == Effect::Absent) {
          return Action::EnsureEmptyCreateThenEntropy;
        }
        return effect == Effect::CreateEmpty
            ? Action::AppendAttemptThenEntropy
            : Action::RejectPreserve;
      }
      if (effect == Effect::CreateEmpty ||
          effect == Effect::BoundedPartialPending) {
        return Action::AppendAttemptThenQuarantineReason1;
      }
      if (effect == Effect::ExactPending) {
        return Action::AppendAttemptThenPromoteAndFinish;
      }
      return effect == Effect::ExactFinal
          ? Action::AppendAttemptThenFinishFinal
          : Action::RejectPreserve;
    }
    if (phase == Phase::PreparedOnly) {
      return effect == Effect::Absent
          ? Action::AppendAttemptThenRegenerateRevoke
          : Action::RejectPreserve;
    }
    if (effect == Effect::Absent ||
        effect == Effect::FinalResidueSourceAbsent) {
      return Action::AppendAttemptThenRegenerateRevoke;
    }
    if (effect == Effect::BoundedPartialPending) {
      return Action::MoveRevokeResidueThenRegenerate;
    }
    if (effect == Effect::ExactPending) {
      return Action::AppendAttemptThenPromoteAndFinish;
    }
    return effect == Effect::ExactFinal
        ? Action::AppendAttemptThenFinishFinal
        : Action::RejectPreserve;
  };

  for (const Opcode opcode : kOpcodes) {
    for (const Phase phase : kPhases) {
      for (const Effect effect : kEffects) {
        for (const std::uint32_t attempts : kAttemptCounts) {
          Action action = Action::StableTerminal;
          const bool selected = gc::SelectProtectedRecoveryActionForTest(
              opcode, phase, effect, attempts, &action);
          if (invalid_combination(opcode, phase, effect, attempts)) {
            if (selected || action != Action::StableTerminal) {
              CanonicalFailure(
                  &failures,
                  "protected_operations: invalid recovery selector mutated\n");
            }
          } else if (!selected ||
                     action != expected_action(
                                   opcode, phase, effect, attempts)) {
            CanonicalFailure(
                &failures,
                "protected_operations: recovery selector matrix\n");
          }
        }
      }
    }
  }

  constexpr std::array<Opcode, 1U> kUnknownOpcode = {
      static_cast<Opcode>(0xffU)};
  constexpr std::array<Phase, 1U> kUnknownPhase = {
      static_cast<Phase>(0xffU)};
  constexpr std::array<Effect, 1U> kUnknownEffect = {
      static_cast<Effect>(0xffU)};
  Action sentinel = Action::StableTerminal;
  if (gc::SelectProtectedRecoveryActionForTest(
          kUnknownOpcode[0],
          Phase::PreparedOnly,
          Effect::Absent,
          0U,
          &sentinel) ||
      sentinel != Action::StableTerminal ||
      gc::SelectProtectedRecoveryActionForTest(
          Opcode::Create,
          kUnknownPhase[0],
          Effect::Absent,
          0U,
          &sentinel) ||
      sentinel != Action::StableTerminal ||
      gc::SelectProtectedRecoveryActionForTest(
          Opcode::Create,
          Phase::PreparedOnly,
          kUnknownEffect[0],
          0U,
          &sentinel) ||
      sentinel != Action::StableTerminal ||
      gc::SelectProtectedRecoveryActionForTest(
          Opcode::Create,
          Phase::PreparedOnly,
          Effect::Absent,
          0U,
          nullptr)) {
    CanonicalFailure(
        &failures,
        "protected_operations: invalid recovery selector boundary\n");
  }
  return failures;
}

int TestPublicationInventoryAndResidueBinding() noexcept {
  int failures = 0;
  std::uint16_t next = 0xa5a5U;
  if (!gc::ValidateProtectedPublicationInventoryForTest(nullptr, 0U, &next) ||
      next != 1U) {
    CanonicalFailure(
        &failures,
        "protected_operations: empty publication inventory\n");
  }
  constexpr std::array<std::uint16_t, 2U> kUnsorted = {2U, 1U};
  next = 0xa5a5U;
  if (!gc::ValidateProtectedPublicationInventoryForTest(
          kUnsorted.data(), kUnsorted.size(), &next) ||
      next != 3U) {
    CanonicalFailure(
        &failures,
        "protected_operations: unsorted contiguous publication inventory\n");
  }
  std::array<std::uint16_t, gc::kMaximumPublicationSequence> maximum{};
  for (std::size_t index = 0U; index < maximum.size(); ++index) {
    maximum[index] = static_cast<std::uint16_t>(index + 1U);
  }
  next = 0xa5a5U;
  if (!gc::ValidateProtectedPublicationInventoryForTest(
          maximum.data(), maximum.size(), &next) ||
      next != gc::kMaximumPublicationSequence + 1U) {
    CanonicalFailure(
        &failures,
        "protected_operations: exhausted publication inventory sentinel\n");
  }
  constexpr std::array<std::array<std::uint16_t, 2U>, 4U> kInvalid = {{
      {0U, 1U},
      {1U, 865U},
      {1U, 1U},
      {1U, 3U},
  }};
  for (const auto& sequences : kInvalid) {
    next = 0xa5a5U;
    if (gc::ValidateProtectedPublicationInventoryForTest(
            sequences.data(), sequences.size(), &next) ||
        next != 0xa5a5U) {
      CanonicalFailure(
          &failures,
          "protected_operations: invalid publication inventory boundary\n");
    }
  }
  next = 0xa5a5U;
  if (gc::ValidateProtectedPublicationInventoryForTest(nullptr, 1U, &next) ||
      next != 0xa5a5U ||
      gc::ValidateProtectedPublicationInventoryForTest(
          kUnsorted.data(), kUnsorted.size(), nullptr)) {
    CanonicalFailure(
        &failures,
        "protected_operations: null publication inventory boundary\n");
  }

  const auto bootstrap = ResidueProjection(1U, 0U, 1U, 1U);
  constexpr wchar_t kBootstrap[] =
      L"residue-op-01000000000000000000000000000000-r00-p0001-bootstrap";
  const auto journal = ResidueProjection(1U, 7U, 2U, 864U);
  constexpr wchar_t kJournal[] =
      L"residue-op-01000000000000000000000000000000-r07-p0360-journal";
  const auto revoke = ResidueProjection(1U, 3U, 3U, 42U);
  constexpr wchar_t kRevoke[] =
      L"residue-op-01000000000000000000000000000000-r03-p002a-revoke";
  if (!gc::ValidateProtectedResidueBindingForTest(
          kBootstrap, std::size(kBootstrap) - 1U, bootstrap) ||
      !gc::ValidateProtectedResidueBindingForTest(
          kJournal, std::size(kJournal) - 1U, journal) ||
      !gc::ValidateProtectedResidueBindingForTest(
          kRevoke, std::size(kRevoke) - 1U, revoke)) {
    CanonicalFailure(
        &failures,
        "protected_operations: exact residue filename binding\n");
  }
  constexpr std::array<const wchar_t*, 7U> kInvalidComponents = {
      L"residue-op-01000000000000000000000000000000-r00-p0000-bootstrap",
      L"residue-op-01000000000000000000000000000000-r00-p0361-bootstrap",
      L"residue-op-01000000000000000000000000000000-r00-p000A-bootstrap",
      L"residue-op-01000000000000000000000000000000-r000-p0001-bootstrap",
      L"residue-op-01000000000000000000000000000000-r00-p0001-unknown",
      L"residue-op-02000000000000000000000000000000-r00-p0001-bootstrap",
      L"residue-op-01000000000000000000000000000000-r01-p0001-bootstrap",
  };
  for (const wchar_t* component : kInvalidComponents) {
    std::size_t length = 0U;
    while (component[length] != L'\0') ++length;
    if (gc::ValidateProtectedResidueBindingForTest(
            component, length, bootstrap)) {
      CanonicalFailure(
          &failures,
          "protected_operations: invalid residue filename binding\n");
    }
  }
  if (gc::ValidateProtectedResidueBindingForTest(nullptr, 1U, bootstrap) ||
      gc::ValidateProtectedResidueBindingForTest(kBootstrap, 0U, bootstrap)) {
    CanonicalFailure(
        &failures,
        "protected_operations: null residue filename boundary\n");
  }
  return failures;
}

int TestRecoveryPublicationAuthorityAndLifecycle() noexcept {
  int failures = 0;
  gc::Byte32 state_hash{};
  state_hash.fill(0x31U);
  const auto create_body = CreateBody(state_hash, 1U, 0U);
  std::array<gc::ProtectedRecoveryPublicationForTest, 20U> create{};
  if (!BuildPreparedPublication(
          create_body,
          static_cast<std::uint8_t>(gc::Opcode::CreateKeyset),
          1U,
          &create[0]) ||
      !BuildFollowingPublication(
          gc::JournalRecordKind::Attempt,
          0U,
          create[0],
          create[0],
          2U,
          gc::ProtectedRecoveryPublicationKindForTest::AttemptInitial,
          &create[1]) ||
      !BuildFollowingPublication(
          gc::JournalRecordKind::Outcome,
          0U,
          create[0],
          create[1],
          3U,
          gc::ProtectedRecoveryPublicationKindForTest::Outcome,
          &create[2]) ||
      !BuildFollowingPublication(
          gc::JournalRecordKind::Committed,
          0U,
          create[0],
          create[2],
          4U,
          gc::ProtectedRecoveryPublicationKindForTest::Committed,
          &create[3]) ||
      !BuildFollowingPublication(
          gc::JournalRecordKind::Attempt,
          2U,
          create[0],
          create[3],
          5U,
          gc::ProtectedRecoveryPublicationKindForTest::AttemptReplay,
          &create[4])) {
    CanonicalFailure(
        &failures,
        "protected_operations: publication fixture construction\n");
    return failures;
  }

  for (const std::size_t count : {1U, 2U, 3U, 4U, 5U}) {
    if (!gc::ValidateProtectedRecoveryPublicationsForTest(
            create.data(), count)) {
      CanonicalFailure(
          &failures,
          "protected_operations: valid publication lifecycle prefix\n");
    }
  }

  auto invalid = create;
  invalid[0].operation_id[0] ^= 0x80U;
  if (gc::ValidateProtectedRecoveryPublicationsForTest(invalid.data(), 1U)) {
    CanonicalFailure(
        &failures,
        "protected_operations: record operation authority mismatch\n");
  }
  invalid = create;
  invalid[0].opcode = static_cast<std::uint8_t>(gc::Opcode::RevokeLocalKeyset);
  if (gc::ValidateProtectedRecoveryPublicationsForTest(invalid.data(), 1U)) {
    CanonicalFailure(
        &failures,
        "protected_operations: record opcode authority mismatch\n");
  }
  invalid = create;
  invalid[1].kind = gc::ProtectedRecoveryPublicationKindForTest::AttemptRecovery;
  if (gc::ValidateProtectedRecoveryPublicationsForTest(invalid.data(), 2U)) {
    CanonicalFailure(
        &failures,
        "protected_operations: record attempt-kind authority mismatch\n");
  }
  invalid = create;
  invalid[1].record_present = false;
  if (gc::ValidateProtectedRecoveryPublicationsForTest(invalid.data(), 2U)) {
    CanonicalFailure(
        &failures,
        "protected_operations: record presence authority mismatch\n");
  }
  invalid = create;
  invalid[1] = create[2];
  if (gc::ValidateProtectedRecoveryPublicationsForTest(invalid.data(), 2U)) {
    CanonicalFailure(
        &failures,
        "protected_operations: publication chronology gap\n");
  }
  invalid = create;
  invalid[1] = create[0];
  if (gc::ValidateProtectedRecoveryPublicationsForTest(invalid.data(), 2U)) {
    CanonicalFailure(
        &failures,
        "protected_operations: concurrent prepared owner\n");
  }
  if (gc::ValidateProtectedRecoveryPublicationsForTest(nullptr, 1U) ||
      gc::ValidateProtectedRecoveryPublicationsForTest(
          create.data(), gc::kMaximumPublicationSequence + 1U)) {
    CanonicalFailure(
        &failures,
        "protected_operations: publication pointer and cap boundary\n");
  }

  std::array<gc::ProtectedRecoveryPublicationForTest, 3U> quarantine{};
  quarantine[0] = create[0];
  quarantine[1] = create[1];
  if (!BuildFollowingPublication(
          gc::JournalRecordKind::Quarantined,
          0U,
          quarantine[0],
          quarantine[1],
          3U,
          gc::ProtectedRecoveryPublicationKindForTest::Quarantined,
          &quarantine[2]) ||
      !gc::ValidateProtectedRecoveryPublicationsForTest(
          quarantine.data(), quarantine.size())) {
    CanonicalFailure(
        &failures,
        "protected_operations: valid create quarantine lifecycle\n");
  }

  const auto revoke_body = RevokeBody(state_hash, 1U, 1U);
  std::array<gc::ProtectedRecoveryPublicationForTest, 3U> revoke{};
  if (!BuildPreparedPublication(
          revoke_body,
          static_cast<std::uint8_t>(gc::Opcode::RevokeLocalKeyset),
          1U,
          &revoke[0]) ||
      !BuildFollowingPublication(
          gc::JournalRecordKind::Attempt,
          0U,
          revoke[0],
          revoke[0],
          2U,
          gc::ProtectedRecoveryPublicationKindForTest::AttemptInitial,
          &revoke[1]) ||
      !BuildFollowingPublication(
          gc::JournalRecordKind::Quarantined,
          0U,
          revoke[0],
          revoke[1],
          3U,
          gc::ProtectedRecoveryPublicationKindForTest::Quarantined,
          &revoke[2]) ||
      gc::ValidateProtectedRecoveryPublicationsForTest(
          revoke.data(), revoke.size())) {
    CanonicalFailure(
        &failures,
        "protected_operations: revoke cannot quarantine\n");
  }

  std::array<gc::ProtectedRecoveryPublicationForTest,
             gc::kMaximumJournalAttempts + 2U> attempts{};
  attempts[0] = create[0];
  attempts[1] = create[1];
  bool attempt_fixture_valid = true;
  for (std::uint32_t attempt = 1U;
       attempt < gc::kMaximumJournalAttempts;
       ++attempt) {
    attempt_fixture_valid = attempt_fixture_valid && BuildFollowingPublication(
        gc::JournalRecordKind::Attempt,
        1U,
        attempts[0],
        attempts[attempt],
        static_cast<std::uint16_t>(attempt + 2U),
        gc::ProtectedRecoveryPublicationKindForTest::AttemptRecovery,
        &attempts[attempt + 1U]);
  }
  if (!attempt_fixture_valid ||
      !gc::ValidateProtectedRecoveryPublicationsForTest(
          attempts.data(), gc::kMaximumJournalAttempts + 1U)) {
    CanonicalFailure(
        &failures,
        "protected_operations: exact maximum attempt chronology\n");
  }
  if (!BuildFollowingPublication(
          gc::JournalRecordKind::Attempt,
          1U,
          attempts[0],
          attempts[gc::kMaximumJournalAttempts],
          static_cast<std::uint16_t>(gc::kMaximumJournalAttempts + 2U),
          gc::ProtectedRecoveryPublicationKindForTest::AttemptRecovery,
          &attempts[gc::kMaximumJournalAttempts + 1U]) ||
      gc::ValidateProtectedRecoveryPublicationsForTest(
          attempts.data(), attempts.size())) {
    CanonicalFailure(
        &failures,
        "protected_operations: attempt cap fail closed\n");
  }

  gc::ProtectedRecoveryPublicationForTest bootstrap{};
  bootstrap.kind =
      gc::ProtectedRecoveryPublicationKindForTest::BootstrapResidue;
  bootstrap.operation_id.fill(0U);
  bootstrap.operation_id[0] = 0x71U;
  bootstrap.residue_ordinal = 0U;
  bootstrap.residue = ResidueProjection(0x71U, 0U, 1U, 1U);
  bootstrap.bootstrap_operation =
      OperationProjection(0x71U, gc::Opcode::CreateKeyset, 3U, 1U);
  if (!gc::ValidateProtectedRecoveryPublicationsForTest(&bootstrap, 1U)) {
    CanonicalFailure(
        &failures,
        "protected_operations: bootstrap residue authority\n");
  }
  auto bad_bootstrap = bootstrap;
  bad_bootstrap.bootstrap_operation.bytes[17] = 1U;
  if (gc::ValidateProtectedRecoveryPublicationsForTest(&bad_bootstrap, 1U)) {
    CanonicalFailure(
        &failures,
        "protected_operations: bootstrap operation binding\n");
  }
  bad_bootstrap = bootstrap;
  bad_bootstrap.residue.bytes[18] = 2U;
  if (gc::ValidateProtectedRecoveryPublicationsForTest(&bad_bootstrap, 1U)) {
    CanonicalFailure(
        &failures,
        "protected_operations: residue publication binding\n");
  }
  return failures;
}

int TestRecoveryFilesystemDuplication() noexcept {
  int failures = 0;
  gc::ProtectedFilesystemState source{};
  HANDLE* const handles[] = {
      &source.state_root,
      &source.journal,
      &source.keysets,
      &source.controls,
      &source.quarantine,
      &source.recovery_stop_event,
  };
  for (HANDLE* handle : handles) {
    *handle = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (*handle == nullptr) {
      CanonicalFailure(
          &failures,
          "protected_operations: duplicate fixture handle creation\n");
      for (HANDLE* cleanup : handles) {
        if (*cleanup != nullptr) CloseHandle(*cleanup);
        *cleanup = nullptr;
      }
      return failures;
    }
  }
  source.ready = true;
  source.recovery_deadline_ms = UINT64_C(0x1122334455667788);
  source.security_descriptor_length = 1U;
  source.security_descriptor[0] = 0xa5U;
  source.security_projection[0] = 0x5aU;

  DWORD baseline_handles = 0U;
  if (GetProcessHandleCount(GetCurrentProcess(), &baseline_handles) == FALSE) {
    CanonicalFailure(
        &failures,
        "protected_operations: duplicate baseline handle count\n");
  }
  for (std::uint32_t fail_on_call = 1U; fail_on_call <= 6U;
       ++fail_on_call) {
    gc::ProtectedFilesystemState duplicate{};
    gc::SetProtectedRecoveryDuplicateFailureForTest(fail_on_call);
    if (gc::DuplicateProtectedRecoveryFilesystemForTest(
            source, &duplicate) ||
        gc::ProtectedRecoveryDuplicateCallCountForTest() != fail_on_call) {
      CanonicalFailure(
          &failures,
          "protected_operations: duplicate failure cutpoint\n");
    }
    gc::CloseProtectedRecoveryFilesystemForTest(&duplicate);
    if (!AllZero(
            reinterpret_cast<const std::uint8_t*>(&duplicate),
            sizeof(duplicate))) {
      CanonicalFailure(
          &failures,
          "protected_operations: partial duplicate cleanup wipe\n");
    }
    for (HANDLE* original : handles) {
      if (WaitForSingleObject(*original, 0U) != WAIT_TIMEOUT) {
        CanonicalFailure(
            &failures,
            "protected_operations: duplicate failure closed original\n");
      }
    }
    DWORD current_handles = 0U;
    if (GetProcessHandleCount(GetCurrentProcess(), &current_handles) == FALSE ||
        current_handles != baseline_handles) {
      CanonicalFailure(
          &failures,
          "protected_operations: duplicate failure leaked handle\n");
    }
  }

  for (std::size_t iteration = 0U; iteration < 64U; ++iteration) {
    gc::SetProtectedRecoveryDuplicateFailureForTest(0U);
    gc::ProtectedFilesystemState duplicate{};
    if (!gc::DuplicateProtectedRecoveryFilesystemForTest(
            source, &duplicate) ||
        gc::ProtectedRecoveryDuplicateCallCountForTest() != 6U ||
        !duplicate.ready ||
        duplicate.recovery_deadline_ms != source.recovery_deadline_ms ||
        duplicate.recovery_stop_event == source.recovery_stop_event ||
        duplicate.journal == source.journal) {
      CanonicalFailure(
          &failures,
          "protected_operations: duplicate success contract\n");
    } else {
      SetEvent(source.journal);
      SetEvent(source.recovery_stop_event);
      if (WaitForSingleObject(duplicate.journal, 0U) != WAIT_OBJECT_0 ||
          WaitForSingleObject(duplicate.recovery_stop_event, 0U) !=
              WAIT_OBJECT_0) {
        CanonicalFailure(
            &failures,
            "protected_operations: duplicate shared object lifetime\n");
      }
      ResetEvent(source.journal);
      ResetEvent(source.recovery_stop_event);
    }
    gc::CloseProtectedRecoveryFilesystemForTest(&duplicate);
  }
  DWORD final_handles = 0U;
  if (GetProcessHandleCount(GetCurrentProcess(), &final_handles) == FALSE ||
      final_handles != baseline_handles) {
    DiagnosticCount(
        "protected_operations: duplicate baseline handles ",
        baseline_handles);
    DiagnosticCount(
        "protected_operations: duplicate final handles ",
        final_handles);
    CanonicalFailure(
        &failures,
        "protected_operations: repeated duplicate handle stability\n");
  }
  for (HANDLE* handle : handles) {
    CloseHandle(*handle);
    *handle = nullptr;
  }
  return failures;
}

int TestIsolatedEmptyRecoveryStartup() noexcept {
  int failures = 0;
  IsolatedRecoveryFixture fixture{};
  if (!CreateIsolatedRecoveryFixture(&fixture)) {
    CanonicalFailure(
        &failures,
        "protected_operations: isolated fixture creation\n");
    RemoveIsolatedRecoveryFixture(&fixture);
    return failures;
  }
  gc::ResetProtectedRecoveryEvidenceForTest();
  gc::ProtectedOperationsState state{};
  constexpr wchar_t kDummyVolumeRoot[] = L"\\\\?\\C:\\";
  const bool initialized = gc::InitializeProtectedOperations(
      kDummyVolumeRoot,
      std::size(kDummyVolumeRoot) - 1U,
      &state);
  const gc::ProtectedRecoveryEvidenceForTest* evidence =
      gc::ProtectedRecoveryEvidenceViewForTest();
  if (!initialized || !state.ready || state.operation_id_count != 0U ||
      state.residue_count != 0U || state.next_publication_sequence != 1U ||
      evidence == nullptr || evidence->source_read_count != 0U ||
      evidence->residue_payload_read_count != 0U ||
      evidence->source_mutation_count != 0U ||
      evidence->phase_b_mutation_count != 0U ||
      evidence->canonical_replay_count != 2U ||
      evidence->publication_count != 0U || evidence->operation_count != 0U ||
      evidence->next_publication_sequence != 1U ||
      evidence->active_operation_present || evidence->nonterminal_present ||
      AllZero(
          evidence->canonical_state_sha256.data(),
          evidence->canonical_state_sha256.size()) ||
      AllZero(
          evidence->physical_snapshot_sha256.data(),
          evidence->physical_snapshot_sha256.size())) {
    CanonicalFailure(
        &failures,
        "protected_operations: isolated empty recovery startup\n");
  }
  gc::CloseProtectedOperations(&state);
  RemoveIsolatedRecoveryFixture(&fixture);
  return failures;
}

int TestIsolatedCommittedRecoveryReplay() noexcept {
  int failures = 0;
  IsolatedRecoveryFixture fixture{};
  if (!CreateIsolatedRecoveryFixture(&fixture)) {
    CanonicalFailure(
        &failures,
        "protected_operations: committed fixture creation\n");
    RemoveIsolatedRecoveryFixture(&fixture);
    return failures;
  }
  constexpr wchar_t kDummyVolumeRoot[] = L"\\\\?\\C:\\";
  constexpr std::array<std::uint8_t, 12U> kSid = {
      1U, 1U, 0U, 0U, 0U, 0U, 0U, 5U, 18U, 0U, 0U, 0U};
  gc::Byte32 authenticated_binding{};
  authenticated_binding.fill(0x77U);
  HANDLE stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  gc::ProtectedOperationsState state{};
  bool valid = stop != nullptr && gc::InitializeProtectedOperations(
      kDummyVolumeRoot,
      std::size(kDummyVolumeRoot) - 1U,
      &state);
  if (!valid) {
    CanonicalFailure(
        &failures,
        "protected_operations: committed fixture initial startup\n");
  }
  const auto create = CreateBody(state.state_sha256, 1U, 0U);
  std::array<std::uint8_t, gc::kCreateKeysetResultBytes> result{};
  std::uint32_t result_length = 0U;
  gc::ResetProtectedFilesystemFailuresForTest();
  const gc::ProtectedOperationResult create_result = valid
      ? gc::ExecuteProtectedOperation(
      &state,
      static_cast<std::uint8_t>(gc::Opcode::CreateKeyset),
      create.data(),
      static_cast<std::uint32_t>(create.size()),
      kSid.data(),
      static_cast<std::uint16_t>(kSid.size()),
      authenticated_binding,
      GetTickCount64() + 30'000U,
      stop,
      &result,
      &result_length)
      : gc::ProtectedOperationResult::CustodyOrJournal;
  const bool created = valid &&
      create_result == gc::ProtectedOperationResult::Success &&
      result_length == gc::kCreateKeysetResultBytes &&
      ReadU16(result.data() + 2U) == 1U && state.ready &&
      state.active_generation == 1U && state.highest_committed_generation == 1U &&
      gc::ProtectedPreparedPublicationStageForTest() == 16U &&
      gc::ProtectedPreparedPublicationErrorForTest() == ERROR_SUCCESS;
  if (!created) {
    if (create_result != gc::ProtectedOperationResult::Success) {
      DiagnosticCount(
          "protected_operations: committed fixture create last-error ",
          GetLastError());
      DiagnosticCount(
          "protected_operations: committed fixture PREP stage ",
          gc::ProtectedPreparedPublicationStageForTest());
      DiagnosticCount(
          "protected_operations: committed fixture PREP error ",
          gc::ProtectedPreparedPublicationErrorForTest());
      CanonicalFailure(
          &failures,
          "protected_operations: committed fixture create result\n");
      constexpr std::array<gc::ProtectedFilesystemTestCutpoint, 7U>
          kCutpoints = {
              gc::ProtectedFilesystemTestCutpoint::CreateDirectory,
              gc::ProtectedFilesystemTestCutpoint::CreateFile,
              gc::ProtectedFilesystemTestCutpoint::Write,
              gc::ProtectedFilesystemTestCutpoint::FirstFlush,
              gc::ProtectedFilesystemTestCutpoint::Rename,
              gc::ProtectedFilesystemTestCutpoint::SecondFlush,
              gc::ProtectedFilesystemTestCutpoint::Reopen,
          };
      constexpr std::array<const char*, 7U> kMissing = {
          "protected_operations: create stopped before directory\n",
          "protected_operations: create stopped before file\n",
          "protected_operations: create stopped before write\n",
          "protected_operations: create stopped before first flush\n",
          "protected_operations: create stopped before rename\n",
          "protected_operations: create stopped before second flush\n",
          "protected_operations: create stopped before reopen\n",
      };
      for (std::size_t index = 0U; index < kCutpoints.size(); ++index) {
        DiagnosticCount(
            kMissing[index],
            gc::ProtectedFilesystemCallCountForTest(kCutpoints[index]));
        if (gc::ProtectedFilesystemCallCountForTest(kCutpoints[index]) == 0U) {
          CanonicalFailure(&failures, kMissing[index]);
        }
      }
      if (!state.filesystem.ready) {
        CanonicalFailure(
            &failures,
            "protected_operations: create cleared filesystem ready\n");
      }
      if (state.filesystem.recovery_deadline_ms != 0U) {
        CanonicalFailure(
            &failures,
            "protected_operations: create changed recovery deadline\n");
      }
      if (state.filesystem.recovery_stop_event != nullptr) {
        CanonicalFailure(
            &failures,
            "protected_operations: create changed recovery stop\n");
      }
      if (state.filesystem.security_descriptor_length == 0U) {
        CanonicalFailure(
            &failures,
            "protected_operations: create cleared security descriptor\n");
      }
      DiagnosticCount(
          "protected_operations: journal path length ",
          static_cast<std::uint32_t>(state.filesystem.journal_path.length));
    } else if (result_length != gc::kCreateKeysetResultBytes) {
      CanonicalFailure(
          &failures,
          "protected_operations: committed fixture create length\n");
    } else if (ReadU16(result.data() + 2U) != 1U) {
      CanonicalFailure(
          &failures,
          "protected_operations: committed fixture create disposition\n");
    } else {
      CanonicalFailure(
          &failures,
          "protected_operations: committed fixture create state\n");
    }
  }
  const gc::Byte32 created_state = state.state_sha256;
  const gc::Byte32 created_receipt = state.active_receipt_sha256;
  const auto revoke = RevokeBody(created_state, 1U, 1U, &created_receipt);
  gc::ResetProtectedFilesystemFailuresForTest();
  result.fill(0U);
  result_length = 0U;
  const gc::ProtectedOperationResult revoke_result = created
      ? gc::ExecuteProtectedOperation(
            &state,
            static_cast<std::uint8_t>(gc::Opcode::RevokeLocalKeyset),
            revoke.data(),
            static_cast<std::uint32_t>(revoke.size()),
            kSid.data(),
            static_cast<std::uint16_t>(kSid.size()),
            authenticated_binding,
            GetTickCount64() + 30'000U,
            stop,
            &result,
            &result_length)
      : gc::ProtectedOperationResult::CustodyOrJournal;
  const bool revoked = created &&
      revoke_result == gc::ProtectedOperationResult::Success &&
      result_length == gc::kRevokeKeysetResultBytes &&
      ReadU16(result.data() + 2U) == 1U && state.ready &&
      state.active_generation == 0U && state.active_revoked &&
      state.operation_id_count == 2U && state.next_publication_sequence == 9U &&
      gc::ProtectedPreparedPublicationStageForTest() == 16U &&
      gc::ProtectedPreparedPublicationErrorForTest() == ERROR_SUCCESS;
  if (!revoked) {
    DiagnosticCount(
        "protected_operations: committed fixture revoke result ",
        static_cast<std::uint32_t>(revoke_result));
    DiagnosticCount(
        "protected_operations: committed fixture revoke length ",
        result_length);
    DiagnosticCount(
        "protected_operations: committed fixture revoke disposition ",
        ReadU16(result.data() + 2U));
    DiagnosticCount(
        "protected_operations: committed fixture revoke active generation ",
        static_cast<std::uint32_t>(state.active_generation));
    DiagnosticCount(
        "protected_operations: committed fixture revoke active flag ",
        state.active_revoked ? 1U : 0U);
    DiagnosticCount(
        "protected_operations: committed fixture revoke operation count ",
        state.operation_id_count);
    DiagnosticCount(
        "protected_operations: committed fixture revoke next publication ",
        state.next_publication_sequence);
    DiagnosticCount(
        "protected_operations: committed fixture revoke PREP stage ",
        gc::ProtectedPreparedPublicationStageForTest());
    DiagnosticCount(
        "protected_operations: committed fixture revoke PREP error ",
        gc::ProtectedPreparedPublicationErrorForTest());
    CanonicalFailure(
        &failures,
        "protected_operations: committed fixture revoke\n");
  }
  const gc::Byte32 revoked_state = state.state_sha256;
  gc::CloseProtectedOperations(&state);
  gc::ResetProtectedRecoveryEvidenceForTest();
  const bool replayed = revoked && gc::InitializeProtectedOperations(
      kDummyVolumeRoot,
      std::size(kDummyVolumeRoot) - 1U,
      &state);
  if (!replayed) {
    CanonicalFailure(
        &failures,
        "protected_operations: committed fixture replay startup\n");
  }
  const gc::ProtectedRecoveryEvidenceForTest* evidence =
      gc::ProtectedRecoveryEvidenceViewForTest();
  const bool replay_state = replayed && state.ready &&
      state.active_generation == 0U &&
      state.active_revoked && state.operation_id_count == 2U &&
      state.next_publication_sequence == 9U &&
      state.state_sha256 == revoked_state &&
      evidence != nullptr;
  if (!replay_state) {
    CanonicalFailure(
        &failures,
        "protected_operations: committed replay state projection\n");
  }
  const bool replay_counts = replay_state &&
      evidence->source_read_count == 0U &&
      evidence->residue_payload_read_count == 0U &&
      evidence->source_mutation_count == 0U &&
      evidence->phase_b_mutation_count == 0U &&
      evidence->canonical_replay_count == 2U &&
      evidence->publication_count == 8U && evidence->operation_count == 2U &&
      evidence->next_publication_sequence == 9U &&
      !evidence->active_operation_present && !evidence->nonterminal_present;
  if (!replay_counts) {
    CanonicalFailure(
        &failures,
        "protected_operations: committed replay evidence counts\n");
  }
  const bool replay_operation = replay_counts &&
      evidence->operations[0].present &&
      evidence->operations[0].physical_effect_applied &&
      evidence->operations[0].operation_id[0] == 1U &&
      evidence->operations[0].opcode ==
          static_cast<std::uint8_t>(gc::Opcode::CreateKeyset) &&
      evidence->operations[0].lifecycle == 3U &&
      evidence->operations[0].effect_authorizer_sequence == 2U &&
      evidence->operations[0].attempt_count == 1U &&
      evidence->operations[1].present &&
      evidence->operations[1].physical_effect_applied &&
      evidence->operations[1].operation_id[0] == 0x20U &&
      evidence->operations[1].opcode ==
          static_cast<std::uint8_t>(gc::Opcode::RevokeLocalKeyset) &&
      evidence->operations[1].lifecycle == 3U &&
      evidence->operations[1].effect_authorizer_sequence == 6U &&
      evidence->operations[1].attempt_count == 1U;
  if (!replay_operation) {
    for (std::size_t index = 0U; evidence != nullptr && index < 2U; ++index) {
      DiagnosticCount(
          index == 0U
              ? "protected_operations: replay operation0 present "
              : "protected_operations: replay operation1 present ",
          evidence->operations[index].present ? 1U : 0U);
      DiagnosticCount(
          index == 0U
              ? "protected_operations: replay operation0 physical "
              : "protected_operations: replay operation1 physical ",
          evidence->operations[index].physical_effect_applied ? 1U : 0U);
      DiagnosticCount(
          index == 0U
              ? "protected_operations: replay operation0 id0 "
              : "protected_operations: replay operation1 id0 ",
          evidence->operations[index].operation_id[0]);
      DiagnosticCount(
          index == 0U
              ? "protected_operations: replay operation0 opcode "
              : "protected_operations: replay operation1 opcode ",
          evidence->operations[index].opcode);
      DiagnosticCount(
          index == 0U
              ? "protected_operations: replay operation0 lifecycle "
              : "protected_operations: replay operation1 lifecycle ",
          evidence->operations[index].lifecycle);
      DiagnosticCount(
          index == 0U
              ? "protected_operations: replay operation0 authorizer "
              : "protected_operations: replay operation1 authorizer ",
          evidence->operations[index].effect_authorizer_sequence);
      DiagnosticCount(
          index == 0U
              ? "protected_operations: replay operation0 attempts "
              : "protected_operations: replay operation1 attempts ",
          evidence->operations[index].attempt_count);
    }
    CanonicalFailure(
        &failures,
        "protected_operations: committed replay operation evidence\n");
  }
  const bool replay_digests = replay_operation &&
      !AllZero(
          evidence->canonical_state_sha256.data(),
          evidence->canonical_state_sha256.size()) &&
      !AllZero(
          evidence->physical_snapshot_sha256.data(),
          evidence->physical_snapshot_sha256.size());
  if (!replay_digests) {
    CanonicalFailure(
        &failures,
        "protected_operations: committed replay digests\n");
  }
  gc::CloseProtectedOperations(&state);
  if (stop != nullptr) CloseHandle(stop);
  RemoveIsolatedRecoveryFixture(&fixture);
  return failures;
}

int TestIsolatedDirectoryMoveAuthority() noexcept {
  int failures = 0;
  DWORD baseline_handles = 0U;
  if (GetProcessHandleCount(GetCurrentProcess(), &baseline_handles) == FALSE) {
    CanonicalFailure(
        &failures,
        "protected_operations: directory move baseline handle count\n");
  }
  constexpr wchar_t kDummyVolumeRoot[] = L"\\\\?\\C:\\";
  constexpr std::array<MoveCandidateShape, 3U> kSuccessShapes = {
      MoveCandidateShape::Empty,
      MoveCandidateShape::Partial,
      MoveCandidateShape::InconsistentFull};
  DWORD post_warm_baseline = baseline_handles;
  for (std::size_t shape_index = 0U;
       shape_index < kSuccessShapes.size();
       ++shape_index) {
    const MoveCandidateShape shape = kSuccessShapes[shape_index];
    DWORD handles_before = 0U;
    GetProcessHandleCount(GetCurrentProcess(), &handles_before);
    IsolatedRecoveryFixture fixture{};
    gc::ProtectedOperationsState state{};
    bool valid = CreateIsolatedRecoveryFixture(&fixture) &&
        gc::InitializeProtectedOperations(
            kDummyVolumeRoot,
            std::size(kDummyVolumeRoot) - 1U,
            &state) &&
        CreateDirectoryMoveTree(fixture, L"move-source", shape);
    gc::SetProtectedDirectoryMoveFailureForTest(0U);
    const bool moved = valid && gc::MoveProtectedDirectoryToQuarantineForTest(
        &state, L"move-source", L"move-final");
    valid = moved && gc::ProtectedDirectoryMoveStageForTest() == 8U &&
        gc::ProtectedDirectoryMoveErrorForTest() == ERROR_SUCCESS &&
        !TestPathExists(fixture, L"journal\\move-source", true) &&
        DirectoryMoveTreeMatches(
            fixture, L"quarantine", L"move-final", shape);
    if (!valid) {
      DiagnosticCount(
          "protected_operations: directory move success shape stage ",
          gc::ProtectedDirectoryMoveStageForTest());
      DiagnosticCount(
          "protected_operations: directory move success shape error ",
          gc::ProtectedDirectoryMoveErrorForTest());
      CanonicalFailure(
          &failures,
          "protected_operations: isolated directory move success shape\n");
    }
    gc::SetProtectedDirectoryMoveFailureForTest(0U);
    gc::CloseProtectedOperations(&state);
    RemoveIsolatedRecoveryFixture(&fixture);
    DWORD handles_after = 0U;
    if (GetProcessHandleCount(GetCurrentProcess(), &handles_after) == FALSE) {
      handles_after = UINT32_MAX;
    }
    if (shape_index == 0U) {
      // The first successful probe is the explicit process warm-up. Every
      // later success, rejection, and fault cut must return to this baseline.
      post_warm_baseline = handles_after;
      if (handles_after == UINT32_MAX) {
        CanonicalFailure(
            &failures,
            "protected_operations: directory move post-warm handle count\n");
      }
    } else if (handles_before != post_warm_baseline ||
               handles_after != post_warm_baseline) {
      DiagnosticCount(
          "protected_operations: success shape handle id ",
          static_cast<std::uint32_t>(shape));
      DiagnosticCount(
          "protected_operations: success shape handles before ",
          handles_before);
      DiagnosticCount(
          "protected_operations: success shape handles after ",
          handles_after);
      CanonicalFailure(
          &failures,
          "protected_operations: success shape handle stability\n");
    }
  }

  constexpr std::array<MoveCandidateShape, 2U> kRejectedShapes = {
      MoveCandidateShape::InvalidFull,
      MoveCandidateShape::OverCapacity};
  for (MoveCandidateShape shape : kRejectedShapes) {
    DWORD handles_before = 0U;
    GetProcessHandleCount(GetCurrentProcess(), &handles_before);
    IsolatedRecoveryFixture fixture{};
    gc::ProtectedOperationsState state{};
    bool valid = CreateIsolatedRecoveryFixture(&fixture) &&
        gc::InitializeProtectedOperations(
            kDummyVolumeRoot,
            std::size(kDummyVolumeRoot) - 1U,
            &state) &&
        CreateDirectoryMoveTree(fixture, L"move-source", shape);
    gc::SetProtectedDirectoryMoveFailureForTest(0U);
    const bool moved = valid && gc::MoveProtectedDirectoryToQuarantineForTest(
        &state, L"move-source", L"move-final");
    valid = !moved && gc::ProtectedDirectoryMoveStageForTest() == 0U &&
        TestPathExists(fixture, L"journal\\move-source", true) &&
        !TestPathExists(fixture, L"quarantine\\move-final", true);
    if (!valid) {
      DiagnosticCount(
          "protected_operations: rejected directory move stage ",
          gc::ProtectedDirectoryMoveStageForTest());
      CanonicalFailure(
          &failures,
          "protected_operations: invalid or over-capacity move must fail before capture\n");
    }
    gc::SetProtectedDirectoryMoveFailureForTest(0U);
    gc::CloseProtectedOperations(&state);
    RemoveIsolatedRecoveryFixture(&fixture);
    DWORD handles_after = 0U;
    if (GetProcessHandleCount(GetCurrentProcess(), &handles_after) == FALSE ||
        handles_before != post_warm_baseline ||
        handles_after != post_warm_baseline) {
      DiagnosticCount(
          "protected_operations: rejected shape handle id ",
          static_cast<std::uint32_t>(shape));
      DiagnosticCount(
          "protected_operations: rejected shape handles before ",
          handles_before);
      DiagnosticCount(
          "protected_operations: rejected shape handles after ",
          handles_after);
      CanonicalFailure(
          &failures,
          "protected_operations: rejected shape handle stability\n");
    }
  }

  for (std::uint32_t cut = 1U; cut <= 8U; ++cut) {
    DWORD handles_before = 0U;
    GetProcessHandleCount(GetCurrentProcess(), &handles_before);
    IsolatedRecoveryFixture fixture{};
    gc::ProtectedOperationsState state{};
    bool valid = CreateIsolatedRecoveryFixture(&fixture) &&
        gc::InitializeProtectedOperations(
            kDummyVolumeRoot,
            std::size(kDummyVolumeRoot) - 1U,
            &state) &&
        CreateDirectoryMoveTree(
            fixture, L"move-source", MoveCandidateShape::Partial);
    gc::SetProtectedDirectoryMoveFailureForTest(cut);
    const bool moved = valid && gc::MoveProtectedDirectoryToQuarantineForTest(
        &state, L"move-source", L"move-final");
    const bool renamed = cut >= 3U;
    valid = !moved && gc::ProtectedDirectoryMoveStageForTest() == cut &&
        gc::ProtectedDirectoryMoveErrorForTest() == ERROR_OPERATION_ABORTED &&
        TestPathExists(
            fixture,
            renamed ? L"quarantine\\move-final" : L"journal\\move-source",
            true) &&
        !TestPathExists(
            fixture,
            renamed ? L"journal\\move-source" : L"quarantine\\move-final",
            true) &&
        DirectoryMoveTreeMatches(
            fixture,
            renamed ? L"quarantine" : L"journal",
            renamed ? L"move-final" : L"move-source",
            MoveCandidateShape::Partial);
    if (!valid) {
      DiagnosticCount(
          "protected_operations: directory move fault cut ", cut);
      DiagnosticCount(
          "protected_operations: directory move fault stage ",
          gc::ProtectedDirectoryMoveStageForTest());
      DiagnosticCount(
          "protected_operations: directory move fault error ",
          gc::ProtectedDirectoryMoveErrorForTest());
      CanonicalFailure(
          &failures,
          "protected_operations: isolated directory move ordered fault cut\n");
    }
    gc::SetProtectedDirectoryMoveFailureForTest(0U);
    gc::CloseProtectedOperations(&state);
    RemoveIsolatedRecoveryFixture(&fixture);
    DWORD handles_after = 0U;
    if (GetProcessHandleCount(GetCurrentProcess(), &handles_after) == FALSE ||
        handles_before != post_warm_baseline ||
        handles_after != post_warm_baseline) {
      DiagnosticCount(
          "protected_operations: fault shape handle cut ", cut);
      DiagnosticCount(
          "protected_operations: fault shape handles before ",
          handles_before);
      DiagnosticCount(
          "protected_operations: fault shape handles after ",
          handles_after);
      CanonicalFailure(
          &failures,
          "protected_operations: fault shape handle stability\n");
    }
  }
  DWORD final_handles = 0U;
  if (GetProcessHandleCount(GetCurrentProcess(), &final_handles) == FALSE ||
      final_handles != post_warm_baseline) {
    DiagnosticCount(
        "protected_operations: directory move pre-warm handles ",
        baseline_handles);
    DiagnosticCount(
        "protected_operations: directory move post-warm handles ",
        post_warm_baseline);
    DiagnosticCount(
        "protected_operations: directory move final handles ", final_handles);
    CanonicalFailure(
        &failures,
        "protected_operations: directory move handle stability\n");
  }
  return failures;
}

int TestIsolatedJournalPublicationFailureRecovery() noexcept {
  int failures = 0;
  constexpr wchar_t kDummyVolumeRoot[] = L"\\\\?\\C:\\";
  constexpr wchar_t kOperation[] =
      L"op-0102030405060708090a0b0c0d0e0f10";
  constexpr wchar_t kPendingOperation[] =
      L".op-0102030405060708090a0b0c0d0e0f10.pending";
  constexpr wchar_t kGeneration[] = L"g-0000000000000001";
  constexpr std::array<std::uint8_t, 12U> kSid = {
      1U, 1U, 0U, 0U, 0U, 0U, 0U, 5U, 18U, 0U, 0U, 0U};
  gc::Byte32 binding{};
  binding.fill(0x66U);
  DWORD pre_warm_handles = 0U;
  DWORD stable_handles = 0U;
  GetProcessHandleCount(GetCurrentProcess(), &pre_warm_handles);
  for (std::uint32_t pass = 0U; pass < 2U; ++pass) {
    const bool warmup = pass == 0U;
    for (std::uint32_t call = 1U; call <= 3U; ++call) {
      const std::uint32_t final_stage = warmup ? 1U : 4U;
      for (std::uint32_t stage = 1U; stage <= final_stage; ++stage) {
      IsolatedRecoveryFixture fixture{};
      gc::ProtectedOperationsState state{};
      HANDLE stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
      std::array<std::uint8_t, gc::kCreateKeysetResultBytes> result{};
      std::uint32_t result_length = 0U;
      bool valid = stop != nullptr &&
          CreateIsolatedRecoveryFixture(&fixture) &&
          gc::InitializeProtectedOperations(
              kDummyVolumeRoot,
              std::size(kDummyVolumeRoot) - 1U,
              &state);
      const auto body = CreateBody(state.state_sha256, 1U, 0U);
      gc::SetProtectedJournalPublicationFailureForTest(call, stage);
      const gc::ProtectedOperationResult operation_result = valid
          ? gc::ExecuteProtectedOperation(
                &state,
                static_cast<std::uint8_t>(gc::Opcode::CreateKeyset),
                body.data(),
                static_cast<std::uint32_t>(body.size()),
                kSid.data(),
                static_cast<std::uint16_t>(kSid.size()),
                binding,
                GetTickCount64() + 60000U,
                stop,
                &result,
                &result_length)
          : gc::ProtectedOperationResult::Success;
      std::array<wchar_t, gc::kProtectedPathCharacters> operation_path{};
      std::array<wchar_t, gc::kProtectedPathCharacters> pending_path{};
      std::array<wchar_t, gc::kProtectedPathCharacters> candidate_path{};
      std::array<wchar_t, gc::kProtectedPathCharacters> final_generation{};
      valid = valid &&
          AppendTestPath(L"journal", kOperation, &operation_path) &&
          AppendTestPath(L"journal", kPendingOperation, &pending_path) &&
          AppendTestPath(
              operation_path.data(), L"keyset.pending", &candidate_path) &&
          AppendTestPath(L"keysets", kGeneration, &final_generation) &&
          operation_result == gc::ProtectedOperationResult::CustodyOrJournal &&
          gc::ProtectedJournalPublicationOrdinaryCallCountForTest() == call &&
          gc::ProtectedJournalPublicationStageForTest() == stage &&
          gc::ProtectedJournalPublicationErrorForTest() ==
              ERROR_OPERATION_ABORTED &&
          state.next_publication_sequence == call + 1U &&
          state.active_generation == 0U && !state.active_revoked &&
          state.committed_generation_count == 0U &&
          state.operation_id_count == 0U &&
          TestPathExists(fixture, operation_path.data(), true) &&
          !TestPathExists(fixture, pending_path.data(), true) &&
          (call == 1U
               ? TestPathExists(fixture, candidate_path.data(), true) &&
                     !TestPathExists(fixture, final_generation.data(), true)
               : !TestPathExists(fixture, candidate_path.data(), true) &&
                     TestPathExists(fixture, final_generation.data(), true));
      if (!valid) {
        DiagnosticCount(
            "protected_operations: journal cut call ", call);
        DiagnosticCount(
            "protected_operations: journal cut stage ", stage);
        DiagnosticCount(
            "protected_operations: journal cut observed stage ",
            gc::ProtectedJournalPublicationStageForTest());
        CanonicalFailure(
            &failures,
            "protected_operations: ordinary publication failure authority\n");
      }
      gc::SetProtectedJournalPublicationFailureForTest(0U, 0U);
      gc::CloseProtectedOperations(&state);
      gc::ResetProtectedRecoveryEvidenceForTest();
      valid = gc::InitializeProtectedOperations(
          kDummyVolumeRoot,
          std::size(kDummyVolumeRoot) - 1U,
          &state);
      std::array<wchar_t, gc::kProtectedPathCharacters> quarantine_path{};
      AppendTestPath(L"quarantine", kOperation, &quarantine_path);
      const bool restarted = valid && state.ready &&
          state.operation_id_count == 1U &&
          (call == 1U
               ? state.active_generation == 0U &&
                     state.quarantined_operation_count == 1U &&
                     state.next_publication_sequence == 5U &&
                     TestPathExists(fixture, quarantine_path.data(), true) &&
                     !TestPathExists(fixture, operation_path.data(), true) &&
                     !TestPathExists(fixture, final_generation.data(), true)
               : state.active_generation == 1U &&
                     state.committed_generation_count == 1U &&
                     state.quarantined_operation_count == 0U &&
                     state.next_publication_sequence ==
                         (call == 2U ? 6U : 5U) &&
                     TestPathExists(fixture, operation_path.data(), true) &&
                     TestPathExists(fixture, final_generation.data(), true));
      if (!restarted) {
        DiagnosticCount(
            "protected_operations: journal restart call ", call);
        DiagnosticCount(
            "protected_operations: journal restart stage ", stage);
        DiagnosticCount(
            "protected_operations: journal restart next publication ",
            state.next_publication_sequence);
        DiagnosticCount(
            "protected_operations: journal restart move stage ",
            gc::ProtectedDirectoryMoveStageForTest());
        DiagnosticCount(
            "protected_operations: journal restart move error ",
            gc::ProtectedDirectoryMoveErrorForTest());
        DiagnosticCount(
            "protected_operations: journal restart ordinary calls ",
            gc::ProtectedJournalPublicationOrdinaryCallCountForTest());
        DiagnosticCount(
            "protected_operations: journal restart publication stage ",
            gc::ProtectedJournalPublicationStageForTest());
        DiagnosticCount(
            "protected_operations: journal restart publication error ",
            gc::ProtectedJournalPublicationErrorForTest());
        DiagnosticCount(
            "protected_operations: journal restart prepared stage ",
            gc::ProtectedPreparedPublicationStageForTest());
        DiagnosticCount(
            "protected_operations: journal restart prepared error ",
            gc::ProtectedPreparedPublicationErrorForTest());
        DiagnosticCount(
            "protected_operations: journal restart create recovery stage ",
            gc::ProtectedCreateRecoveryStageForTest());
        DiagnosticCount(
            "protected_operations: journal restart create recovery calls ",
            gc::ProtectedCreateRecoveryCallCountForTest());
        DiagnosticCount(
            "protected_operations: journal restart create recovery mode ",
            gc::ProtectedCreateRecoveryLastModeForTest());
        DiagnosticCount(
            "protected_operations: journal restart phase-b gate stage ",
            gc::ProtectedPhaseBNonterminalRevalidationStageForTest());
        const gc::ProtectedRecoveryEvidenceForTest* recovery_evidence =
            gc::ProtectedRecoveryEvidenceViewForTest();
        DiagnosticCount(
            "protected_operations: journal restart phase-b revalidations ",
            recovery_evidence == nullptr
                ? UINT32_MAX
                : recovery_evidence->phase_b_revalidation_count);
        DiagnosticCount(
            "protected_operations: journal restart phase-b mutations ",
            recovery_evidence == nullptr
                ? UINT32_MAX
                : recovery_evidence->phase_b_mutation_count);
        CanonicalFailure(
            &failures,
            "protected_operations: ordinary publication restart\n");
      }
      gc::CloseProtectedOperations(&state);
      if (stop != nullptr) CloseHandle(stop);
      RemoveIsolatedRecoveryFixture(&fixture);
      DWORD handles_after = 0U;
      if (!warmup &&
          (GetProcessHandleCount(GetCurrentProcess(), &handles_after) == FALSE ||
           handles_after != stable_handles)) {
        DiagnosticCount(
            "protected_operations: journal handle call ", call);
        DiagnosticCount(
            "protected_operations: journal handle stage ", stage);
        DiagnosticCount(
            "protected_operations: journal cut handles before ",
            stable_handles);
        DiagnosticCount(
            "protected_operations: journal cut handles after ", handles_after);
        CanonicalFailure(
            &failures,
            "protected_operations: ordinary publication handle cleanup\n");
      }
      }
    }
    if (warmup &&
        (GetProcessHandleCount(GetCurrentProcess(), &stable_handles) == FALSE ||
         stable_handles < pre_warm_handles)) {
      DiagnosticCount(
          "protected_operations: journal pre-warm handles ", pre_warm_handles);
      DiagnosticCount(
          "protected_operations: journal post-warm handles ", stable_handles);
      CanonicalFailure(
          &failures,
          "protected_operations: ordinary publication handle warmup\n");
    }
  }

  IsolatedRecoveryFixture fixture{};
  gc::ProtectedOperationsState state{};
  HANDLE stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  std::array<std::uint8_t, gc::kCreateKeysetResultBytes> result{};
  std::uint32_t result_length = 0U;
  bool success = stop != nullptr && CreateIsolatedRecoveryFixture(&fixture) &&
      gc::InitializeProtectedOperations(
          kDummyVolumeRoot,
          std::size(kDummyVolumeRoot) - 1U,
          &state);
  const auto body = CreateBody(state.state_sha256, 1U, 0U);
  gc::SetProtectedJournalPublicationFailureForTest(0U, 0U);
  success = success && gc::ExecuteProtectedOperation(
      &state,
      static_cast<std::uint8_t>(gc::Opcode::CreateKeyset),
      body.data(),
      static_cast<std::uint32_t>(body.size()),
      kSid.data(),
      static_cast<std::uint16_t>(kSid.size()),
      binding,
      GetTickCount64() + 60000U,
      stop,
      &result,
      &result_length) == gc::ProtectedOperationResult::Success &&
      gc::ProtectedJournalPublicationOrdinaryCallCountForTest() == 3U &&
      gc::ProtectedJournalPublicationStageForTest() == 5U &&
      gc::ProtectedJournalPublicationErrorForTest() == ERROR_SUCCESS &&
      state.next_publication_sequence == 5U && state.active_generation == 1U;
  if (!success) {
    CanonicalFailure(
        &failures,
        "protected_operations: ordinary publication stage-five success\n");
  }
  gc::CloseProtectedOperations(&state);
  if (stop != nullptr) CloseHandle(stop);
  RemoveIsolatedRecoveryFixture(&fixture);
  return failures;
}

int TestIsolatedRevokeControlFailureRecovery() noexcept {
  int failures = 0;
  constexpr wchar_t kDummyVolumeRoot[] = L"\\\\?\\C:\\";
  constexpr wchar_t kControl[] =
      L"controls\\g-0000000000000001.revoke.gckc";
  constexpr wchar_t kRevokeOperation[] =
      L"journal\\op-202122232425262728292a2b2c2d2e2f";
  constexpr std::array<std::uint8_t, 12U> kSid = {
      1U, 1U, 0U, 0U, 0U, 0U, 0U, 5U, 18U, 0U, 0U, 0U};
  gc::Byte32 binding{};
  binding.fill(0x66U);
  DWORD pre_warm_handles = 0U;
  DWORD stable_handles = 0U;
  GetProcessHandleCount(GetCurrentProcess(), &pre_warm_handles);
  for (std::uint32_t pass = 0U; pass < 2U; ++pass) {
    const bool warmup = pass == 0U;
    const std::uint32_t final_stage = warmup ? 1U : 6U;
    for (std::uint32_t stage = 1U; stage <= final_stage; ++stage) {
    IsolatedRecoveryFixture fixture{};
    gc::ProtectedOperationsState state{};
    HANDLE stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    std::array<std::uint8_t, gc::kCreateKeysetResultBytes> result{};
    std::uint32_t result_length = 0U;
    gc::SetProtectedJournalPublicationFailureForTest(0U, 0U);
    bool valid = stop != nullptr && CreateIsolatedRecoveryFixture(&fixture) &&
        gc::InitializeProtectedOperations(
            kDummyVolumeRoot,
            std::size(kDummyVolumeRoot) - 1U,
            &state);
    const auto create = CreateBody(state.state_sha256, 1U, 0U);
    valid = valid && gc::ExecuteProtectedOperation(
        &state,
        static_cast<std::uint8_t>(gc::Opcode::CreateKeyset),
        create.data(),
        static_cast<std::uint32_t>(create.size()),
        kSid.data(),
        static_cast<std::uint16_t>(kSid.size()),
        binding,
        GetTickCount64() + 60000U,
        stop,
        &result,
        &result_length) == gc::ProtectedOperationResult::Success;
    const gc::Byte32 pre_revoke_state = state.state_sha256;
    const auto revoke = RevokeBody(
        state.state_sha256, 1U, 1U, &state.active_receipt_sha256);
    const std::uint32_t live_cut = stage == 2U || stage == 3U ? 6U : stage;
    gc::SetProtectedRevokeControlFailureForTest(live_cut);
    const gc::ProtectedOperationResult revoke_result = valid
        ? gc::ExecuteProtectedOperation(
              &state,
              static_cast<std::uint8_t>(gc::Opcode::RevokeLocalKeyset),
              revoke.data(),
              static_cast<std::uint32_t>(revoke.size()),
              kSid.data(),
              static_cast<std::uint16_t>(kSid.size()),
              binding,
              GetTickCount64() + 60000U,
              stop,
              &result,
              &result_length)
        : gc::ProtectedOperationResult::Success;
    valid = valid &&
        revoke_result == gc::ProtectedOperationResult::CustodyOrJournal &&
        gc::ProtectedRevokeControlStageForTest() == live_cut &&
        gc::ProtectedRevokeControlErrorForTest() == ERROR_OPERATION_ABORTED &&
        gc::ProtectedRevokeComputeCountForTest() == 0U &&
        state.next_publication_sequence == 7U &&
        state.active_generation == 1U && !state.active_revoked &&
        state.operation_id_count == 1U &&
        state.state_sha256 == pre_revoke_state &&
        TestPathExists(fixture, kControl, false);
    if (!valid) {
      DiagnosticCount(
          "protected_operations: revoke live cut stage ", stage);
      DiagnosticCount(
          "protected_operations: revoke live observed stage ",
          gc::ProtectedRevokeControlStageForTest());
      CanonicalFailure(
          &failures,
          "protected_operations: revoke live final authority cut\n");
    }
    gc::CloseProtectedOperations(&state);
    if (stage == 2U || stage == 3U) {
      const std::uint32_t ordinary_calls_before_recovery_cut =
          gc::ProtectedJournalPublicationOrdinaryCallCountForTest();
      gc::SetProtectedRevokeControlFailureForTest(stage);
      gc::ResetProtectedRecoveryEvidenceForTest();
      const bool intermediate = gc::InitializeProtectedOperations(
          kDummyVolumeRoot,
          std::size(kDummyVolumeRoot) - 1U,
          &state);
      const gc::ProtectedRecoveryEvidenceForTest* intermediate_evidence =
          gc::ProtectedRecoveryEvidenceViewForTest();
      std::array<wchar_t, gc::kProtectedPathCharacters> recovery_record{};
      const bool no_downstream_publication =
          AppendTestPath(
              kRevokeOperation, L"s00000002-attempt.gcjr", &recovery_record) &&
          !TestPathExists(fixture, recovery_record.data(), false) &&
          AppendTestPath(
              kRevokeOperation, L"s00000003-outcome.gcjr", &recovery_record) &&
          !TestPathExists(fixture, recovery_record.data(), false) &&
          AppendTestPath(
              kRevokeOperation, L"s00000004-committed.gcjr", &recovery_record) &&
          !TestPathExists(fixture, recovery_record.data(), false);
      if (intermediate ||
          gc::ProtectedRevokeControlStageForTest() != stage ||
          gc::ProtectedRevokeControlErrorForTest() != ERROR_OPERATION_ABORTED ||
          gc::ProtectedRevokeComputeCountForTest() != 2U ||
          intermediate_evidence == nullptr ||
          intermediate_evidence->phase_b_mutation_count != 0U ||
          gc::ProtectedJournalPublicationOrdinaryCallCountForTest() !=
              ordinary_calls_before_recovery_cut ||
          !no_downstream_publication ||
          !TestPathExists(fixture, kControl, false)) {
        DiagnosticCount(
            "protected_operations: revoke recovery cut stage ", stage);
        DiagnosticCount(
            "protected_operations: revoke recovery observed stage ",
            gc::ProtectedRevokeControlStageForTest());
        DiagnosticCount(
            "protected_operations: revoke recovery compute count ",
            gc::ProtectedRevokeComputeCountForTest());
        DiagnosticCount(
            "protected_operations: revoke recovery mutation count ",
            intermediate_evidence == nullptr
                ? UINT32_MAX
                : intermediate_evidence->phase_b_mutation_count);
        CanonicalFailure(
            &failures,
            "protected_operations: revoke final-only recovery cut\n");
      }
      gc::CloseProtectedOperations(&state);
    }
    gc::SetProtectedRevokeControlFailureForTest(0U);
    gc::ResetProtectedRecoveryEvidenceForTest();
    const bool restarted = gc::InitializeProtectedOperations(
        kDummyVolumeRoot,
        std::size(kDummyVolumeRoot) - 1U,
        &state) &&
        state.ready && state.active_generation == 0U && state.active_revoked &&
        state.committed_generation_count == 1U &&
        state.operation_id_count == 2U &&
        state.next_publication_sequence == 10U &&
        TestPathExists(fixture, kControl, false);
    if (!restarted) {
      DiagnosticCount(
          "protected_operations: revoke restart stage ", stage);
      DiagnosticCount(
          "protected_operations: revoke restart next publication ",
          state.next_publication_sequence);
      DiagnosticCount(
          "protected_operations: revoke restart compute count ",
          gc::ProtectedRevokeComputeCountForTest());
      DiagnosticCount(
          "protected_operations: revoke restart control stage ",
          gc::ProtectedRevokeControlStageForTest());
      DiagnosticCount(
          "protected_operations: revoke restart control error ",
          gc::ProtectedRevokeControlErrorForTest());
      DiagnosticCount(
          "protected_operations: revoke restart ordinary calls ",
          gc::ProtectedJournalPublicationOrdinaryCallCountForTest());
      DiagnosticCount(
          "protected_operations: revoke restart publication stage ",
          gc::ProtectedJournalPublicationStageForTest());
      DiagnosticCount(
          "protected_operations: revoke restart publication error ",
          gc::ProtectedJournalPublicationErrorForTest());
      DiagnosticCount(
          "protected_operations: revoke restart phase-b gate stage ",
          gc::ProtectedPhaseBNonterminalRevalidationStageForTest());
      DiagnosticCount(
          "protected_operations: revoke restart recovery stage ",
          gc::ProtectedRevokeRecoveryStageForTest());
      const gc::ProtectedRecoveryEvidenceForTest* recovery_evidence =
          gc::ProtectedRecoveryEvidenceViewForTest();
      DiagnosticCount(
          "protected_operations: revoke restart phase-b revalidations ",
          recovery_evidence == nullptr
              ? UINT32_MAX
              : recovery_evidence->phase_b_revalidation_count);
      DiagnosticCount(
          "protected_operations: revoke restart phase-b mutations ",
          recovery_evidence == nullptr
              ? UINT32_MAX
              : recovery_evidence->phase_b_mutation_count);
      std::array<wchar_t, gc::kProtectedPathCharacters> record_path{};
      constexpr std::array<const wchar_t*, 5U> kRecordNames = {
          L"s00000000-prepared.gcjr",
          L"s00000001-attempt.gcjr",
          L"s00000002-attempt.gcjr",
          L"s00000003-outcome.gcjr",
          L"s00000004-committed.gcjr"};
      for (std::size_t index = 0U; index < kRecordNames.size(); ++index) {
        AppendTestPath(kRevokeOperation, kRecordNames[index], &record_path);
        DiagnosticCount(
            "protected_operations: revoke restart record present ",
            TestPathExists(fixture, record_path.data(), false) ? 1U : 0U);
      }
      CanonicalFailure(
          &failures,
          "protected_operations: revoke final-only restart\n");
    }
    gc::CloseProtectedOperations(&state);
    if (stop != nullptr) CloseHandle(stop);
    RemoveIsolatedRecoveryFixture(&fixture);
    DWORD handles_after = 0U;
    if (!warmup &&
        (GetProcessHandleCount(GetCurrentProcess(), &handles_after) == FALSE ||
         handles_after != stable_handles)) {
      DiagnosticCount(
          "protected_operations: revoke handles before ", stable_handles);
      DiagnosticCount(
          "protected_operations: revoke handles after ", handles_after);
      CanonicalFailure(
          &failures,
          "protected_operations: revoke failure handle cleanup\n");
    }
    }
    if (warmup &&
        (GetProcessHandleCount(GetCurrentProcess(), &stable_handles) == FALSE ||
         stable_handles < pre_warm_handles)) {
      DiagnosticCount(
          "protected_operations: revoke pre-warm handles ", pre_warm_handles);
      DiagnosticCount(
          "protected_operations: revoke post-warm handles ", stable_handles);
      CanonicalFailure(
          &failures,
          "protected_operations: revoke handle warmup\n");
    }
  }
  return failures;
}

}  // namespace

int RunProtectedOperationsTests() noexcept {
  int failures = TestCanonicalStateCalculator() + TestRecoveryActionSelector() +
                 TestPublicationInventoryAndResidueBinding() +
                 TestRecoveryPublicationAuthorityAndLifecycle() +
                 TestRecoveryFilesystemDuplication() +
                 TestIsolatedEmptyRecoveryStartup() +
                 TestIsolatedCommittedRecoveryReplay() +
                 TestIsolatedDirectoryMoveAuthority() +
                 TestIsolatedJournalPublicationFailureRecovery() +
                 TestIsolatedRevokeControlFailureRecovery();
  std::array<std::uint8_t, gc::kStateHeaderBytes> header{};
  for (std::size_t index = 0U; index < header.size(); ++index) {
    header[index] = static_cast<std::uint8_t>(index & 0xffU);
  }
  gc::ProtectedOperationsState state{};
  if (!gc::InitializeEmptyProtectedOperationsForTest(header, &state)) return 1;
  gc::Byte32 expected_state{};
  if (!HashStateHeader(header, &expected_state) || state.state_sha256 != expected_state) {
    ++failures;
  }
  if (state.generations.size() != gc::kMaximumBurnedGenerations ||
      state.operations.size() != gc::kMaximumOperationIds ||
      state.residues.size() != gc::kMaximumResidues ||
      state.historical_keys.size() != gc::kMaximumHistoricalCustodyKeys ||
      state.historical_key_count != 0U) {
    ++failures;
  }
  for (const auto& projection : state.generations) {
    if (projection.present || !AllZero(projection.bytes.data(), projection.bytes.size())) {
      ++failures;
      break;
    }
  }
  for (const auto& projection : state.operations) {
    if (projection.present || !AllZero(projection.bytes.data(), projection.bytes.size())) {
      ++failures;
      break;
    }
  }
  for (const auto& projection : state.residues) {
    if (projection.present || !AllZero(projection.bytes.data(), projection.bytes.size())) {
      ++failures;
      break;
    }
  }

  std::array<std::uint8_t, gc::kProtectedInspectPayloadBytes> inspect{};
  if (!gc::BuildProtectedInspect(state, gc::kMachineX64, &inspect) ||
      ReadU16(inspect.data()) != 1U ||
      ReadU16(inspect.data() + 2U) != gc::kMachineX64 ||
      ReadU64(inspect.data() + 24U) != gc::kCallableOpcodeBitmap ||
      ReadU16(inspect.data() + 32U) != 1U ||
      ReadU16(inspect.data() + 34U) != 0U ||
      ReadU32(inspect.data() + 36U) != 0U ||
      ReadU64(inspect.data() + 40U) != gc::kProtectedCallableOpcodeBitmap ||
      std::memcmp(inspect.data() + 48U, expected_state.data(), expected_state.size()) != 0 ||
      ReadU32(inspect.data() + 116U) != gc::kMaximumOperationIds ||
      ReadU32(inspect.data() + 120U) != gc::kMaximumBurnedGenerations ||
      !AllZero(inspect.data() + 80U, 32U) ||
      !AllZero(inspect.data() + 124U, 196U)) {
    ++failures;
  }

  state.active_generation = 7U;
  state.highest_burned_generation = 7U;
  state.highest_committed_generation = 7U;
  state.committed_generation_count = 1U;
  state.burned_generation_count = gc::kMaximumBurnedGenerations;
  state.operation_id_count = gc::kMaximumOperationIds;
  state.quarantined_operation_count = 2U;
  state.residue_count = 3U;
  state.active_receipt_sha256.fill(0x11U);
  state.runtime_manifest_spki_sha256.fill(0x22U);
  state.admission_evidence_spki_sha256.fill(0x33U);
  state.runtime_manifest_spki.fill(0x44U);
  state.admission_evidence_spki.fill(0x55U);
  if (!gc::BuildProtectedInspect(state, gc::kMachineArm64, &inspect) ||
      ReadU16(inspect.data() + 2U) != gc::kMachineArm64 ||
      ReadU16(inspect.data() + 34U) != 3U ||
      ReadU32(inspect.data() + 36U) != 7U ||
      ReadU64(inspect.data() + 80U) != 7U ||
      ReadU64(inspect.data() + 88U) != 7U ||
      ReadU32(inspect.data() + 96U) != 1U ||
      ReadU32(inspect.data() + 100U) != gc::kMaximumBurnedGenerations ||
      ReadU32(inspect.data() + 104U) != gc::kMaximumOperationIds ||
      ReadU32(inspect.data() + 108U) != 2U ||
      ReadU32(inspect.data() + 112U) != 3U ||
      ReadU32(inspect.data() + 116U) != 0U ||
      ReadU32(inspect.data() + 120U) != 0U ||
      inspect[128] != 0x11U || inspect[160] != 0x22U ||
      inspect[192] != 0x33U || inspect[224] != 0x44U ||
      inspect[268] != 0x55U) {
    ++failures;
  }

  state.operation_id_count = gc::kMaximumOperationIds + 1U;
  if (gc::BuildProtectedInspect(state, gc::kMachineX64, &inspect)) ++failures;
  state.operation_id_count = 0U;
  state.burned_generation_count = 0U;
  state.committed_generation_count = 0U;
  state.highest_burned_generation = 0U;
  state.highest_committed_generation = 0U;
  state.active_generation = 0U;
  if (!gc::BuildProtectedInspect(state, gc::kMachineX64, &inspect) ||
      !AllZero(inspect.data() + 128U, 184U)) {
    ++failures;
  }

  const std::array<std::uint8_t, 12U> sid = {
      1U, 1U, 0U, 0U, 0U, 0U, 0U, 5U, 18U, 0U, 0U, 0U};
  gc::Byte32 binding{};
  binding.fill(0x66U);
  HANDLE stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  std::array<std::uint8_t, gc::kCreateKeysetResultBytes> result{};
  std::uint32_t result_length = 0U;

  auto stale_create = CreateBody(gc::Byte32{}, 1U, 0U);
  stale_create[16] = 0xffU;
  if (gc::ExecuteProtectedOperation(
          &state,
          static_cast<std::uint8_t>(gc::Opcode::CreateKeyset),
          stale_create.data(),
          static_cast<std::uint32_t>(stale_create.size()),
          sid.data(),
          static_cast<std::uint16_t>(sid.size()),
          binding,
          GetTickCount64() + 1000U,
          stop,
          &result,
          &result_length) != gc::ProtectedOperationResult::Success ||
      result_length != gc::kCreateKeysetResultBytes ||
      ReadU16(result.data() + 2U) != 3U ||
      std::memcmp(result.data() + 72U, state.state_sha256.data(), 32U) != 0 ||
      std::memcmp(result.data() + 104U, state.state_sha256.data(), 32U) != 0 ||
      !AllZero(result.data() + 136U, 184U)) {
    ++failures;
  }

  auto current_create = CreateBody(state.state_sha256, 1U, 0U);
  state.operation_id_count = gc::kMaximumOperationIds;
  if (gc::ExecuteProtectedOperation(
          &state,
          static_cast<std::uint8_t>(gc::Opcode::CreateKeyset),
          current_create.data(),
          static_cast<std::uint32_t>(current_create.size()),
          sid.data(),
          static_cast<std::uint16_t>(sid.size()),
          binding,
          GetTickCount64() + 1000U,
          stop,
          &result,
          &result_length) != gc::ProtectedOperationResult::Success ||
      ReadU16(result.data() + 2U) != 6U) {
    ++failures;
  }
  state.operation_id_count = 0U;
  state.burned_generation_count = gc::kMaximumBurnedGenerations;
  if (gc::ExecuteProtectedOperation(
          &state,
          static_cast<std::uint8_t>(gc::Opcode::CreateKeyset),
          current_create.data(),
          static_cast<std::uint32_t>(current_create.size()),
          sid.data(),
          static_cast<std::uint16_t>(sid.size()),
          binding,
          GetTickCount64() + 1000U,
          stop,
          &result,
          &result_length) != gc::ProtectedOperationResult::Success ||
      ReadU16(result.data() + 2U) != 7U) {
    ++failures;
  }
  state.burned_generation_count = 0U;

  auto conflict_create = CreateBody(state.state_sha256, 2U, 0U);
  if (gc::ExecuteProtectedOperation(
          &state,
          static_cast<std::uint8_t>(gc::Opcode::CreateKeyset),
          conflict_create.data(),
          static_cast<std::uint32_t>(conflict_create.size()),
          sid.data(),
          static_cast<std::uint16_t>(sid.size()),
          binding,
          GetTickCount64() + 1000U,
          stop,
          &result,
          &result_length) != gc::ProtectedOperationResult::Success ||
      ReadU16(result.data() + 2U) != 9U) {
    ++failures;
  }

  auto revoke = RevokeBody(state.state_sha256, 1U, 1U);
  if (gc::ExecuteProtectedOperation(
          &state,
          static_cast<std::uint8_t>(gc::Opcode::RevokeLocalKeyset),
          revoke.data(),
          static_cast<std::uint32_t>(revoke.size()),
          sid.data(),
          static_cast<std::uint16_t>(sid.size()),
          binding,
          GetTickCount64() + 1000U,
          stop,
          &result,
          &result_length) != gc::ProtectedOperationResult::Success ||
      result_length != gc::kRevokeKeysetResultBytes ||
      ReadU16(result.data() + 2U) != 8U ||
      !AllZero(result.data() + 136U, 64U)) {
    ++failures;
  }

  // Operation IDs are globally unique across opcode families.
  state.create_replay = gc::ProtectedOperationReplayState{};
  state.revoke_replay = gc::ProtectedOperationReplayState{};
  auto replay_create = CreateBody(state.state_sha256, 1U, 0U);
  auto replay_revoke = RevokeBody(state.state_sha256, 1U, 1U);
  std::memcpy(replay_revoke.data(), replay_create.data(), 16U);
  SeedReplay(
      &state.revoke_replay,
      static_cast<std::uint8_t>(gc::Opcode::RevokeLocalKeyset),
      replay_revoke,
      sid,
      false,
      1U,
      static_cast<std::uint32_t>(gc::kRevokeKeysetResultBytes));
  if (gc::ExecuteProtectedOperation(
          &state,
          static_cast<std::uint8_t>(gc::Opcode::CreateKeyset),
          replay_create.data(),
          static_cast<std::uint32_t>(replay_create.size()),
          sid.data(),
          static_cast<std::uint16_t>(sid.size()),
          binding,
          GetTickCount64() + 1000U,
          stop,
          &result,
          &result_length) != gc::ProtectedOperationResult::Success ||
      result_length != gc::kCreateKeysetResultBytes ||
      ReadU16(result.data() + 2U) != 4U) {
    ++failures;
  }

  // Changed body is rejected before operator comparison; changed operator has
  // its own exact disposition and neither path advances the replay attempt.
  state.revoke_replay = gc::ProtectedOperationReplayState{};
  SeedReplay(
      &state.create_replay,
      static_cast<std::uint8_t>(gc::Opcode::CreateKeyset),
      replay_create,
      sid,
      false,
      1U,
      static_cast<std::uint32_t>(gc::kCreateKeysetResultBytes));
  auto changed_replay_body = replay_create;
  WriteU64(changed_replay_body.data() + 52U, 2U);
  if (gc::ExecuteProtectedOperation(
          &state,
          static_cast<std::uint8_t>(gc::Opcode::CreateKeyset),
          changed_replay_body.data(),
          static_cast<std::uint32_t>(changed_replay_body.size()),
          sid.data(),
          static_cast<std::uint16_t>(sid.size()),
          binding,
          GetTickCount64() + 1000U,
          stop,
          &result,
          &result_length) != gc::ProtectedOperationResult::Success ||
      ReadU16(result.data() + 2U) != 4U ||
      state.create_replay.attempt_count != 1U) {
    ++failures;
  }
  auto changed_sid = sid;
  changed_sid[8] ^= 1U;
  if (gc::ExecuteProtectedOperation(
          &state,
          static_cast<std::uint8_t>(gc::Opcode::CreateKeyset),
          replay_create.data(),
          static_cast<std::uint32_t>(replay_create.size()),
          changed_sid.data(),
          static_cast<std::uint16_t>(changed_sid.size()),
          binding,
          GetTickCount64() + 1000U,
          stop,
          &result,
          &result_length) != gc::ProtectedOperationResult::Success ||
      ReadU16(result.data() + 2U) != 5U ||
      state.create_replay.attempt_count != 1U) {
    ++failures;
  }

  // A quarantined operation replays its immutable disposition-10 result and
  // current/current state without writing a new ATTEMPT.
  SeedReplay(
      &state.create_replay,
      static_cast<std::uint8_t>(gc::Opcode::CreateKeyset),
      replay_create,
      sid,
      true,
      10U,
      static_cast<std::uint32_t>(gc::kCreateKeysetResultBytes));
  state.create_replay.result.fill(0xa5U);
  WriteU16(state.create_replay.result.data(), 1U);
  WriteU16(state.create_replay.result.data() + 2U, 10U);
  std::memcpy(state.create_replay.result.data() + 8U, replay_create.data(), 16U);
  const std::uint32_t quarantined_attempt_count =
      state.create_replay.attempt_count;
  if (gc::ExecuteProtectedOperation(
          &state,
          static_cast<std::uint8_t>(gc::Opcode::CreateKeyset),
          replay_create.data(),
          static_cast<std::uint32_t>(replay_create.size()),
          sid.data(),
          static_cast<std::uint16_t>(sid.size()),
          binding,
          GetTickCount64() + 1000U,
          stop,
          &result,
          &result_length) != gc::ProtectedOperationResult::Success ||
      result_length != gc::kCreateKeysetResultBytes ||
      ReadU16(result.data() + 2U) != 10U ||
      std::memcmp(result.data() + 72U, state.state_sha256.data(), 32U) != 0 ||
      std::memcmp(result.data() + 104U, state.state_sha256.data(), 32U) != 0 ||
      state.create_replay.attempt_count != quarantined_attempt_count) {
    ++failures;
  }

  // A committed replay never exceeds the 16-ATTEMPT cap.
  state.create_replay.quarantined = false;
  state.create_replay.attempt_count = gc::kMaximumJournalAttempts;
  if (gc::ExecuteProtectedOperation(
          &state,
          static_cast<std::uint8_t>(gc::Opcode::CreateKeyset),
          replay_create.data(),
          static_cast<std::uint32_t>(replay_create.size()),
          sid.data(),
          static_cast<std::uint16_t>(sid.size()),
          binding,
          GetTickCount64() + 1000U,
          stop,
          &result,
          &result_length) != gc::ProtectedOperationResult::Success ||
      ReadU16(result.data() + 2U) != 8U ||
      state.create_replay.attempt_count != gc::kMaximumJournalAttempts) {
    ++failures;
  }
  state.create_replay = gc::ProtectedOperationReplayState{};
  state.revoke_replay = gc::ProtectedOperationReplayState{};

  SetEvent(stop);
  if (gc::ExecuteProtectedOperation(
          &state,
          static_cast<std::uint8_t>(gc::Opcode::CreateKeyset),
          current_create.data(),
          static_cast<std::uint32_t>(current_create.size()),
          sid.data(),
          static_cast<std::uint16_t>(sid.size()),
          binding,
          GetTickCount64() + 1000U,
          stop,
          &result,
          &result_length) != gc::ProtectedOperationResult::CustodyOrJournal) {
    ++failures;
  }
  ResetEvent(stop);
  if (gc::ExecuteProtectedOperation(
          &state,
          static_cast<std::uint8_t>(gc::Opcode::CreateKeyset),
          current_create.data(),
          static_cast<std::uint32_t>(current_create.size()),
          sid.data(),
          static_cast<std::uint16_t>(sid.size()),
          binding,
          GetTickCount64(),
          stop,
          &result,
          &result_length) != gc::ProtectedOperationResult::CustodyOrJournal) {
    ++failures;
  }

  if (stop != nullptr) CloseHandle(stop);
  gc::CloseProtectedOperations(&state);
  if (state.ready || !AllZero(
          reinterpret_cast<const std::uint8_t*>(&state), sizeof(state))) {
    ++failures;
  }
  return failures;
}

#endif
