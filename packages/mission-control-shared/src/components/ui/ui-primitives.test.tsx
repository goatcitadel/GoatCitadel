import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { ActionButton } from "../ActionButton";
import { ChatComposerPlusMenu } from "../ChatComposerPlusMenu";
import { ChatModelPicker } from "../ChatModelPicker";
import { DeviceAccessApprovalModal } from "../DeviceAccessApprovalModal";
import { GlobalFreshnessPill } from "../GlobalFreshnessPill";
import { RemoteApprovalActionModal } from "../RemoteApprovalActionModal";
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  GCCombobox,
  GCModal,
  GCSegmentedControl,
  GCSelect,
  GCSwitch,
  Input,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Textarea,
} from ".";
import { publishEventStreamStatus, resetEventStreamStatus } from "../../state/event-stream-status-store";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "./command";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
} from "./input-group";

vi.mock("radix-ui", async () => {
  const ReactActual = await import("react");
  const primitive = (slot: string) =>
    ReactActual.forwardRef<HTMLElement, Record<string, unknown>>(function Primitive(
      { children, asChild: _asChild, ...props },
      ref,
    ) {
      return ReactActual.createElement("div", { ref, "data-primitive": slot, ...props }, children as React.ReactNode);
    });
  const namespace = (names: string[]) => Object.fromEntries(names.map((name) => [name, primitive(name)]));
  return {
    Dialog: namespace(["Root", "Trigger", "Portal", "Close", "Overlay", "Content", "Title", "Description"]),
    Popover: namespace(["Root", "Portal", "Trigger", "Content", "Anchor"]),
    Tooltip: namespace(["Provider", "Root", "Portal", "Trigger", "Content", "Arrow"]),
  };
});

vi.mock("@radix-ui/react-popover", async () => {
  const ReactActual = await import("react");
  const primitive = (slot: string) =>
    ReactActual.forwardRef<HTMLElement, Record<string, unknown>>(function Primitive(
      { children, asChild: _asChild, ...props },
      ref,
    ) {
      return ReactActual.createElement("div", { ref, "data-primitive": slot, ...props }, children as React.ReactNode);
    });
  return {
    Root: primitive("Root"),
    Trigger: primitive("Trigger"),
    Portal: primitive("Portal"),
    Content: primitive("Content"),
  };
});

vi.mock("cmdk", async () => {
  const ReactActual = await import("react");
  const command = ReactActual.forwardRef<HTMLElement, Record<string, unknown>>(function CommandPrimitive(
    { children, ...props },
    ref,
  ) {
    return ReactActual.createElement(
      "div",
      { ref, "data-primitive": "Command", ...props },
      children as React.ReactNode,
    );
  }) as React.ForwardRefExoticComponent<Record<string, unknown>> &
    Record<string, React.ComponentType<Record<string, unknown>>>;
  for (const name of ["Input", "List", "Empty", "Group", "Separator", "Item"]) {
    command[name] = ReactActual.forwardRef<HTMLElement, Record<string, unknown>>(function CommandPart(
      { children, ...props },
      ref,
    ) {
      return ReactActual.createElement(
        "div",
        { ref, "data-primitive": `Command.${name}`, ...props },
        children as React.ReactNode,
      );
    });
  }
  return { Command: command };
});

describe("shared UI primitives", () => {
  it("renders Radix-backed wrappers with GoatCitadel classes", () => {
    const renderer = create(
      <>
        <Command>
          <CommandInput placeholder="Search" />
          <CommandList>
            <CommandEmpty>None</CommandEmpty>
            <CommandGroup heading="Group">
              <CommandItem value="a">
                Alpha
                <CommandShortcut>⌘A</CommandShortcut>
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
          </CommandList>
        </Command>
        <CommandDialog open title="Commands" description="Find command">
          <Command>Dialog command</Command>
        </CommandDialog>
        <Sheet open>
          <SheetTrigger>Sheet</SheetTrigger>
          <SheetContent side="left">
            <SheetHeader>
              <SheetTitle>Title</SheetTitle>
              <SheetDescription>Description</SheetDescription>
            </SheetHeader>
            <SheetFooter>Footer</SheetFooter>
          </SheetContent>
          <SheetClose>Close</SheetClose>
        </Sheet>
        <Dialog open>
          <DialogTrigger>Dialog</DialogTrigger>
          <DialogPortal>
            <DialogOverlay />
          </DialogPortal>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Dialog title</DialogTitle>
              <DialogDescription>Dialog description</DialogDescription>
            </DialogHeader>
            <DialogFooter showCloseButton>Footer</DialogFooter>
          </DialogContent>
          <DialogClose>Close</DialogClose>
        </Dialog>
        <Popover open>
          <PopoverTrigger>Popover</PopoverTrigger>
          <PopoverAnchor>Anchor</PopoverAnchor>
          <PopoverContent>
            <PopoverHeader>
              <PopoverTitle>Popover title</PopoverTitle>
              <PopoverDescription>Popover description</PopoverDescription>
            </PopoverHeader>
          </PopoverContent>
        </Popover>
      </>,
    );

    expect(JSON.stringify(renderer.toJSON())).toContain("command-item");
    expect(JSON.stringify(renderer.toJSON())).toContain("sheet-content");
    expect(JSON.stringify(renderer.toJSON())).toContain("dialog-content");
    expect(JSON.stringify(renderer.toJSON())).toContain("mc-dialog-overlay");
    expect(JSON.stringify(renderer.toJSON())).toContain("mc-dialog-content");
    expect(JSON.stringify(renderer.toJSON())).toContain("popover-content");
  });

  it("renders simple primitive components and handles local UI callbacks", () => {
    const onSegment = vi.fn();
    const onAction = vi.fn();
    const renderer = create(
      <>
        <Badge variant="outline">Badge</Badge>
        <Button variant="secondary" size="sm" onClick={onAction}>
          Button
        </Button>
        <Input value="value" onChange={() => undefined} />
        <Textarea value="body" onChange={() => undefined} />
        <InputGroup>
          <InputGroupAddon>
            <span>Prefix</span>
          </InputGroupAddon>
          <InputGroupInput value="x" onChange={() => undefined} />
          <InputGroupButton onClick={onAction}>Go</InputGroupButton>
          <InputGroupText>Text</InputGroupText>
          <InputGroupTextarea value="long" onChange={() => undefined} />
        </InputGroup>
        <GCSelect
          value="a"
          options={[
            { value: "", label: "Pick", disabled: true },
            { value: "a", label: "Alpha" },
          ]}
          renderPrefix="Model"
          onChange={onAction}
        />
        <GCSwitch checked onCheckedChange={onAction} label="Switch" />
        <GCSegmentedControl
          value="one"
          ariaLabel="Modes"
          onChange={onSegment}
          options={[
            { value: "one", label: "One" },
            { value: "two", label: "Two" },
            { value: "disabled", label: "Disabled", disabled: true },
          ]}
        />
      </>,
    );

    const buttons = renderer.root.findAllByType("button");
    act(() => {
      buttons.find((button) => button.children.join("") === "Button")!.props.onClick();
      buttons.find((button) => button.children.join("") === "Go")!.props.onClick();
      const segmentButton = buttons.find((button) => button.children.join("") === "One")!;
      segmentButton.props.onKeyDown({ key: "ArrowRight", preventDefault: vi.fn() });
      segmentButton.props.onKeyDown({ key: "End", preventDefault: vi.fn() });
      segmentButton.props.onClick();
    });

    const select = renderer.root.findByType("select");
    act(() => {
      select.props.onChange({ target: { value: "a" } });
    });
    expect(onAction).toHaveBeenCalled();
    expect(onSegment).toHaveBeenCalledWith("two");
    expect(onSegment).toHaveBeenCalledWith("one");
  });

  it("covers composed GoatCitadel controls and modal action flows", () => {
    const onChange = vi.fn();
    const combobox = create(
      <GCCombobox
        value="alpha"
        onChange={onChange}
        options={[
          { value: "alpha", label: "Alpha" },
          { value: "beta", label: "Beta" },
        ]}
      />,
    );
    const trigger = combobox.root.findByProps({ "aria-haspopup": "dialog" });
    act(() => {
      trigger.props.onKeyDown({ key: "ArrowDown", preventDefault: vi.fn() });
      const input = combobox.root.findByProps({ role: "combobox" });
      input.props.onValueChange?.("be");
      input.props.onKeyDown({ key: "ArrowDown", preventDefault: vi.fn() });
      input.props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
      combobox.root.findAllByProps({ role: "option" })[1]!.props.onSelect();
    });
    expect(onChange).toHaveBeenCalled();

    const modalCallbacks = {
      onOpenChange: vi.fn(),
      onConfirm: vi.fn(),
      onDismiss: vi.fn(),
      onApprove: vi.fn(),
      onReject: vi.fn(),
    };
    const modal = create(
      <>
        <GCModal
          open
          title="Confirm"
          description="Description"
          danger
          onOpenChange={modalCallbacks.onOpenChange}
          onConfirm={modalCallbacks.onConfirm}
        >
          Body
        </GCModal>
        <GCModal
          open
          title="Locked"
          dismissDisabled
          onOpenChange={modalCallbacks.onOpenChange}
          onConfirm={modalCallbacks.onConfirm}
        />
        <DeviceAccessApprovalModal
          open
          prompt={{
            approvalId: "approval-1",
            requestId: "request-1",
            deviceLabel: "Phone",
            platform: "Android",
            deviceType: "mobile",
            requestedIp: "127.0.0.1",
            requestedOrigin: "app",
          }}
          onApprove={modalCallbacks.onApprove}
          onReject={modalCallbacks.onReject}
          onDismiss={modalCallbacks.onDismiss}
        />
        <RemoteApprovalActionModal
          open
          prompt={{
            approvalId: "approval-2",
            actionType: "approval.resolve",
            tokenId: "token-1",
            token: "secret",
            kind: "tool",
            riskLevel: "high",
            status: "pending",
            preview: { command: "run" },
            expiresAt: "2025-01-01T00:00:00.000Z",
          }}
          onApprove={modalCallbacks.onApprove}
          onReject={modalCallbacks.onReject}
          onDismiss={modalCallbacks.onDismiss}
        />
      </>,
    );

    const dialogRoots = modal.root
      .findAllByProps({ "data-primitive": "Root" })
      .filter((node) => typeof node.props.onOpenChange === "function");
    const unlockedRoot = dialogRoots[0]!;
    const lockedRoot = dialogRoots[1]!;
    act(() => {
      unlockedRoot.props.onOpenChange(false);
      const callsBeforeLockedDismiss = modalCallbacks.onOpenChange.mock.calls.length;
      lockedRoot.props.onOpenChange(false);
      expect(modalCallbacks.onOpenChange).toHaveBeenCalledTimes(callsBeforeLockedDismiss);
      lockedRoot.props.onOpenChange(true);
      for (const button of modal.root.findAllByType("button")) {
        if (typeof button.props.onClick === "function") {
          button.props.onClick();
        }
      }
    });
    expect(modalCallbacks.onOpenChange).toHaveBeenCalledWith(false);
    expect(modalCallbacks.onOpenChange).toHaveBeenCalledWith(true);
    expect(modalCallbacks.onConfirm).toHaveBeenCalled();
    expect(modalCallbacks.onApprove).toHaveBeenCalled();
    expect(modalCallbacks.onReject).toHaveBeenCalled();

    const plusCallbacks = {
      onAttachFiles: vi.fn(),
      onRunQuickResearch: vi.fn(),
      onSelect: vi.fn(),
    };
    const plusMenu = create(
      <ChatComposerPlusMenu
        onAttachFiles={plusCallbacks.onAttachFiles}
        onRunQuickResearch={plusCallbacks.onRunQuickResearch}
        actions={[{ label: "Custom", active: true, onSelect: plusCallbacks.onSelect }]}
      >
        Extra
      </ChatComposerPlusMenu>,
    );
    act(() => {
      plusMenu.root.findByProps({ className: "chat-plus-popover" }).props.onOpenAutoFocus({
        preventDefault: modalCallbacks.onDismiss,
      });
      for (const label of ["Attach files", "Quick web research", "Custom"]) {
        plusMenu.root
          .findAllByType("button")
          .find((button) => button.props["aria-label"] === label)!
          .props.onClick();
      }
    });
    expect(plusCallbacks.onAttachFiles).toHaveBeenCalled();
    expect(plusCallbacks.onRunQuickResearch).toHaveBeenCalled();
    expect(plusCallbacks.onSelect).toHaveBeenCalled();
    expect(modalCallbacks.onDismiss).toHaveBeenCalled();
    expect(
      plusMenu.root.findAllByType("button").find((button) => button.props["aria-label"] === "Custom")!.props[
        "aria-pressed"
      ],
    ).toBe(true);

    const modelCallbacks = {
      onChangeProvider: vi.fn(),
      onChangeModel: vi.fn(),
    };
    const modelPicker = create(
      <ChatModelPicker
        providerId="openai"
        model="gpt"
        providers={[
          {
            providerId: "openai",
            label: "OpenAI",
            models: ["gpt", "mini"],
            availabilityHint: "Ready",
          },
        ]}
        {...modelCallbacks}
      />,
    );
    expect(JSON.stringify(modelPicker.toJSON())).toContain("Ready");

    const action = create(
      <ActionButton label="Run" pendingLabel="Running" pending onClick={modalCallbacks.onConfirm} />,
    );
    expect(JSON.stringify(action.toJSON())).toContain("Running");
    const readyAction = create(
      <ActionButton label="Run" className="extra-action" onClick={modalCallbacks.onConfirm} />,
    );
    act(() => {
      readyAction.root.findByType("button").props.onClick();
    });
    expect(JSON.stringify(readyAction.toJSON())).toContain("extra-action");
  });

  it("covers combobox keyboard fallbacks, filtering, and disabled state", () => {
    const onChange = vi.fn();
    const preventDefault = vi.fn();
    const renderer = create(
      <GCCombobox
        value="missing-model"
        onChange={onChange}
        placeholder="Pick model"
        aria-label="Model"
        options={[
          { value: "alpha", label: "Alpha" },
          { value: "beta", label: "Beta" },
          { value: "gamma", label: "Gamma" },
        ]}
      />,
    );

    expect(JSON.stringify(renderer.toJSON())).toContain("missing-model");
    const trigger = renderer.root.findByProps({ "aria-haspopup": "dialog" });
    act(() => {
      trigger.props.onKeyDown({ key: "Enter", preventDefault });
    });
    expect(preventDefault).toHaveBeenCalled();

    const input = renderer.root.findByProps({ role: "combobox" });
    act(() => {
      input.props.onValueChange("ga");
      input.props.onKeyDown({ key: "ArrowUp", preventDefault });
      input.props.onKeyDown({ key: "Home", preventDefault });
      input.props.onKeyDown({ key: "End", preventDefault });
    });
    const gamma = renderer.root
      .findAllByProps({ role: "option" })
      .find((option) => option.props.value === "Gamma gamma")!;
    act(() => {
      gamma.props.onMouseEnter();
      input.props.onKeyDown({ key: "Enter", preventDefault });
    });
    expect(onChange).toHaveBeenCalledWith("gamma");

    renderer.update(
      <GCCombobox
        value=""
        onChange={onChange}
        placeholder="Pick model"
        options={[
          { value: "alpha", label: "Alpha" },
          { value: "beta", label: "Beta" },
        ]}
      />,
    );
    const updatedTrigger = renderer.root.findByProps({ "aria-haspopup": "dialog" });
    const updatedInput = renderer.root.findByProps({ role: "combobox" });
    act(() => {
      updatedTrigger.props.onKeyDown({ key: " ", preventDefault });
      updatedInput.props.onValueChange("zzz");
      updatedInput.props.onKeyDown({ key: "ArrowDown", preventDefault });
      updatedInput.props.onKeyDown({ key: "ArrowUp", preventDefault });
      updatedInput.props.onKeyDown({ key: "Home", preventDefault });
      updatedInput.props.onKeyDown({ key: "End", preventDefault });
      updatedInput.props.onKeyDown({ key: "Enter", preventDefault });
      updatedInput.props.onKeyDown({ key: "Escape", preventDefault });
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("No matches.");

    const disabled = create(<GCCombobox value="" onChange={onChange} options={[]} placeholder="Pick model" disabled />);
    const disabledPreventDefault = vi.fn();
    act(() => {
      disabled.root.findByProps({ "aria-haspopup": "dialog" }).props.onKeyDown({
        key: "ArrowDown",
        preventDefault: disabledPreventDefault,
      });
    });
    expect(disabledPreventDefault).not.toHaveBeenCalled();
    expect(JSON.stringify(disabled.toJSON())).toContain("Pick model");
  });

  it("uses fuzzy combobox matching for compact model searches", () => {
    const renderer = create(
      <GCCombobox
        value=""
        onChange={vi.fn()}
        placeholder="Pick model"
        options={[
          { value: "claude-opus-4.1", label: "Claude Opus 4.1" },
          { value: "gpt-5.4", label: "GPT-5.4" },
          { value: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
        ]}
      />,
    );

    act(() => {
      renderer.root.findByProps({ "aria-haspopup": "dialog" }).props.onKeyDown({
        key: "ArrowDown",
        preventDefault: vi.fn(),
      });
      renderer.root.findByProps({ role: "combobox" }).props.onValueChange("g54");
    });

    expect(
      Array.from(new Set(renderer.root.findAllByProps({ role: "option" }).map((option) => option.props.value))),
    ).toEqual(["GPT-5.4 gpt-5.4", "GPT-5.4 Mini gpt-5.4-mini"]);
  });

  it("covers segmented-control disabled and wraparound keyboard paths", () => {
    const onChange = vi.fn();
    const preventDefault = vi.fn();
    const renderer = create(
      <GCSegmentedControl
        value="one"
        ariaLabel="Modes"
        className="custom-segments"
        onChange={onChange}
        options={[
          { value: "one", label: "One" },
          { value: "two", label: "Two", disabled: true },
          { value: "three", label: "Three" },
        ]}
      />,
    );
    const buttons = renderer.root.findAllByType("button");
    act(() => {
      buttons[0]!.props.onKeyDown({ key: "ArrowLeft", preventDefault });
      buttons[0]!.props.onKeyDown({ key: "ArrowDown", preventDefault });
      buttons[0]!.props.onKeyDown({ key: "Home", preventDefault });
      buttons[0]!.props.onKeyDown({ key: "End", preventDefault });
      buttons[1]!.props.onKeyDown({ key: "ArrowRight", preventDefault });
      buttons[0]!.props.onKeyDown({ key: "Tab", preventDefault });
    });
    expect(onChange).toHaveBeenCalledWith("three");
    expect(onChange).toHaveBeenCalledWith("one");
    expect(preventDefault).toHaveBeenCalled();

    const disabledOnly = create(
      <GCSegmentedControl
        value="one"
        ariaLabel="Disabled modes"
        onChange={onChange}
        options={[{ value: "one", label: "One", disabled: true }]}
      />,
    );
    act(() => {
      disabledOnly.root.findByType("button").props.onKeyDown({ key: "ArrowRight", preventDefault });
      disabledOnly.root.findByType("button").props.onClick();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("custom-segments");
  });

  it("focuses input-group controls from addons and preserves embedded button clicks", () => {
    const focus = vi.fn();
    const querySelector = vi.fn(() => ({ focus }));
    const renderer = create(
      <InputGroup>
        <InputGroupAddon>Search</InputGroupAddon>
        <InputGroupInput value="" onChange={() => undefined} />
      </InputGroup>,
    );
    const addon = renderer.root.findByProps({ "data-slot": "input-group-addon" });

    act(() => {
      addon.props.onClick({
        target: { closest: () => null },
        currentTarget: { parentElement: { querySelector } },
      });
    });
    expect(querySelector).toHaveBeenCalledWith("input");
    expect(focus).toHaveBeenCalledTimes(1);

    act(() => {
      addon.props.onClick({
        target: { closest: (selector: string) => (selector === "button" ? {} : null) },
        currentTarget: { parentElement: { querySelector } },
      });
    });
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("auto-focuses the combobox search input when the popover opens", () => {
    const focus = vi.fn();
    const renderer = create(
      <GCCombobox
        value="beta"
        onChange={vi.fn()}
        options={[
          { value: "alpha", label: "Alpha" },
          { value: "beta", label: "Beta" },
        ]}
      />,
      {
        createNodeMock: (element) => (element.props.role === "combobox" ? { focus } : null),
      },
    );

    act(() => {
      renderer.root.findByProps({ "aria-haspopup": "dialog" }).props.onKeyDown({
        key: "ArrowDown",
        preventDefault: vi.fn(),
      });
    });

    const content = renderer.root.find(
      (node) => typeof node.props.className === "string" && node.props.className.includes("gc-combobox-content"),
    );
    const preventDefault = vi.fn();
    act(() => {
      content.props.onOpenAutoFocus({ preventDefault });
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("keeps combobox highlighting stable for current and empty option sets", () => {
    const preventDefault = vi.fn();
    const current = create(
      <GCCombobox
        value="beta"
        onChange={vi.fn()}
        options={[
          { value: "alpha", label: "Alpha" },
          { value: "beta", label: "Beta" },
        ]}
      />,
    );
    act(() => {
      current.root.findByProps({ "aria-haspopup": "dialog" }).props.onKeyDown({ key: "ArrowDown", preventDefault });
    });
    expect(
      current.root.findAllByProps({ role: "option" }).some((option) => option.props["data-checked"] === true),
    ).toBe(true);

    const empty = create(
      <GCCombobox value={undefined as unknown as string} onChange={vi.fn()} options={[]} placeholder="Pick" />,
    );
    act(() => {
      empty.root.findByProps({ "aria-haspopup": "dialog" }).props.onKeyDown({ key: "ArrowDown", preventDefault });
    });
    const input = empty.root.findByProps({ role: "combobox" });
    act(() => {
      input.props.onKeyDown({ key: "ArrowDown", preventDefault });
      input.props.onKeyDown({ key: "ArrowUp", preventDefault });
      input.props.onKeyDown({ key: "Home", preventDefault });
      input.props.onKeyDown({ key: "End", preventDefault });
    });
    expect(JSON.stringify(empty.toJSON())).toContain("Pick");
  });

  it("renders freshness states from the shared event stream store", () => {
    resetEventStreamStatus();
    act(() => {
      publishEventStreamStatus({
        state: "open",
        reconnectAttempts: 2,
        lastEventAt: "2026-01-01T12:00:00.000Z",
        gatewayNodeId: "node-1",
      });
    });

    const full = create(<GlobalFreshnessPill streamState="open" />);
    expect(JSON.stringify(full.toJSON())).toContain("Gateway");
    expect(JSON.stringify(full.toJSON())).toContain("node-1");
    const compact = create(<GlobalFreshnessPill streamState="retrying" variant="compact" />);
    expect(JSON.stringify(compact.toJSON())).toContain("Reconnecting");
  });
});
