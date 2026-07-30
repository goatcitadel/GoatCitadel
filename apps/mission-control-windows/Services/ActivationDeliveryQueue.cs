namespace GoatCitadel.MissionControl.Windows.Services;

internal readonly record struct ActivationDelivery(string? Route, string? Diagnostic)
{
    internal static ActivationDelivery None => default;

    internal static ActivationDelivery ForRoute(string route) => new(route, null);

    internal static ActivationDelivery ForDiagnostic(string diagnostic) => new(null, diagnostic);
}

internal static class ActivationRequestResolver
{
    // Activation input is attacker-controlled and can contain credentials. Keep the operator
    // diagnostic useful but generic instead of echoing a rejected URI or command-line token.
    internal const string RejectedActivationMessage =
        "GoatCitadel ignored an invalid or unsafe activation link.";

    internal static ActivationDelivery ResolveProtocolUri(Uri? uri) =>
        ActivationRouteParser.TryGetRouteFromProtocolUri(uri, out var route)
            ? ActivationDelivery.ForRoute(route)
            : ActivationDelivery.ForDiagnostic(RejectedActivationMessage);

    internal static ActivationDelivery ResolveLaunchArguments(params string?[] commandLines)
    {
        foreach (var commandLine in commandLines)
        {
            if (ActivationRouteParser.TryGetRouteFromCommandLineArguments(commandLine, out var route))
            {
                return ActivationDelivery.ForRoute(route);
            }
        }

        return commandLines.Any(ActivationRouteParser.ContainsGoatcitadelProtocolToken)
            ? ActivationDelivery.ForDiagnostic(RejectedActivationMessage)
            : ActivationDelivery.None;
    }
}

internal sealed class ActivationDeliveryQueue
{
    private readonly object gate = new();
    private readonly List<ActivationDelivery> pending = new();
    private Action<string>? routeHandler;
    private Action<string>? diagnosticHandler;

    internal void Register(Action<string> routeAction, Action<string> diagnosticAction)
    {
        lock (gate)
        {
            routeHandler = routeAction;
            diagnosticHandler = diagnosticAction;
        }
    }

    internal void Enqueue(ActivationDelivery delivery)
    {
        if (delivery.Route is null && delivery.Diagnostic is null)
        {
            return;
        }

        Action<string>? handler;
        string payload;
        lock (gate)
        {
            handler = delivery.Route is not null ? routeHandler : diagnosticHandler;
            payload = delivery.Route ?? delivery.Diagnostic!;
            if (handler is null)
            {
                pending.Add(delivery);
                return;
            }
        }

        handler(payload);
    }

    internal void FlushPending()
    {
        List<ActivationDelivery> deliveries;
        Action<string>? registeredRouteHandler;
        Action<string>? registeredDiagnosticHandler;
        lock (gate)
        {
            if (routeHandler is null || diagnosticHandler is null)
            {
                return;
            }

            deliveries = pending.ToList();
            pending.Clear();
            registeredRouteHandler = routeHandler;
            registeredDiagnosticHandler = diagnosticHandler;
        }

        foreach (var delivery in deliveries)
        {
            if (delivery.Route is not null)
            {
                registeredRouteHandler(delivery.Route);
            }
            else if (delivery.Diagnostic is not null)
            {
                registeredDiagnosticHandler(delivery.Diagnostic);
            }
        }
    }
}

/// <summary>
/// Retains the latest validated local route until the runtime and WebView can
/// actually consume it. Protocol activations and notification clicks can arrive
/// while a cold-start launch or restart is still in progress; acknowledging and
/// dropping them would make a registered deep link look successful while doing
/// nothing. The most recent operator intent wins when several links arrive.
/// </summary>
internal sealed class DeferredRouteDeliveryQueue
{
    private string? pendingRoute;
    private bool deliveryReady;

    internal string? PendingRoute => pendingRoute;

    internal void MarkUnavailable() => deliveryReady = false;

    internal void MarkReady() => deliveryReady = true;

    internal bool Submit(string route, Func<string, bool> tryDeliver)
    {
        pendingRoute = route;
        if (!deliveryReady || !tryDeliver(route))
        {
            return false;
        }

        pendingRoute = null;
        return true;
    }

    internal bool Flush(Func<string, bool> tryDeliver)
    {
        var route = pendingRoute;
        if (!deliveryReady || route is null || !tryDeliver(route))
        {
            return false;
        }

        pendingRoute = null;
        return true;
    }
}
