using Microsoft.Windows.AppLifecycle;
using Windows.ApplicationModel.Activation;

namespace GoatCitadel.MissionControl.Windows.Services;

public static class ActivationService
{
    private static readonly object Gate = new();
    private static readonly List<string> PendingRoutes = new();
    private static Action<string>? routeHandler;
    private static Action? focusHandler;

    public static void SetInitialActivationArguments(AppActivationArguments args) =>
        QueueRouteFromActivation(args);

    public static void HandleActivation(AppActivationArguments args)
    {
        focusHandler?.Invoke();
        QueueRouteFromActivation(args);
    }

    public static void RegisterWindow(Action<string> routeAction, Action focusAction)
    {
        lock (Gate)
        {
            routeHandler = routeAction;
            focusHandler = focusAction;
        }
    }

    public static void FlushPendingActivation()
    {
        List<string> routes;
        Action<string>? handler;
        lock (Gate)
        {
            routes = PendingRoutes.ToList();
            PendingRoutes.Clear();
            handler = routeHandler;
        }

        foreach (var route in routes)
        {
            handler?.Invoke(route);
        }
    }

    public static bool TryGetRouteFromProtocolUri(Uri uri, out string route)
    {
        route = "";
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
            !route.Contains("approvalId=", StringComparison.Ordinal))
        {
            route += route.Contains('?') ? "&" : "?";
            route += $"approvalId={Uri.EscapeDataString(approvalId)}";
        }

        return true;
    }

    private static void QueueRouteFromActivation(AppActivationArguments args)
    {
        if (!TryGetRouteFromActivation(args, out var route))
        {
            return;
        }

        Action<string>? handler;
        lock (Gate)
        {
            handler = routeHandler;
            if (handler is null)
            {
                PendingRoutes.Add(route);
                return;
            }
        }

        handler(route);
    }

    private static bool TryGetRouteFromActivation(AppActivationArguments args, out string route)
    {
        route = "";
        if (args.Kind != ExtendedActivationKind.Protocol)
        {
            return false;
        }

        if (args.Data is IProtocolActivatedEventArgs protocolArgs)
        {
            return TryGetRouteFromProtocolUri(protocolArgs.Uri, out route);
        }

        var uriProperty = args.Data?.GetType().GetProperty("Uri");
        return uriProperty?.GetValue(args.Data) is Uri uri && TryGetRouteFromProtocolUri(uri, out route);
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
