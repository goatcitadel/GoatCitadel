using GoatCitadel.MissionControl.Windows.Models;
using Microsoft.Windows.AppNotifications;

namespace GoatCitadel.MissionControl.Windows.Services;

public sealed class NotificationService : IDisposable
{
    private readonly Action<string> _routeHandler;
    private readonly Action<string> _fallbackToast;
    private bool _registered;

    public NotificationService(Action<string> routeHandler, Action<string> fallbackToast)
    {
        _routeHandler = routeHandler;
        _fallbackToast = fallbackToast;
    }

    public void Initialize()
    {
        try
        {
            if (!AppNotificationManager.IsSupported())
            {
                _fallbackToast("Windows app notifications are not available for this host.");
                return;
            }

            var manager = AppNotificationManager.Default;
            manager.NotificationInvoked += OnNotificationInvoked;
            manager.Register();
            _registered = true;
        }
        catch (Exception error)
        {
            _fallbackToast($"Windows notification registration failed: {error.Message}");
        }
    }

    public void ShowApproval(ApprovalNotificationPayload payload)
    {
        var route = $"/ops/approvals?approvalId={Uri.EscapeDataString(payload.ApprovalId)}";
        var body = $"{payload.Kind ?? "Approval"}{(string.IsNullOrWhiteSpace(payload.RiskLevel) ? "" : $" / {payload.RiskLevel}")}";
        Show("GoatCitadel approval waiting", body, route);
    }

    public void ShowOperatorAttention(OperatorAttentionPayload payload) =>
        Show(payload.Title, payload.Body, payload.RoutePath ?? "/ops/notifications");

    public void Dispose()
    {
        if (!_registered)
        {
            return;
        }

        try
        {
            var manager = AppNotificationManager.Default;
            manager.NotificationInvoked -= OnNotificationInvoked;
            manager.Unregister();
        }
        catch
        {
            // Notification teardown should never block app shutdown.
        }
    }

    private void Show(string title, string body, string route)
    {
        if (!NavigationPolicy.IsAllowedLocalRoute(route))
        {
            _fallbackToast("Notification route was rejected by the local navigation policy.");
            return;
        }

        try
        {
            if (!_registered || !AppNotificationManager.IsSupported())
            {
                _fallbackToast($"{title}: {body}");
                return;
            }

            var launch = $"route={Uri.EscapeDataString(route)}";
            var xml =
                $"""
                <toast launch="{EscapeXml(launch)}">
                  <visual>
                    <binding template="ToastGeneric">
                      <text>{EscapeXml(title)}</text>
                      <text>{EscapeXml(body)}</text>
                    </binding>
                  </visual>
                </toast>
                """;
            AppNotificationManager.Default.Show(new AppNotification(xml));
        }
        catch (Exception error)
        {
            _fallbackToast($"Notification fallback: {title}. {error.Message}");
        }
    }

    private void OnNotificationInvoked(AppNotificationManager sender, AppNotificationActivatedEventArgs args)
    {
        var values = ParseLaunchArguments(args.Argument);
        if (values.TryGetValue("route", out var route) && NavigationPolicy.IsAllowedLocalRoute(route))
        {
            _routeHandler(route);
        }
    }

    private static Dictionary<string, string> ParseLaunchArguments(string raw)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pair in raw.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split('=', 2);
            var key = Uri.UnescapeDataString(parts[0]);
            var value = parts.Length > 1 ? Uri.UnescapeDataString(parts[1]) : "";
            result[key] = value;
        }

        return result;
    }

    private static string EscapeXml(string value) =>
        value
            .Replace("&", "&amp;", StringComparison.Ordinal)
            .Replace("\"", "&quot;", StringComparison.Ordinal)
            .Replace("<", "&lt;", StringComparison.Ordinal)
            .Replace(">", "&gt;", StringComparison.Ordinal);
}
