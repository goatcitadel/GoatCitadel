// Compile the actual private helper stream owner in this translation unit.
// The installed entrypoint is never invoked: no custody, controller connection,
// journal, VHDX or volume operation runs in this fixture.
#define wmain UnusedCellProvisioningEntrypoint
#include "../src/cell_provisioning_main.cpp"
#undef wmain
#include <cstdio>

int RuntimeParentFixture(bool cancelled, bool expired, bool control = false) {
  RuntimeHelper runtime;
  DWORD error = runtime.ReadRequest(86400000);
  const bool decoded = error == ERROR_SUCCESS;
  Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  if (!error) {
    const auto name = CellRuntimeHelperPipeName(runtime.bootstrap.pipe_nonce, control);
    runtime.endpoint.value = CreateFileW(name.c_str(), kCellControllerPipeClientAccess, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
    error = runtime.parent.Open(GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE), runtime.endpoint.value);
  }
  struct Peer final {
    CellPipeParentEvidence* parent;
    unsigned calls = 0;
    static DWORD Check(void* raw) noexcept { auto& self = *static_cast<Peer*>(raw); ++self.calls; return self.parent->Verify(); }
  } peer{&runtime.parent};
  if (cancelled) SetEvent(stop.value);
  if (!error) error = AuthenticateCellRuntimeHelperParent(runtime.parent, runtime.bootstrap, {Peer::Check, &peer, stop.value},
    expired ? GetTickCount64() - 1 : GetTickCount64() + 5000, control);
  // The installed RuntimeHelper callback still refuses without real controller
  // custody. Handshake and request decoding never substitute for that admission.
  const auto execution = runtime.Run(nullptr, stop.value, GetTickCount64() + 1000, runtime.bootstrap.binding);
  const bool secret_erased = runtime.bootstrap.secret == CellFileSha256{};
  SecureZeroMemory(runtime.bootstrap.secret.data(), runtime.bootstrap.secret.size());
  std::printf("{\"decoded\":%s,\"authenticationError\":%lu,\"peerChecks\":%u,\"secretErased\":%s,\"runtimeRefused\":%s,\"installedService\":false}\n",
    decoded ? "true" : "false", error, peer.calls, secret_erased ? "true" : "false", execution.error ? "true" : "false");
  return 0;
}
int wmain(int argc, wchar_t** arguments) {
  if (argc == 2 && !wcsncmp(arguments[1], L"--pool-response", 15)) {
    // Stream-only fixture: semantic capture validation belongs to the native
    // encoder/client and portable decoder, tested separately. No installed
    // controller entrypoint, custody or filesystem operation is invoked here.
    CellControllerNonce nonce{}; nonce.fill(0x51);
    const auto size = !wcscmp(arguments[1], L"--pool-response-short") ? 1311u :
      !wcscmp(arguments[1], L"--pool-response-large") ? kCellPoolCapacityResponseMaximumBytes + 1 : 1312u;
    std::vector<std::uint8_t> bytes(size);
    for (std::size_t i = 0; i < bytes.size(); ++i) bytes[i] = static_cast<std::uint8_t>(i % 251);
    std::memcpy(bytes.data(), "GCPRESP1", 8); std::copy(nonce.begin(), nonce.end(), bytes.begin() + 24);
    if (!wcscmp(arguments[1], L"--pool-response-nonce")) bytes[24] ^= 1;
    if (ControllerSink::PoolCapacity(nullptr, nonce, bytes)) return 3;
    std::array<std::uint8_t, 16> receipt{}; Put32(receipt.data() + 4, 5); Put32(receipt.data() + 12, 21);
    return Frame(2, receipt.data(), 16) ? 0 : 3;
  }
  if (argc == 2 && !wcscmp(arguments[1], L"--runtime-parent")) return RuntimeParentFixture(false, false);
  if (argc == 2 && !wcscmp(arguments[1], L"--runtime-control")) return RuntimeParentFixture(false, false, true);
  if (argc == 2 && !wcscmp(arguments[1], L"--runtime-parent-cancelled")) return RuntimeParentFixture(true, false);
  if (argc == 2 && !wcscmp(arguments[1], L"--runtime-parent-expired")) return RuntimeParentFixture(false, true);
  if (argc != 3) return 2;
  const auto maximum = static_cast<unsigned>(wcstoul(arguments[1], nullptr, 10));
  if (maximum != 5 && maximum != 11 && maximum != 13 && maximum != 15 && maximum != 19 && maximum != 21) return 2;
  const bool backing_capacity = !wcsncmp(arguments[2], L"backing-", 8);
  const bool inventory = !wcsncmp(arguments[2], L"inventory-", 10);
  const auto mode = inventory ? arguments[2] + 10 : backing_capacity ? arguments[2] + 8 : arguments[2];
  const bool capacity = !wcscmp(mode, L"capacity") || !wcscmp(mode, L"capacity-invalid") ||
    !wcscmp(mode, L"capacity-full-bound") || !wcscmp(mode, L"capacity-over-bound");
  if (capacity && maximum != 21) return 2;
  const bool recover = capacity || !wcscmp(mode, L"recover");
  const bool full_bound = !wcscmp(mode, L"full-bound") || !wcscmp(mode, L"capacity-full-bound");
  const bool over_bound = !wcscmp(mode, L"over-bound") || !wcscmp(mode, L"capacity-over-bound");
  if (!recover && !full_bound && !over_bound && wcscmp(mode, L"create")) return 2;
  ControllerConnection unused_connection;
  ControllerSink owner{unused_connection}; owner.sink.maximum = maximum;
  unsigned ordinal = 0;
  CellFileSha256 previous{};
  const char* magic[] = {"GCCELLP1", "GCCVOL01", "GCCFMT01", "GCCPRV01", "GCCMNV01", "GCCMWP01"};
  const unsigned ends[] = {5, 11, 13, 15, 19, 21};
  for (unsigned index = 0, stage = 0, start = 0; index < maximum; ++index) {
    if (index == ends[stage]) { start = ends[stage]; ++stage; }
    if (!recover && index >= 5 && ControllerSink::VolumeAuthority(&owner, ++ordinal, index, previous)) return 3;
    CellProvisioningRecord record{}; std::memcpy(record.data(), magic[stage], 8);
    Put32(record.data() + 8, index - start + 1);
    // Stream-only fixtures: the controller client tests separately validate the
    // canonical metadata/hash chains. These distinct bytes prove ACK identity.
    std::fill(record.begin() + 992, record.end(), static_cast<std::uint8_t>(index + 1));
    CellFileSha256 acknowledged{};
    if (ControllerSink::Checkpoint(&owner, record, !recover, &acknowledged)) return 3;
    std::copy_n(record.begin() + 992, 32, previous.begin());
    if (!recover && acknowledged != previous) return 3;
  }
  if ((!recover || capacity) && maximum > 5) {
    const unsigned last = over_bound ? kCellControllerMaximumVolumeChecks + 1 : full_bound ? kCellControllerMaximumVolumeChecks : ordinal + 1;
    while (ordinal < last) if (ControllerSink::VolumeAuthority(&owner, ++ordinal, maximum, previous)) return 3;
  }
  if (capacity) {
    CellControllerNonce nonce{}; nonce.fill(0x51);
    CellProvisioningFootprint observation;
    observation.anchor.file.volume_serial = 11; observation.anchor.file.file_id.fill(12);
    observation.anchor.prepared_sha256.fill(13); observation.assignment_binding.fill(14);
    observation.profile_sha256.fill(15); observation.checkpoint_sha256.fill(16);
    observation.workspace.parent.volume_serial = 22; observation.workspace.parent.file_id.fill(21);
    for (std::size_t i = 0; i < 4; ++i) {
      observation.workspace.directories[i].volume_serial = 22;
      observation.workspace.directories[i].file_id.fill(static_cast<std::uint8_t>(22 + i));
    }
    observation.footprint = {observation.workspace.directories[0], 0x200000005ULL, 4096, 7, 9};
    if (inventory) {
      CellProvisioningInventory value{observation.anchor, observation.assignment_binding, observation.profile_sha256,
        observation.checkpoint_sha256, observation.workspace, {{observation.footprint.root, 0x200000005ULL, 22 * 4096, 22, 4}, {}}};
      for (const auto& root : observation.workspace.directories) value.inventory.entries.push_back({root, true, 0, 0});
      for (unsigned index = 0; index < 22; ++index) {
        CellFileIdentity identity; identity.volume_serial = 22; identity.file_id.fill(static_cast<std::uint8_t>(26 + index));
        value.inventory.entries.push_back({identity, false, index ? 0 : 0x200000005ULL, 4096});
      }
      if (!wcscmp(mode, L"capacity-invalid")) value.inventory.entries.back().identity = value.inventory.entries.front().identity;
      if (ControllerSink::Inventory(&owner, nonce, value)) return 3;
    } else if (backing_capacity) {
      CellProvisioningBackingFootprint host;
      host.anchor = observation.anchor; host.anchor.file.volume_serial = 22;
      host.assignment_binding = observation.assignment_binding; host.profile_sha256 = observation.profile_sha256;
      host.checkpoint_sha256 = observation.checkpoint_sha256; host.workspace = observation.workspace;
      std::memset(&host.backing.record.spec.identifier, 0x24, 16);
      host.backing.record.spec.virtual_bytes = 64ULL * 1024 * 1024; host.backing.record.spec.reserved_file_bytes = 128ULL * 1024 * 1024;
      host.backing.record.control = host.workspace.directories[1]; host.backing.record.backing.volume_serial = 22; host.backing.record.backing.file_id.fill(26);
      host.backing.file_bytes = host.backing.allocated_bytes = 66ULL * 1024 * 1024;
      host.journal_bytes = 21504; host.journal_allocated_bytes = 24576; host.host_file_allocated_bytes = host.backing.allocated_bytes + 24576;
      if (!wcscmp(mode, L"capacity-invalid")) ++host.host_file_allocated_bytes;
      if (ControllerSink::BackingCapacity(&owner, nonce, host)) return 3;
    } else {
      if (!wcscmp(mode, L"capacity-invalid")) observation.footprint.root = observation.workspace.parent;
      if (ControllerSink::Capacity(&owner, nonce, observation)) return 3;
    }
  }
  std::array<std::uint8_t, 16> receipt{};
  Put32(receipt.data() + 4, 5); Put32(receipt.data() + 8, recover ? 0 : 1); Put32(receipt.data() + 12, maximum);
  return ControllerSink::Receipt(&owner, receipt) ? 3 : 0;
}
