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

    internal static ActivationDelivery ResolveNotificationArguments(string arguments)
    {
        string? route = null;
        foreach (var pair in arguments.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split('=', 2);
            if (string.Equals(Uri.UnescapeDataString(parts[0]), "route", StringComparison.OrdinalIgnoreCase))
            {
                route = parts.Length == 2 ? Uri.UnescapeDataString(parts[1]) : null;
            }
        }

        return route is not null && NavigationPolicy.IsAllowedLocalRoute(route)
            ? ActivationDelivery.ForRoute(route)
            : ActivationDelivery.None;
    }

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
    private readonly Queue<ActivationDelivery> pending = new();
    private Action<string>? routeHandler;
    private Action<string>? diagnosticHandler;
    private bool deliveryEnabled;
    private bool draining;

    internal void Register(Action<string> routeAction, Action<string> diagnosticAction)
    {
        lock (gate)
        {
            routeHandler = routeAction;
            diagnosticHandler = diagnosticAction;
            // A startup backlog belongs to the explicit flush after window activation.
            deliveryEnabled |= pending.Count == 0;
        }
    }

    internal void Enqueue(ActivationDelivery delivery)
    {
        if (delivery.Route is null && delivery.Diagnostic is null)
        {
            return;
        }

        lock (gate)
        {
            pending.Enqueue(delivery);
            if (!deliveryEnabled || draining)
            {
                return;
            }
            draining = true;
        }

        Drain();
    }

    internal void FlushPending()
    {
        lock (gate)
        {
            if (routeHandler is null || diagnosticHandler is null)
            {
                return;
            }

            deliveryEnabled = true;
            if (draining)
            {
                return;
            }
            draining = true;
        }

        Drain();
    }

    private void Drain()
    {
        try
        {
            while (true)
            {
                ActivationDelivery delivery;
                Action<string> handler;
                lock (gate)
                {
                    if (!pending.TryDequeue(out delivery))
                    {
                        draining = false;
                        return;
                    }
                    handler = delivery.Route is not null ? routeHandler! : diagnosticHandler!;
                }

                // A callback can enqueue more work. Keep it outside the lock and
                // let the same drainer deliver any new arrivals in order.
                handler(delivery.Route ?? delivery.Diagnostic!);
            }
        }
        catch
        {
            lock (gate)
            {
                draining = false;
            }
            throw;
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
