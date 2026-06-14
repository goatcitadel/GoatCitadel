namespace GoatCitadel.MissionControl.Windows.Services;

public enum NewWindowDisposition
{
    OpenInBrowser,
    Reject,
}

public static class NavigationPolicy
{
    /// <summary>
    /// Decides how a WebView2 <c>NewWindowRequested</c> target (window.open / target=_blank)
    /// should be handled. A popup WebView is never allowed: an allowed loopback target is routed
    /// to the real browser, anything else is rejected so it cannot escape the navigation allowlist.
    /// </summary>
    public static NewWindowDisposition ClassifyNewWindowTarget(string? target, out Uri uri, out string error)
    {
        uri = new Uri("about:blank");
        error = "";
        if (string.IsNullOrWhiteSpace(target))
        {
            error = "Popup target is empty.";
            return NewWindowDisposition.Reject;
        }

        if (TryValidateBrowserTarget(target, out uri, out error))
        {
            return NewWindowDisposition.OpenInBrowser;
        }

        return NewWindowDisposition.Reject;
    }

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
