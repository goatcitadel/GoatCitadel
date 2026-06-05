namespace GoatCitadel.MissionControl.Windows.Services;

public static class NavigationPolicy
{
    public static bool TryValidateBrowserTarget(string target, out Uri uri, out string error)
    {
        uri = new Uri("about:blank");
        error = "";
        var trimmed = target.Trim();
        if (trimmed.Length == 0)
        {
            error = "Browser target is empty.";
            return false;
        }

        if (trimmed.Any(char.IsControl))
        {
            error = "Browser target contains control characters.";
            return false;
        }

        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var parsed))
        {
            error = "Browser target must be an absolute http or https URL.";
            return false;
        }

        if (parsed.Scheme is not ("http" or "https"))
        {
            error = "Browser target must use http or https.";
            return false;
        }

        if (!IsAllowedLocalHost(parsed.Host))
        {
            error = "Browser target host is not an allowed local GoatCitadel host.";
            return false;
        }

        if (!string.IsNullOrEmpty(parsed.UserInfo))
        {
            error = "Browser target must not include credentials.";
            return false;
        }

        uri = parsed;
        return true;
    }

    public static bool IsAllowedLocalRoute(string route) =>
        route.StartsWith("/", StringComparison.Ordinal) &&
        !route.StartsWith("//", StringComparison.Ordinal) &&
        !route.StartsWith("/\\", StringComparison.Ordinal) &&
        !route.Any(char.IsControl) &&
        !route.Contains("://", StringComparison.Ordinal);

    private static bool IsAllowedLocalHost(string host) =>
        host.Equals("localhost", StringComparison.OrdinalIgnoreCase) ||
        host.Equals("127.0.0.1", StringComparison.OrdinalIgnoreCase) ||
        host.Equals("::1", StringComparison.OrdinalIgnoreCase) ||
        host.Equals("[::1]", StringComparison.OrdinalIgnoreCase);
}
