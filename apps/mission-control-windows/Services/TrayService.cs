using System.Drawing;
using System.Windows.Forms;

namespace GoatCitadel.MissionControl.Windows.Services;

public sealed class TrayActions
{
    public required Action OpenMissionControl { get; init; }
    public required Action OpenInBrowser { get; init; }
    public required Action RuntimeStatus { get; init; }
    public required Action RestartRuntime { get; init; }
    public required Action StopRuntime { get; init; }
    public required Action OpenLogs { get; init; }
    public required Action OpenInstallFolder { get; init; }
    public required Action Quit { get; init; }
}

public sealed class TrayService : IDisposable
{
    private readonly Dictionary<int, Action> _menuActions = new();
    private NotifyIcon? _notifyIcon;
    private ContextMenuStrip? _contextMenu;

    public void Initialize(TrayActions actions)
    {
        Dispose();
        _menuActions.Clear();
        _menuActions[1001] = actions.OpenMissionControl;
        _menuActions[1002] = actions.OpenInBrowser;
        _menuActions[1003] = actions.RuntimeStatus;
        _menuActions[1004] = actions.RestartRuntime;
        _menuActions[1005] = actions.StopRuntime;
        _menuActions[1006] = actions.OpenLogs;
        _menuActions[1007] = actions.OpenInstallFolder;
        _menuActions[1008] = actions.Quit;

        _contextMenu = BuildContextMenu();
        _notifyIcon = new NotifyIcon
        {
            ContextMenuStrip = _contextMenu,
            Icon = SystemIcons.Application,
            Text = "GoatCitadel Mission Control",
            Visible = true,
        };
        _notifyIcon.MouseClick += OnNotifyIconMouseClick;
    }

    public void Dispose()
    {
        if (_notifyIcon is not null)
        {
            _notifyIcon.MouseClick -= OnNotifyIconMouseClick;
            _notifyIcon.Visible = false;
            _notifyIcon.Dispose();
            _notifyIcon = null;
        }

        if (_contextMenu is not null)
        {
            _contextMenu.Dispose();
            _contextMenu = null;
        }
    }

    private ContextMenuStrip BuildContextMenu()
    {
        var menu = new ContextMenuStrip();
        AddMenuItem(menu, "Open Mission Control", 1001);
        AddMenuItem(menu, "Open in Browser", 1002);
        AddMenuItem(menu, "Runtime Status", 1003);
        menu.Items.Add(new ToolStripSeparator());
        AddMenuItem(menu, "Restart Runtime", 1004);
        AddMenuItem(menu, "Stop Runtime", 1005);
        menu.Items.Add(new ToolStripSeparator());
        AddMenuItem(menu, "Open Logs", 1006);
        AddMenuItem(menu, "Open Install Folder", 1007);
        menu.Items.Add(new ToolStripSeparator());
        AddMenuItem(menu, "Quit", 1008);
        return menu;
    }

    private void AddMenuItem(ContextMenuStrip menu, string label, int id)
    {
        var item = new ToolStripMenuItem(label)
        {
            Tag = id,
        };
        item.Click += OnMenuItemClick;
        menu.Items.Add(item);
    }

    private void OnMenuItemClick(object? sender, EventArgs args)
    {
        if (sender is ToolStripItem { Tag: int id })
        {
            InvokeMenuAction(id);
        }
    }

    private void OnNotifyIconMouseClick(object? sender, MouseEventArgs args)
    {
        if (args.Button == MouseButtons.Left)
        {
            InvokeMenuAction(1001);
        }
    }

    private void InvokeMenuAction(int id)
    {
        if (_menuActions.TryGetValue(id, out var action))
        {
            action();
        }
    }
}
