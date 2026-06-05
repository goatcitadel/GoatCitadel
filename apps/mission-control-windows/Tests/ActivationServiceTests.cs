using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace GoatCitadel.MissionControl.Windows.Tests;

[TestClass]
public sealed class ActivationServiceTests
{
    [TestMethod]
    public void ParsesGoatcitadelProtocolRoute()
    {
        var parsed = ActivationService.TryGetRouteFromProtocolUri(
            new Uri("goatcitadel://open?route=/ops/approvals&approvalId=ap-1"),
            out var route);

        Assert.IsTrue(parsed);
        Assert.AreEqual("/ops/approvals?approvalId=ap-1", route);
    }

    [DataTestMethod]
    [DataRow("https://example.com")]
    [DataRow("goatcitadel://bad?route=/ops/activity")]
    [DataRow("goatcitadel://open?route=https%3A%2F%2Fexample.com")]
    [DataRow("goatcitadel://open?route=ops/activity")]
    public void RejectsUnsupportedActivationUris(string raw)
    {
        Assert.IsFalse(ActivationService.TryGetRouteFromProtocolUri(new Uri(raw), out _));
    }
}
