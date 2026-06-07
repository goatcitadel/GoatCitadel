namespace GoatCitadel.MissionControl.Windows.Services;

public static class ActivationRouteParser
{
    public static bool TryGetRouteFromProtocolUri(Uri? uri, out string route)
    {
        route = "";
        if (uri is null)
        {
            return false;
        }

        if (!uri.Scheme.Equals("goatcitadel", StringComparison.OrdinalIgnoreCase) ||
            !uri.Host.Equals("open", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var query = ParseQuery(uri.Query);
        if (!query.TryGetValue("route", out var requestedRoute) ||
            !NavigationPolicy.IsAllowedLocalRoute(requestedRoute))
        {
            return false;
        }

        route = requestedRoute;
        if (query.TryGetValue("approvalId", out var approvalId) &&
            !string.IsNullOrWhiteSpace(approvalId) &&
            !approvalId.Any(char.IsControl) &&
            !route.Contains("approvalId=", StringComparison.OrdinalIgnoreCase))
        {
            route += route.Contains('?') ? "&" : "?";
            route += $"approvalId={Uri.EscapeDataString(approvalId)}";
        }

        return true;
    }

    private static Dictionary<string, string> ParseQuery(string query)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var trimmed = query.TrimStart('?');
        if (trimmed.Length == 0)
        {
            return result;
        }

        foreach (var pair in trimmed.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split('=', 2);
            var key = Uri.UnescapeDataString(parts[0].Replace("+", " "));
            var value = parts.Length > 1 ? Uri.UnescapeDataString(parts[1].Replace("+", " ")) : "";
            result[key] = value;
        }

        return result;
    }
}
