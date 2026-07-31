using Microsoft.Windows.AppLifecycle;
using Windows.ApplicationModel.Activation;

namespace GoatCitadel.MissionControl.Windows.Services;

public static class ActivationService
{
    private static readonly object Gate = new();
    private static readonly ActivationDeliveryQueue DeliveryQueue = new();
    private static Action? focusHandler;

    public static void SetInitialActivationArguments(AppActivationArguments args) =>
        QueueRouteFromActivation(args);

    public static void HandleActivation(AppActivationArguments args)
    {
        focusHandler?.Invoke();
        QueueRouteFromActivation(args);
    }

    public static void RegisterWindow(
        Action<string> routeAction,
        Action focusAction,
        Action<string> diagnosticAction)
    {
        DeliveryQueue.Register(routeAction, diagnosticAction);
        lock (Gate)
        {
            focusHandler = focusAction;
        }
    }

    public static void FlushPendingActivation() => DeliveryQueue.FlushPending();

    public static bool TryGetRouteFromProtocolUri(Uri uri, out string route)
        => ActivationRouteParser.TryGetRouteFromProtocolUri(uri, out route);

    private static void QueueRouteFromActivation(AppActivationArguments args)
    {
        DeliveryQueue.Enqueue(ResolveActivation(args));
    }

    private static ActivationDelivery ResolveActivation(AppActivationArguments args)
    {
        if (args.Kind != ExtendedActivationKind.Protocol)
        {
            return ResolveLaunchActivation(args);
        }

        if (args.Data is IProtocolActivatedEventArgs protocolArgs)
        {
            return ActivationRequestResolver.ResolveProtocolUri(protocolArgs.Uri);
        }

        var uriProperty = args.Data?.GetType().GetProperty("Uri");
        return ActivationRequestResolver.ResolveProtocolUri(uriProperty?.GetValue(args.Data) as Uri);
    }

    // Non-MSIX installs route goatcitadel:// deep links through the HKCU shell\open\command
    // registration, which arrives as a raw Launch-kind activation rather than Protocol-kind.
    private static ActivationDelivery ResolveLaunchActivation(AppActivationArguments args)
    {
        if (args.Kind != ExtendedActivationKind.Launch)
        {
            return ActivationDelivery.None;
        }

        var launchArguments = (args.Data as ILaunchActivatedEventArgs)?.Arguments;
        var argumentsProperty = args.Data?.GetType().GetProperty("Arguments");
        var reflectedArguments = argumentsProperty?.GetValue(args.Data) as string;
        return ActivationRequestResolver.ResolveLaunchArguments(
            launchArguments,
            reflectedArguments,
            Environment.CommandLine);
    }
}
