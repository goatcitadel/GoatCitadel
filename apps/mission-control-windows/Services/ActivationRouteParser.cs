namespace GoatCitadel.MissionControl.Windows.Services;

public static class ActivationRouteParser
{
    /// <summary>
    /// Resolves a <c>goatcitadel://</c> deep link from a raw command-line tail. This is the
    /// non-MSIX activation path: the HKCU <c>shell\open\command</c> registration launches the exe
    /// with the protocol URL as an argument, which surfaces as a <c>Launch</c>-kind activation
    /// rather than a <c>Protocol</c>-kind one.
    /// </summary>
    public static bool TryGetRouteFromCommandLineArguments(string? commandLine, out string route)
    {
        route = "";
        if (string.IsNullOrWhiteSpace(commandLine))
        {
            return false;
        }

        foreach (var parsedRoute in Tokenize(commandLine)
                     .Select(TryGetRouteFromToken)
                     .Where(parsedRoute => parsedRoute is not null))
        {
            route = parsedRoute!;
            return true;
        }

        route = "";
        return false;
    }

    internal static bool ContainsGoatcitadelProtocolToken(string? commandLine) =>
        !string.IsNullOrWhiteSpace(commandLine) &&
        Tokenize(commandLine).Any(token => token.StartsWith("goatcitadel:", StringComparison.OrdinalIgnoreCase));

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

        foreach (var pair in trimmed.Split('&', StringSplitOptions.RemoveEmptyEntries).Select(ParseQueryPair))
        {
            result[pair.Key] = pair.Value;
        }

        return result;
    }

    private static KeyValuePair<string, string> ParseQueryPair(string pair)
    {
        var parts = pair.Split('=', 2);
        var key = Uri.UnescapeDataString(parts[0].Replace("+", " "));
        var value = parts.Length > 1 ? Uri.UnescapeDataString(parts[1].Replace("+", " ")) : "";
        return new KeyValuePair<string, string>(key, value);
    }

    private static string? TryGetRouteFromToken(string token) =>
        Uri.TryCreate(token, UriKind.Absolute, out var uri) &&
        TryGetRouteFromProtocolUri(uri, out var route)
            ? route
            : null;

    private static IEnumerable<string> Tokenize(string commandLine)
    {
        foreach (var token in commandLine.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries))
        {
            yield return token.Trim('"');
        }
    }
}
