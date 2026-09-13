#pragma once
#include "cell_virtual_disk_volume.hpp"
#include <wbemidl.h>

namespace goatcitadel::worker_cell {
enum class CellNtfsTargetFilesystem { raw, ntfs, other };
// Local Windows storage adapter, deliberately private to the bound formatter.
// Windows provider error text and object paths never enter durable checkpoints.
class CellNtfsFormatWmi final {
 private:
  friend class CellNtfsFormat;
  friend struct CellNtfsFormatWmiTestPeer;
  static DWORD Read(const std::wstring& volume_path, CellNtfsTargetFilesystem* filesystem,
                    ULONGLONG deadline, HANDLE cancellation) noexcept;
  static DWORD Format(const std::wstring& volume_path, DWORD (*before_send)(void*) noexcept,
                      void* context, ULONGLONG deadline, HANDLE cancellation) noexcept;
  static DWORD Parameters(IWbemClassObject* signature, IWbemClassObject** output) noexcept;
};
}
