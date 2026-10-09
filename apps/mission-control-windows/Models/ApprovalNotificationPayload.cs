namespace GoatCitadel.MissionControl.Windows.Models;

public sealed class ApprovalNotificationPayload
{
    public string ApprovalId { get; set; } = "";
    public string? WorkspaceId { get; set; }
    public string RoutePath => $"/inbox?approvalId={Uri.EscapeDataString(ApprovalId)}" +
        (string.IsNullOrWhiteSpace(WorkspaceId) ? "" : $"&workspaceId={Uri.EscapeDataString(WorkspaceId)}");
    public string? Kind { get; set; }
    public string? RiskLevel { get; set; }
    public string? Status { get; set; }
}
