using System.Text.Json.Serialization;

namespace GoatCitadel.MissionControl.Windows.Models;

public sealed class DesktopEventStreamCredential
{
    [JsonPropertyName("scope")]
    public string? Scope { get; set; }

    [JsonPropertyName("token")]
    public string? Token { get; set; }

    [JsonPropertyName("expiresAt")]
    public string? ExpiresAt { get; set; }

    [JsonPropertyName("authMode")]
    public string? AuthMode { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }
}
