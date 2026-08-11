#include <windows.h>

#include "availability_broker.hpp"

extern "C" void __security_init_cookie();

extern "C" __declspec(noreturn) void WINAPI
AvailabilityBrokerEntryPoint() noexcept {
  __security_init_cookie();
  const int exit_code =
      goatcitadel::remote_worker_provisioner::RunAvailabilityBrokerDispatcher();
  ExitProcess(static_cast<UINT>(exit_code));
}
