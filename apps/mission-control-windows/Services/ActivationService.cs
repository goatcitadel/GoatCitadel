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
        => ActivationRouteParser.TryGetRouteFromProtocolUri(uri, out route);

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
            return TryGetRouteFromLaunchArguments(args, out route);
        }

        if (args.Data is IProtocolActivatedEventArgs protocolArgs)
        {
            return TryGetRouteFromProtocolUri(protocolArgs.Uri, out route);
        }

        var uriProperty = args.Data?.GetType().GetProperty("Uri");
        return uriProperty?.GetValue(args.Data) is Uri uri && TryGetRouteFromProtocolUri(uri, out route);
    }

    // Non-MSIX installs route goatcitadel:// deep links through the HKCU shell\open\command
    // registration, which arrives as a raw Launch-kind activation rather than Protocol-kind.
    private static bool TryGetRouteFromLaunchArguments(AppActivationArguments args, out string route)
    {
        route = "";
        if (args.Kind != ExtendedActivationKind.Launch)
        {
            return false;
        }

        if (args.Data is ILaunchActivatedEventArgs launchArgs &&
            ActivationRouteParser.TryGetRouteFromCommandLineArguments(launchArgs.Arguments, out route))
        {
            return true;
        }

        var argumentsProperty = args.Data?.GetType().GetProperty("Arguments");
        if (argumentsProperty?.GetValue(args.Data) is string rawArguments &&
            ActivationRouteParser.TryGetRouteFromCommandLineArguments(rawArguments, out route))
        {
            return true;
        }

        return ActivationRouteParser.TryGetRouteFromCommandLineArguments(
            Environment.CommandLine,
            out route);
    }

}
