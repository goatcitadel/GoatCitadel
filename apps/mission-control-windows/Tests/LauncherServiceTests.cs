using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace GoatCitadel.MissionControl.Windows.Tests;

[TestClass]
public sealed class LauncherServiceTests
{
    private string? _root;

    [TestCleanup]
    public void Cleanup()
    {
        if (_root is not null && Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }

    [TestMethod]
    public void ResolvesPackagedNodeLauncherFromGoatcitadelHome()
    {
        var root = CreateTempRoot();
        var node = Touch(Path.Combine(root, "app", "runtime", "node", "node.exe"));
        var script = Touch(Path.Combine(root, "app", "bin", "goatcitadel.mjs"));
        Touch(Path.Combine(root, "app", "release-manifest.json"));

        var service = new LauncherService(new LauncherEnvironment(
            new Dictionary<string, string?> { ["GOATCITADEL_HOME"] = root },
            currentExePath: Path.Combine(root, "app", "desktop", "GoatCitadel-Mission-Control-Windows.exe")));

        var invocation = service.ResolveLauncher();

        Assert.AreEqual(node, invocation.Program);
        Assert.AreEqual(script, invocation.ArgsPrefix.Single());
        Assert.AreEqual(root, invocation.InstallRoot);
        Assert.IsFalse(invocation.WindowsShell);
    }

    [TestMethod]
    public void ResolvesExplicitCmdLauncherWithShellExecution()
    {
        var root = CreateTempRoot();
        var launcher = Touch(Path.Combine(root, "bin", "goatcitadel.cmd"));
        var service = new LauncherService(new LauncherEnvironment(
            new Dictionary<string, string?>
            {
                ["GOATCITADEL_DESKTOP_LAUNCHER"] = launcher,
                ["GOATCITADEL_HOME"] = root,
            },
            currentExePath: Path.Combine(root, "app.exe")));

        var invocation = service.ResolveLauncher();

        Assert.AreEqual(launcher, invocation.Program);
        Assert.AreEqual(root, invocation.InstallRoot);
        Assert.IsTrue(invocation.WindowsShell);
    }

    [TestMethod]
    public void ResolvesPackagedLauncherFromDesktopExeAncestors()
    {
        var root = CreateTempRoot();
        var node = Touch(Path.Combine(root, "app", "runtime", "node", "node.exe"));
        var script = Touch(Path.Combine(root, "app", "bin", "goatcitadel.mjs"));
        Touch(Path.Combine(root, "app", "release-manifest.json"));
        var currentExe = Touch(Path.Combine(root, "app", "desktop", "GoatCitadel-Mission-Control-Windows.exe"));
        var service = new LauncherService(new LauncherEnvironment(new Dictionary<string, string?>(), currentExe));

        var invocation = service.ResolveLauncher();

        Assert.AreEqual(node, invocation.Program);
        Assert.AreEqual(script, invocation.ArgsPrefix.Single());
        Assert.AreEqual(root, invocation.InstallRoot);
        Assert.IsFalse(invocation.WindowsShell);
    }

    [TestMethod]
    public void PreservesExplicitAppDirForPackagedNodeLauncher()
    {
        var root = CreateTempRoot();
        var appDir = Path.Combine(root, "custom-app");
        Touch(Path.Combine(root, "app", "runtime", "node", "node.exe"));
        Touch(Path.Combine(root, "app", "bin", "goatcitadel.mjs"));
        var service = new LauncherService(new LauncherEnvironment(
            new Dictionary<string, string?>
            {
                ["GOATCITADEL_HOME"] = root,
                ["GOATCITADEL_APP_DIR"] = appDir,
            },
            currentExePath: Path.Combine(root, "app", "desktop", "GoatCitadel-Mission-Control-Windows.exe")));

        var invocation = service.ResolveLauncher();

        Assert.AreEqual(appDir, invocation.AppDir);
    }

    [TestMethod]
    public void ResolvesSourceCheckoutLauncherFromCurrentExeAncestors()
    {
        var root = CreateTempRoot();
        var sourceLauncher = Touch(Path.Combine(root, "bin", "goatcitadel.mjs"));
        var currentExe = Touch(Path.Combine(root, "tools", "desktop", "host.exe"));
        var service = new LauncherService(new LauncherEnvironment(
            new Dictionary<string, string?>(),
            currentExePath: currentExe));

        var invocation = service.ResolveLauncher();

        Assert.AreEqual("node", invocation.Program);
        Assert.AreEqual(sourceLauncher, invocation.ArgsPrefix.Single());
        Assert.AreEqual(root, invocation.InstallRoot);
    }

    [TestMethod]
    public void MissingLauncherFailsWithOperatorReadableMessage()
    {
        var root = CreateTempRoot();
        var service = new LauncherService(new LauncherEnvironment(
            new Dictionary<string, string?>(),
            currentExePath: Path.Combine(root, "host.exe")));

        var error = Assert.ThrowsException<InvalidOperationException>(() => service.ResolveLauncher());
        StringAssert.Contains(error.Message, "Unable to locate GoatCitadel launcher");
    }

    [TestMethod]
    public void QuotesWindowsCommandArgumentsWithShellMetacharacters()
    {
        Assert.AreEqual("plain", LauncherService.QuoteWindowsCommandArg("plain"));
        Assert.AreEqual("\"with space\"", LauncherService.QuoteWindowsCommandArg("with space"));
        Assert.AreEqual("\"a&b\"", LauncherService.QuoteWindowsCommandArg("a&b"));
        Assert.AreEqual("\"\"", LauncherService.QuoteWindowsCommandArg(""));
    }

    private string CreateTempRoot()
    {
        _root = Path.Combine(Path.GetTempPath(), $"goatcitadel-windows-host-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_root);
        return _root;
    }

    private static string Touch(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, "");
        return Path.GetFullPath(path);
    }
}
