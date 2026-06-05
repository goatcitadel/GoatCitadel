using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace GoatCitadel.MissionControl.Windows.Tests;

[TestClass]
public sealed class NavigationPolicyTests
{
    [DataTestMethod]
    [DataRow("http://127.0.0.1:5173/chat")]
    [DataRow("https://localhost:8787/status")]
    [DataRow("http://[::1]:5173/")]
    public void AllowsLoopbackHttpTargets(string target)
    {
        Assert.IsTrue(NavigationPolicy.TryValidateBrowserTarget(target, out _, out var error), error);
    }

    [DataTestMethod]
    [DataRow("file:///C:/Windows/System32/calc.exe")]
    [DataRow("https://example.com")]
    [DataRow("http://user:pass@127.0.0.1:5173")]
    [DataRow("goatcitadel://open?route=/ops/activity")]
    public void RejectsExternalOrUnsafeTargets(string target)
    {
        Assert.IsFalse(NavigationPolicy.TryValidateBrowserTarget(target, out _, out _));
    }

    [DataTestMethod]
    [DataRow("/ops/activity")]
    [DataRow("/ops/approvals?approvalId=ap-1")]
    public void AllowsLocalRoutes(string route)
    {
        Assert.IsTrue(NavigationPolicy.IsAllowedLocalRoute(route));
    }

    [DataTestMethod]
    [DataRow("https://example.com")]
    [DataRow("//example.com")]
    [DataRow("ops/activity")]
    public void RejectsNonLocalRoutes(string route)
    {
        Assert.IsFalse(NavigationPolicy.IsAllowedLocalRoute(route));
    }
}
