using System.Text.Json;
using GoatCitadel.MissionControl.Windows.Models;

namespace GoatCitadel.MissionControl.Windows.Services;

public sealed class RuntimeStatusService
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly LauncherService _launcherService;

    public RuntimeStatusService(LauncherService launcherService)
    {
        _launcherService = launcherService;
    }

    public async Task<DesktopRuntimeStatus> LaunchAsync(CancellationToken cancellationToken = default)
    {
        var output = await _launcherService.RunAsync(new[] { "launch", "--no-open", "--json", "--wait" }, cancellationToken);
        return ParseStatus(output);
    }

    public async Task<DesktopRuntimeStatus> ReadStatusAsync(CancellationToken cancellationToken = default)
    {
        var output = await _launcherService.RunAsync(new[] { "status", "--json" }, cancellationToken);
        return ParseStatus(output);
    }

    public async Task<JsonDocument> StopAsync(CancellationToken cancellationToken = default)
    {
        var output = await _launcherService.RunAsync(new[] { "stop", "--json" }, cancellationToken);
        return JsonDocument.Parse(output);
    }

    public static DesktopRuntimeStatus ParseStatus(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<DesktopRuntimeStatus>(json, JsonOptions)
                ?? throw new InvalidOperationException("Launcher returned an empty status payload.");
        }
        catch (JsonException error)
        {
            throw new InvalidOperationException($"Launcher returned invalid JSON: {error.Message}. Output: {json}", error);
        }
    }
}
