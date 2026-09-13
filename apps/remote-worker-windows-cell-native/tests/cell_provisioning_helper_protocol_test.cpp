// Compile the actual private helper stream owner in this translation unit.
// The installed entrypoint is never invoked: no custody, controller connection,
// journal, VHDX or volume operation runs in this fixture.
#define wmain UnusedCellProvisioningEntrypoint
#include "../src/cell_provisioning_main.cpp"
#undef wmain

int wmain(int argc, wchar_t** arguments) {
  if (argc != 3) return 2;
  const auto maximum = static_cast<unsigned>(wcstoul(arguments[1], nullptr, 10));
  if (maximum != 5 && maximum != 11 && maximum != 13 && maximum != 15 && maximum != 19 && maximum != 21) return 2;
  const bool recover = !wcscmp(arguments[2], L"recover");
  const bool full_bound = !wcscmp(arguments[2], L"full-bound");
  const bool over_bound = !wcscmp(arguments[2], L"over-bound");
  if (!recover && !full_bound && !over_bound && wcscmp(arguments[2], L"create")) return 2;
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
  if (!recover && maximum > 5) {
    const unsigned last = over_bound ? kCellControllerMaximumVolumeChecks + 1 : full_bound ? kCellControllerMaximumVolumeChecks : ordinal + 1;
    while (ordinal < last) if (ControllerSink::VolumeAuthority(&owner, ++ordinal, maximum, previous)) return 3;
  }
  std::array<std::uint8_t, 16> receipt{};
  Put32(receipt.data() + 4, 5); Put32(receipt.data() + 8, recover ? 0 : 1); Put32(receipt.data() + 12, maximum);
  return ControllerSink::Receipt(&owner, receipt) ? 3 : 0;
}
