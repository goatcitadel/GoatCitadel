#pragma once

#include <windows.h>

#include <array>
#include <cstddef>
#include <cstdint>

namespace goatcitadel::remote_worker_provisioner {

// QueryServiceConfig[2]W only defines pcbBytesNeeded on insufficient-buffer
// failure. On success, validate pointers against our zeroed allocation instead
// of treating that failure-only output as the length of the returned data.
template <std::size_t Size, typename Query>
bool QueryBoundedServiceConfiguration(
    std::array<std::uint8_t, Size>* buffer,
    DWORD minimum_bytes,
    DWORD* buffer_bytes,
    Query query) noexcept {
  static_assert(Size <= 8192U, "SCM configuration queries have an 8 KiB limit.");
  if (buffer_bytes == nullptr) return false;
  *buffer_bytes = 0U;
  if (buffer == nullptr || minimum_bytes == 0U || minimum_bytes > Size) {
    return false;
  }
  buffer->fill(0U);
  DWORD needed_on_failure = 0U;
  if (query(buffer->data(), static_cast<DWORD>(Size), &needed_on_failure) == FALSE) {
    return false;
  }
  *buffer_bytes = static_cast<DWORD>(Size);
  return true;
}

}  // namespace goatcitadel::remote_worker_provisioner
