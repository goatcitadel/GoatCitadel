using System.Text.Json.Serialization;

namespace GoatCitadel.MissionControl.Windows.Models;

public sealed class DesktopRuntimeStatus
{
    [JsonPropertyName("status")]
    public string Status { get; set; } = "stopped";

    [JsonPropertyName("gatewayUrl")]
    public string GatewayUrl { get; set; } = "";

    [JsonPropertyName("uiUrl")]
    public string UiUrl { get; set; } = "";

    [JsonPropertyName("targetUrl")]
    public string TargetUrl { get; set; } = "";

    [JsonPropertyName("packaged")]
    public bool Packaged { get; set; }

    [JsonPropertyName("runtimeRoot")]
    public string RuntimeRoot { get; set; } = "";

    [JsonPropertyName("runtimeStateDir")]
    public string RuntimeStateDir { get; set; } = "";

    [JsonPropertyName("pidFiles")]
    public RuntimePidFiles PidFiles { get; set; } = new();

    [JsonPropertyName("pids")]
    public RuntimePids Pids { get; set; } = new();

    [JsonPropertyName("logFiles")]
    public RuntimeLogFiles LogFiles { get; set; } = new();

    [JsonPropertyName("readiness")]
    public RuntimeReadiness Readiness { get; set; } = new();

    [JsonPropertyName("onboardingCompleted")]
    public bool OnboardingCompleted { get; set; }

    [JsonPropertyName("desktopEventStream")]
    public DesktopEventStreamCredential? DesktopEventStream { get; set; }

    [JsonPropertyName("checkedAt")]
    public string CheckedAt { get; set; } = "";

    [JsonIgnore]
    public bool IsReady => Status == "ready" && Readiness.Gateway && Readiness.Ui;
}

public sealed class ManagedPidInfo
{
    [JsonPropertyName("pid")]
    public uint? Pid { get; set; }

    [JsonPropertyName("state")]
    public string State { get; set; } = "missing";

    [JsonPropertyName("raw")]
    public string? Raw { get; set; }
}

public sealed class RuntimeReadiness
{
    [JsonPropertyName("gateway")]
    public bool Gateway { get; set; }

    [JsonPropertyName("ui")]
    public bool Ui { get; set; }
}

public sealed class RuntimePidFiles
{
    [JsonPropertyName("gateway")]
    public string Gateway { get; set; } = "";

    [JsonPropertyName("ui")]
    public string Ui { get; set; } = "";
}

public sealed class RuntimePids
{
    [JsonPropertyName("gateway")]
    public ManagedPidInfo Gateway { get; set; } = new();

    [JsonPropertyName("ui")]
    public ManagedPidInfo Ui { get; set; } = new();
}

public sealed class RuntimeLogFiles
{
    [JsonPropertyName("gatewayStdout")]
    public string GatewayStdout { get; set; } = "";

    [JsonPropertyName("gatewayStderr")]
    public string GatewayStderr { get; set; } = "";

    [JsonPropertyName("missionControlStdout")]
    public string MissionControlStdout { get; set; } = "";

    [JsonPropertyName("missionControlStderr")]
    public string MissionControlStderr { get; set; } = "";
}
