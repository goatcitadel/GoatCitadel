namespace GoatCitadel.MissionControl.Windows.Models;

public sealed class ApprovalNotificationPayload
{
    public string ApprovalId { get; set; } = "";
    public string? Kind { get; set; }
    public string? RiskLevel { get; set; }
    public string? Status { get; set; }
}
