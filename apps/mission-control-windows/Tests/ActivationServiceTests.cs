using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace GoatCitadel.MissionControl.Windows.Tests;

[TestClass]
public sealed class ActivationServiceTests
{
    [TestMethod]
    public void ParsesGoatcitadelProtocolRoute()
    {
        var parsed = ActivationRouteParser.TryGetRouteFromProtocolUri(
            new Uri("goatcitadel://open?route=/ops/approvals&approvalId=ap-1"),
            out var route);

        Assert.IsTrue(parsed);
        Assert.AreEqual("/ops/approvals?approvalId=ap-1", route);
    }

    [TestMethod]
    public void RejectsNullProtocolRoute()
    {
        var parsed = ActivationRouteParser.TryGetRouteFromProtocolUri(null, out var route);

        Assert.IsFalse(parsed);
        Assert.AreEqual("", route);
    }

    [TestMethod]
    public void DoesNotDuplicateExistingApprovalIdWithDifferentCasing()
    {
        var parsed = ActivationRouteParser.TryGetRouteFromProtocolUri(
            new Uri("goatcitadel://open?route=/ops/approvals%3FApprovalId%3Dap-1&approvalId=ap-2"),
            out var route);

        Assert.IsTrue(parsed);
        Assert.AreEqual("/ops/approvals?ApprovalId=ap-1", route);
    }

    [DataTestMethod]
    [DataRow("https://example.com")]
    [DataRow("goatcitadel://bad?route=/ops/activity")]
    [DataRow("goatcitadel://open?route=https%3A%2F%2Fexample.com")]
    [DataRow("goatcitadel://open?route=ops/activity")]
    public void RejectsUnsupportedActivationUris(string raw)
    {
        Assert.IsFalse(ActivationRouteParser.TryGetRouteFromProtocolUri(new Uri(raw), out _));
    }

    [DataTestMethod]
    [DataRow("\"C:\\Program Files\\GoatCitadel\\app.exe\" \"goatcitadel://open?route=/ops/approvals&approvalId=ap-9\"")]
    [DataRow("app.exe goatcitadel://open?route=/ops/approvals&approvalId=ap-9")]
    [DataRow("app.exe goatcitadel://bad?route=/ops/activity goatcitadel://open?route=/ops/approvals&approvalId=ap-9")]
    public void ParsesGoatcitadelRouteFromRawLaunchArguments(string commandLine)
    {
        var parsed = ActivationRouteParser.TryGetRouteFromCommandLineArguments(commandLine, out var route);

        Assert.IsTrue(parsed);
        Assert.AreEqual("/ops/approvals?approvalId=ap-9", route);
    }

    [DataTestMethod]
    [DataRow("")]
    [DataRow("   ")]
    [DataRow("\"C:\\app.exe\"")]
    [DataRow("app.exe --some-flag")]
    [DataRow("app.exe https://example.com")]
    [DataRow("app.exe goatcitadel://open?route=ops/activity")]
    public void RejectsLaunchArgumentsWithoutValidDeepLink(string? commandLine)
    {
        Assert.IsFalse(ActivationRouteParser.TryGetRouteFromCommandLineArguments(commandLine, out var route));
        Assert.AreEqual("", route);
    }
}
