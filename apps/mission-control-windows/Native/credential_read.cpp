#include <windows.h>
#include <winrt/Windows.Security.Credentials.h>

namespace {
constexpr int found = 0;
constexpr int unavailable = 2;
constexpr int missing = 3;

winrt::hstring read_lookup_key(const wchar_t* name)
{
    const auto capacity = GetEnvironmentVariableW(name, nullptr, 0);
    if (capacity == 0) {
        throw winrt::hresult_invalid_argument();
    }
    std::wstring value(capacity, L'\0');
    const auto length = GetEnvironmentVariableW(name, value.data(), capacity);
    if (length == 0 || length >= capacity) {
        throw winrt::hresult_invalid_argument();
    }
    return winrt::hstring{value.data(), length};
}

winrt::Windows::Security::Credentials::PasswordCredential retrieve_credential(
    const winrt::Windows::Security::Credentials::PasswordVault& vault,
    const winrt::hstring& resource,
    const winrt::hstring& account)
{
    try {
        return vault.Retrieve(resource, account);
    } catch (const winrt::hresult_error& error) {
        if (error.code() == HRESULT_FROM_WIN32(ERROR_NOT_FOUND)) {
            return nullptr;
        }
        throw;
    }
}
}

int main()
{
    const auto output = GetStdHandle(STD_OUTPUT_HANDLE);
    if (GetFileType(output) != FILE_TYPE_PIPE) {
        return unavailable;
    }

    try {
        winrt::init_apartment();
        const auto resource = read_lookup_key(L"GOATCITADEL_SECRET_SERVICE");
        const auto account = read_lookup_key(L"GOATCITADEL_SECRET_ACCOUNT");
        const auto credential = retrieve_credential(
            winrt::Windows::Security::Credentials::PasswordVault{}, resource, account);
        if (!credential) {
            return missing;
        }

        credential.RetrievePassword();
        const auto password = winrt::to_string(credential.Password());
        if (password.empty()) {
            return found;
        }
        DWORD written = 0;
        const auto length = static_cast<DWORD>(password.size());
        return WriteFile(output, password.data(), length, &written, nullptr) && written == length
            ? found : unavailable;
    } catch (...) {
        return unavailable;
    }
}
