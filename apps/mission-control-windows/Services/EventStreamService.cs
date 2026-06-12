using System.Text.Json;
using System.Text.Json.Nodes;
using GoatCitadel.MissionControl.Windows.Models;

namespace GoatCitadel.MissionControl.Windows.Services;

public sealed class EventStreamService
{
    private readonly RuntimeStatusService _runtimeStatusService;
    private readonly Func<HttpClient> _clientFactory;

    public EventStreamService(RuntimeStatusService runtimeStatusService, Func<HttpClient>? clientFactory = null)
    {
        _runtimeStatusService = runtimeStatusService;
        _clientFactory = clientFactory ?? (() => new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(75),
        });
    }

    public event Action<ApprovalNotificationPayload>? ApprovalCreated;
    public event Action<OperatorAttentionPayload>? OperatorAttention;
    public event Action<string, string>? WatcherError;

    public async Task RunAsync(DesktopRuntimeStatus runtime, CancellationToken cancellationToken)
    {
        if (!runtime.IsReady)
        {
            return;
        }

        var gatewayUrl = runtime.GatewayUrl;
        var token = runtime.DesktopEventStream?.Token;
        if (!string.IsNullOrWhiteSpace(runtime.DesktopEventStream?.Error))
        {
            WatcherError?.Invoke("desktop_sse_token_unavailable", runtime.DesktopEventStream.Error);
        }

        using var client = _clientFactory();
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                using var response = await client.GetAsync(
                    BuildEventStreamUrl(gatewayUrl, token),
                    HttpCompletionOption.ResponseHeadersRead,
                    cancellationToken);

                if (!response.IsSuccessStatusCode)
                {
                    if ((int)response.StatusCode is 401 or 403)
                    {
                        token = await RefreshDesktopEventStreamTokenAsync(gatewayUrl, cancellationToken);
                        WatcherError?.Invoke(
                            "desktop_sse_auth_failed",
                            "Desktop approval notifications could not authenticate to the gateway event stream.");
                    }

                    await DelayOrCancel(TimeSpan.FromSeconds(10), cancellationToken);
                    continue;
                }

                await ReadSseAsync(response, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (HttpRequestException error)
            {
                await HandleStreamFailureAsync(error, cancellationToken);
            }
            catch (IOException error)
            {
                await HandleStreamFailureAsync(error, cancellationToken);
            }
            catch (InvalidOperationException error)
            {
                await HandleStreamFailureAsync(error, cancellationToken);
            }
            catch (JsonException error)
            {
                await HandleStreamFailureAsync(error, cancellationToken);
            }
            catch (TaskCanceledException error)
            {
                await HandleStreamFailureAsync(error, cancellationToken);
            }
            catch (UriFormatException error)
            {
                await HandleStreamFailureAsync(error, cancellationToken);
            }
        }
    }

    public static string BuildEventStreamUrl(string gatewayUrl, string? token)
    {
        var url = $"{gatewayUrl.TrimEnd('/')}/api/v1/events/stream?replay=0";
        return string.IsNullOrWhiteSpace(token) ? url : $"{url}&sse_token={Uri.EscapeDataString(token)}";
    }

    public static bool TryParseApprovalNotification(string data, out ApprovalNotificationPayload payload)
    {
        payload = new ApprovalNotificationPayload();
        var root = ParseObject(data);
        if (root is null || root["eventType"]?.GetValue<string>() != "approval_created")
        {
            return false;
        }

        var eventPayload = root["payload"]?.AsObject();
        var approvalId =
            eventPayload?["approvalId"]?.GetValue<string>() ??
            root["links"]?["approvalId"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(approvalId))
        {
            return false;
        }

        payload = new ApprovalNotificationPayload
        {
            ApprovalId = approvalId,
            Kind = eventPayload?["kind"]?.GetValue<string>(),
            RiskLevel = eventPayload?["riskLevel"]?.GetValue<string>(),
            Status = eventPayload?["status"]?.GetValue<string>(),
        };
        return true;
    }

    public static bool TryParseOperatorAttentionNotification(string data, out OperatorAttentionPayload payload)
    {
        payload = new OperatorAttentionPayload();
        var root = ParseObject(data);
        if (root is null)
        {
            return false;
        }

        var eventType = root["eventType"]?.GetValue<string>()?.ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(eventType) || eventType == "approval_created")
        {
            return false;
        }

        var eventPayload = root["payload"]?.AsObject();
        var payloadEvent = eventPayload?["event"]?.GetValue<string>()?.ToLowerInvariant() ?? "";
        var payloadStatus = eventPayload?["status"]?.GetValue<string>()?.ToLowerInvariant() ?? "";
        var signal = $"{eventType} {payloadEvent} {payloadStatus}";

        if (signal.Contains("run_completed", StringComparison.Ordinal) ||
            signal.Contains("run.completed", StringComparison.Ordinal) ||
            signal.Contains("run.stopped", StringComparison.Ordinal) ||
            signal.Contains("run_stopped", StringComparison.Ordinal) ||
            (IsRunLikeSignal(signal) && signal.Contains("completed", StringComparison.Ordinal)))
        {
            payload = new OperatorAttentionPayload
            {
                Title = "GoatCitadel run completed",
                Body = "Results are ready to review.",
                RoutePath = "/ops/activity",
            };
            return true;
        }

        if (signal.Contains("run_failed", StringComparison.Ordinal) ||
            signal.Contains("run.failed", StringComparison.Ordinal) ||
            IsRuntimeDegradedSignal(signal) ||
            (IsRunLikeSignal(signal) &&
             (signal.Contains("failed", StringComparison.Ordinal) ||
              signal.Contains("failure", StringComparison.Ordinal) ||
              signal.Contains("error", StringComparison.Ordinal) ||
              signal.Contains("critical", StringComparison.Ordinal))))
        {
            payload = new OperatorAttentionPayload
            {
                Title = "GoatCitadel needs attention",
                Body = "A run or runtime signal needs operator review.",
                RoutePath = "/ops/notifications",
            };
            return true;
        }

        if (signal.Contains("paused_for_approval", StringComparison.Ordinal) ||
            signal.Contains("waiting_for_operator", StringComparison.Ordinal) ||
            (IsRunLikeSignal(signal) &&
             (signal.Contains("blocked", StringComparison.Ordinal) ||
              signal.Contains("requires_operator", StringComparison.Ordinal))))
        {
            payload = new OperatorAttentionPayload
            {
                Title = "GoatCitadel is waiting",
                Body = "Work is paused until the operator responds.",
                RoutePath = "/ops/approvals",
            };
            return true;
        }

        return false;
    }

    private async Task ReadSseAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var reader = new StreamReader(stream);
        var dataLines = new List<string>();
        while (!cancellationToken.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(cancellationToken);
            if (line is null)
            {
                break;
            }

            if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                dataLines.Add(line["data:".Length..].TrimStart());
                continue;
            }

            if (line.Trim().Length == 0 && dataLines.Count > 0)
            {
                DispatchEvent(string.Join("\n", dataLines));
                dataLines.Clear();
            }
        }
    }

    private void DispatchEvent(string data)
    {
        if (TryParseApprovalNotification(data, out var approval))
        {
            ApprovalCreated?.Invoke(approval);
            return;
        }

        if (TryParseOperatorAttentionNotification(data, out var attention))
        {
            OperatorAttention?.Invoke(attention);
        }
    }

    private async Task<string?> RefreshDesktopEventStreamTokenAsync(string gatewayUrl, CancellationToken cancellationToken)
    {
        var status = await _runtimeStatusService.ReadStatusAsync(cancellationToken);
        return TrimTrailingSlash(status.GatewayUrl) == TrimTrailingSlash(gatewayUrl)
            ? status.DesktopEventStream?.Token
            : null;
    }

    private static JsonObject? ParseObject(string data)
    {
        try
        {
            return JsonNode.Parse(data)?.AsObject();
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static bool IsRunLikeSignal(string signal) =>
        signal.Contains("run_", StringComparison.Ordinal) ||
        signal.Contains("run.", StringComparison.Ordinal) ||
        signal.Contains("orchestration", StringComparison.Ordinal) ||
        signal.Contains("durable", StringComparison.Ordinal) ||
        signal.Contains("code_mode", StringComparison.Ordinal);

    private static bool IsRuntimeDegradedSignal(string signal) =>
        signal.Contains("degraded", StringComparison.Ordinal) ||
        signal.Contains("provider_failed", StringComparison.Ordinal) ||
        signal.Contains("gateway_failed", StringComparison.Ordinal) ||
        signal.Contains("health_failed", StringComparison.Ordinal) ||
        signal.Contains("daemon_stopped", StringComparison.Ordinal);

    private static string TrimTrailingSlash(string value) => value.TrimEnd('/');

    private async Task HandleStreamFailureAsync(Exception error, CancellationToken cancellationToken)
    {
        WatcherError?.Invoke("desktop_sse_stream_failed", error.Message);
        await DelayOrCancel(TimeSpan.FromSeconds(5), cancellationToken);
    }

    private static async Task DelayOrCancel(TimeSpan duration, CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(duration, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
    }
}
