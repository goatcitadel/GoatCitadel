import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const themeState = vi.hoisted(() => ({
  theme: "dark" as string | undefined,
  toasterProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: themeState.theme }),
}));

vi.mock("sonner", async () => {
  const ReactModule = await import("react");
  return {
    Toaster: (props: Record<string, unknown>) => {
      themeState.toasterProps.push(props);
      const icons = props.icons as Record<string, React.ReactNode>;
      return ReactModule.createElement(
        "section",
        {
          "data-slot": "sonner-toaster",
          "data-theme": props.theme,
          className: props.className,
        },
        Object.keys(icons).map((key) =>
          ReactModule.createElement("span", { key, "data-icon": key }, icons[key] as React.ReactNode),
        ),
      );
    },
  };
});

vi.mock("radix-ui", async () => {
  const ReactModule = await import("react");
  const primitive = (tag: string) =>
    ReactModule.forwardRef<unknown, Record<string, unknown> & { asChild?: boolean; children?: React.ReactNode }>(
      ({ asChild, children, ...props }, ref) => {
        const forwardedProps = { ...(props as Record<string, unknown>), ref } as Record<string, unknown> &
          React.RefAttributes<unknown>;
        if (asChild && ReactModule.isValidElement(children)) {
          return ReactModule.cloneElement(children as React.ReactElement<Record<string, unknown>>, forwardedProps);
        }
        return ReactModule.createElement(tag, forwardedProps, children as React.ReactNode);
      },
    );

  return {
    Dialog: {
      Root: primitive("section"),
      Trigger: primitive("button"),
      Close: primitive("button"),
      Portal: primitive("div"),
      Overlay: primitive("div"),
      Content: primitive("article"),
      Title: primitive("h2"),
      Description: primitive("p"),
    },
    Tooltip: {
      Provider: primitive("div"),
      Root: primitive("section"),
      Trigger: primitive("button"),
      Portal: primitive("div"),
      Content: primitive("aside"),
      Arrow: primitive("span"),
    },
  };
});

import { Toaster } from "./sonner";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./alert";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card";

function textOf(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => textOf(child)).join(" ");
  }
  return (node.children ?? []).map((child) => textOf(child as ReactTestRendererJSON | string | null)).join(" ");
}

function slot(renderer: ReactTestRenderer, name: string) {
  return renderer.root.findByProps({ "data-slot": name });
}

function testInstanceText(node: { children: unknown[] }): string {
  return node.children.map((child) => textOfTestValue(child)).join(" ");
}

function textOfTestValue(value: unknown): string {
  if (value == null || typeof value === "boolean") {
    return "";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((child) => textOfTestValue(child)).join(" ");
  }
  if (typeof value === "object" && "children" in value) {
    return textOfTestValue((value as { children?: unknown }).children);
  }
  if (typeof value === "object" && "props" in value) {
    return textOfTestValue((value as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

describe("Toaster", () => {
  it("uses the active theme and supplies GoatCitadel toast icons/options", () => {
    themeState.theme = "dark";
    themeState.toasterProps = [];
    const renderer = create(<Toaster position="top-right" />);

    const props = themeState.toasterProps[0]!;
    expect(slot(renderer, "sonner-toaster").props["data-theme"]).toBe("dark");
    expect(props.position).toBe("top-right");
    expect(props.style).toMatchObject({
      "--normal-bg": "var(--popover)",
      "--normal-text": "var(--popover-foreground)",
      "--normal-border": "var(--border)",
      "--border-radius": "var(--radius)",
    });
    expect(props.toastOptions).toEqual({
      classNames: {
        toast: "cn-toast",
      },
    });
    expect(Object.keys(props.icons as Record<string, React.ReactNode>)).toEqual([
      "success",
      "info",
      "warning",
      "error",
      "loading",
    ]);
    expect(textOf(renderer.toJSON()).trim()).toBe("");
    expect(renderer.root.findAllByProps({ "data-icon": "loading" })[0]!.findByType("svg").props.className).toContain(
      "animate-spin",
    );

    renderer.unmount();
  });

  it("falls back to the system theme when next-themes has not resolved yet", () => {
    themeState.theme = undefined;
    themeState.toasterProps = [];
    const renderer = create(<Toaster />);

    expect(themeState.toasterProps[0]!.theme).toBe("system");

    renderer.unmount();
  });
});

describe("Sheet primitives", () => {
  it("renders sheet slots, side classes, default close control, and caller close callbacks", () => {
    const onOpenChange = vi.fn();
    const onTrigger = vi.fn();
    const onClose = vi.fn();
    const renderer = create(
      <Sheet open onOpenChange={onOpenChange}>
        <SheetTrigger onClick={onTrigger}>Open sheet</SheetTrigger>
        <SheetContent side="left" className="sheet-extra">
          <SheetHeader className="sheet-heading">Heading</SheetHeader>
          <SheetTitle className="sheet-title">Route details</SheetTitle>
          <SheetDescription className="sheet-description">Review route state.</SheetDescription>
          <SheetFooter className="sheet-actions">
            <SheetClose onClick={onClose}>Dismiss</SheetClose>
          </SheetFooter>
        </SheetContent>
      </Sheet>,
    );

    expect(slot(renderer, "sheet").props.open).toBe(true);
    expect(slot(renderer, "sheet-trigger").props.children).toBe("Open sheet");
    expect(slot(renderer, "sheet-overlay").props.className).toContain("fixed inset-0");
    expect(slot(renderer, "sheet-content").props["data-side"]).toBe("left");
    expect(slot(renderer, "sheet-content").props.className).toContain("sheet-extra");
    expect(slot(renderer, "sheet-header").props.className).toContain("sheet-heading");
    expect(slot(renderer, "sheet-title").props.className).toContain("sheet-title");
    expect(slot(renderer, "sheet-description").props.className).toContain("sheet-description");
    expect(slot(renderer, "sheet-footer").props.className).toContain("sheet-actions");
    expect(textOf(renderer.toJSON())).toContain("Close");

    act(() => {
      slot(renderer, "sheet-trigger").props.onClick();
      renderer.root
        .findAllByProps({ "data-slot": "sheet-close" })
        .find((node) => testInstanceText(node).includes("Dismiss"))
        ?.props.onClick();
    });

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it("allows side overrides and hidden close buttons", () => {
    const renderer = create(
      <SheetContent side="bottom" showCloseButton={false} className="bottom-sheet">
        Compact content
      </SheetContent>,
    );

    expect(slot(renderer, "sheet-content").props["data-side"]).toBe("bottom");
    expect(slot(renderer, "sheet-content").props.className).toContain("bottom-sheet");
    expect(textOf(renderer.toJSON())).not.toContain("Close");

    renderer.unmount();
  });
});

describe("Tooltip primitives", () => {
  it("renders provider, trigger, content, side offset, and arrow slots", () => {
    const onTrigger = vi.fn();
    const renderer = create(
      <TooltipProvider delayDuration={250}>
        <Tooltip open>
          <TooltipTrigger onClick={onTrigger}>Hover me</TooltipTrigger>
          <TooltipContent className="tip-extra" side="left" sideOffset={8}>
            Route confidence
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    expect(slot(renderer, "tooltip-provider").props.delayDuration).toBe(250);
    expect(slot(renderer, "tooltip").props.open).toBe(true);
    expect(slot(renderer, "tooltip-trigger").props.children).toBe("Hover me");
    expect(slot(renderer, "tooltip-content").props.sideOffset).toBe(8);
    expect(slot(renderer, "tooltip-content").props.side).toBe("left");
    expect(slot(renderer, "tooltip-content").props.className).toContain("tip-extra");
    expect(
      renderer.root.findAll(
        (node) => typeof node.type === "string" && String(node.props.className ?? "").includes("fill-foreground"),
      ),
    ).toHaveLength(1);

    act(() => {
      slot(renderer, "tooltip-trigger").props.onClick();
    });

    expect(onTrigger).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it("defaults tooltip provider delay and content offset to zero", () => {
    const renderer = create(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>Target</TooltipTrigger>
          <TooltipContent>Details</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    expect(slot(renderer, "tooltip-provider").props.delayDuration).toBe(0);
    expect(slot(renderer, "tooltip-content").props.sideOffset).toBe(0);

    renderer.unmount();
  });
});

describe("Alert and Card primitives", () => {
  it("renders alert variants, action slots, and caller classes", () => {
    const renderer = create(
      <Alert variant="destructive" className="alert-extra">
        <AlertTitle className="alert-title-extra">Danger</AlertTitle>
        <AlertDescription className="alert-copy-extra">Something needs review.</AlertDescription>
        <AlertAction className="alert-action-extra">
          <button type="button">Act</button>
        </AlertAction>
      </Alert>,
    );

    expect(slot(renderer, "alert").props.role).toBe("alert");
    expect(slot(renderer, "alert").props.className).toContain("alert-extra");
    expect(slot(renderer, "alert").props.className).toContain("text-destructive");
    expect(slot(renderer, "alert-title").props.className).toContain("alert-title-extra");
    expect(slot(renderer, "alert-description").props.className).toContain("alert-copy-extra");
    expect(slot(renderer, "alert-action").props.className).toContain("alert-action-extra");
    expect(textOf(renderer.toJSON())).toContain("Something needs review.");

    renderer.unmount();
  });

  it("renders card slots, compact size attributes, and caller classes", () => {
    const renderer = create(
      <Card size="sm" className="card-extra">
        <CardHeader className="card-head-extra">
          <CardTitle className="card-title-extra">Mission card</CardTitle>
          <CardDescription className="card-description-extra">Compact status</CardDescription>
          <CardAction className="card-action-extra">Now</CardAction>
        </CardHeader>
        <CardContent className="card-content-extra">Payload</CardContent>
        <CardFooter className="card-footer-extra">Footer</CardFooter>
      </Card>,
    );

    expect(slot(renderer, "card").props["data-size"]).toBe("sm");
    expect(slot(renderer, "card").props.className).toContain("card-extra");
    expect(slot(renderer, "card-header").props.className).toContain("card-head-extra");
    expect(slot(renderer, "card-title").props.className).toContain("card-title-extra");
    expect(slot(renderer, "card-description").props.className).toContain("card-description-extra");
    expect(slot(renderer, "card-action").props.className).toContain("card-action-extra");
    expect(slot(renderer, "card-content").props.className).toContain("card-content-extra");
    expect(slot(renderer, "card-footer").props.className).toContain("card-footer-extra");
    expect(textOf(renderer.toJSON())).toContain("Mission card");

    renderer.unmount();
  });
});
