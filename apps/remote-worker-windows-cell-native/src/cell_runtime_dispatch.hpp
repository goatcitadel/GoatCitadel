#pragma once
#include "cell_journal_runtime.hpp"
#include <span>
#include <optional>

namespace goatcitadel::worker_cell {
inline constexpr std::size_t kMaximumRuntimeDispatchBytes = 144 + 12 + 512 * 1024;
struct CellRuntimeDispatchBinding final {
  CellFileSha256 nonce{}, request_sha256{};
};
struct CellRuntimeFilePlan final {
  std::vector<std::wstring> paths;
  std::uint32_t maximum_file_bytes = 0, maximum_total_bytes = 0;
};
struct CellRuntimeDispatch final {
  CellJournalRuntimeReference reference;
  RuntimeJobCommand command;
  JobLimits limits;
  CellRuntimeDispatchBinding binding;
  std::optional<CellRuntimeFilePlan> file_staging;
};
// GCRUN001: magic[8], connection nonce[32], anchor identity[24], prepared hash[32],
// journal head[32], three LE32 inventory limits, LE32 nested length, then the
// full GCSTDIO2 configuration. Its job deadline may reach the native 24-hour
// ceiling; this does not change the local stdio helper's 25-second boundary.
// GCRUN002 appends GCFPLAN1 after the same nested configuration: LE32 count,
// per-file/total byte ceilings, then length-prefixed UTF-8 relative work paths.
// The original total request bound applies. Collection is not disclosure.
// SHA256 covers ASCII "goatcitadel.worker-runtime-dispatch.v1" plus NUL and every
// envelope byte. The expected binding must arrive through trusted admission,
// separately from the request. Hashing or decoding is not current authority.
DWORD HashCellRuntimeDispatch(std::span<const std::uint8_t> bytes, CellFileSha256* output) noexcept;
DWORD DecodeCellRuntimeDispatch(const std::vector<std::uint8_t>& bytes,
  const CellRuntimeDispatchBinding& expected, CellRuntimeDispatch* output) noexcept;
struct CellRuntimeDispatchResult final {
  CellJournalRuntimeResult execution;
  CellRuntimeDispatchBinding binding;
  bool binding_verified = false;
};
// Trusted native dispatch entry. Substituted bytes refuse before journal reads,
// authority callbacks or launch. Successful decoding still enters all native
// journal/runtime checks and current canonical authorization. No wire endpoint,
// implicit retry, installed service activation or remote publication is added.
// Legacy optional staging is an independently supplied trusted owner. A bound
// GCRUN002 plan supplies its own selector and refuses any external override.
// Its borrowed context must survive the synchronous dispatch and joined job.
CellRuntimeDispatchResult RunCellRuntimeDispatch(CellProvisioningJournal& journal,
  const std::vector<std::uint8_t>& bytes, const CellRuntimeDispatchBinding& expected,
  const CellFootprintScanGuard& authority, JobStdioChannel* stdio = nullptr,
  const CellRuntimeFileStaging* staging = nullptr) noexcept;
}
