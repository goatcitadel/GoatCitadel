import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ChevronRight } from "lucide-react";
import { Button } from "../ui/Button";
import { Switch } from "../ui/Switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/Tabs";
import { createGalleryWaveRunner, type GalleryWave } from "./gallery-wave";

type WaveModule = typeof import("distortion-wave");
type Run = (selector: string, update: () => void, targetSelector?: string) => void;
const SIMULATE_INSTALL_LABEL = "Simulate install";

function WaveExample({
  title,
  wave,
  preserveText = false,
  children,
}: {
  title: string;
  wave: WaveModule | undefined;
  preserveText?: boolean;
  children: (run: Run) => ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const pointer = useRef<PointerEvent | null>(null);
  const [runner] = useState(createGalleryWaveRunner);
  useEffect(() => () => runner.dispose(), [runner]);

  const run: Run = (selector, update, targetSelector) => {
    const source = panel.current?.querySelector<HTMLElement>(selector);
    if (!source) {
      update();
      return;
    }
    const target = targetSelector
      ? (panel.current?.querySelector<HTMLElement>(targetSelector) ?? source)
      : (source.closest<HTMLElement>("[data-wave-target]") ?? source);
    const focus = pointer.current;
    pointer.current = null;
    const animate: GalleryWave | undefined =
      wave && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? (element, commit, trigger) => {
            const transition = wave.distortionWave(element, () => flushSync(commit), {
              source: trigger,
              focus,
              // These demos reveal feedback alongside the control. Carry it through the color wave at its original size.
              ...(preserveText ? { intensity: 0, blur: 0, blurNear: 0, blurAhead: 0, blurBehind: 0 } : {}),
            });
            // An interrupted capture can reject the readiness promises even when the update succeeded.
            void Promise.allSettled([transition.ready, transition.updateCallbackDone, transition.covered]);
            return transition;
          }
        : undefined;
    runner.run(animate, target, source, update);
  };

  return (
    <div
      ref={panel}
      className="min-w-0 space-y-3 border-t border-line bg-raised p-4"
      onPointerDownCapture={(event) => {
        pointer.current = event.nativeEvent;
      }}
      onKeyDownCapture={() => {
        pointer.current = null;
      }}
      onClickCapture={(event) => {
        if (event.detail === 0) pointer.current = null;
      }}
    >
      <h3 className="text-sm font-medium text-fg">{title}</h3>
      {children(run)}
    </div>
  );
}

export function GalleryDistortionWave() {
  const [wave, setWave] = useState<WaveModule>();
  const [enabled, setEnabled] = useState(false);
  const [filters, setFilters] = useState<string[]>([]);
  const [tab, setTab] = useState("inputs");
  const [expanded, setExpanded] = useState(false);
  const [sent, setSent] = useState(0);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    let mounted = true;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const load = () => {
      if (motion.matches) return;
      void import("distortion-wave")
        .then((kit) => {
          if (!mounted || motion.matches) return;
          kit.warmupWave();
          setWave(kit);
        })
        // The examples still apply their updates when the optional effect can't load.
        .catch(() => undefined);
    };
    load();
    motion.addEventListener("change", load);
    return () => {
      mounted = false;
      motion.removeEventListener("change", load);
    };
  }, []);

  return (
    <section aria-labelledby="gallery-distortion-wave-title" className="space-y-3">
      <h2 id="gallery-distortion-wave-title" className="font-display text-lg text-fg">
        Distortion Wave
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <WaveExample title="Toggle" wave={wave}>
          {(run) => (
            <div data-wave-target className="w-fit rounded-md bg-sunken px-3 py-1">
              <Switch
                label="Follow activity"
                wave={false}
                checked={enabled}
                onCheckedChange={() => run('[role="switch"]', () => setEnabled((current) => !current))}
              />
            </div>
          )}
        </WaveExample>
        <WaveExample title="Filter chips" wave={wave}>
          {(run) => (
            <div className="flex flex-wrap gap-2">
              {["Tools", "Skills", "Plugins"].map((filter) => (
                <Button
                  key={filter}
                  size="sm"
                  data-demo-filter={filter}
                  aria-pressed={filters.includes(filter)}
                  className="whitespace-nowrap aria-pressed:border-accent aria-pressed:bg-sunken aria-pressed:inset-ring-1 aria-pressed:inset-ring-accent"
                  onClick={() =>
                    run(`[data-demo-filter="${filter}"]`, () => {
                      setFilters((current) =>
                        current.includes(filter) ? current.filter((entry) => entry !== filter) : [...current, filter],
                      );
                    })
                  }
                >
                  {filter}
                </Button>
              ))}
            </div>
          )}
        </WaveExample>
        <WaveExample title="Tabs" wave={wave} preserveText>
          {(run) => (
            <Tabs
              value={tab}
              activationMode="manual"
              onValueChange={(next) => run(`[data-demo-tab="${next}"]`, () => setTab(next), "[data-demo-tab-panel]")}
            >
              <TabsList aria-label="Sample run">
                <TabsTrigger value="inputs" data-demo-tab="inputs" wave={false}>
                  Inputs
                </TabsTrigger>
                <TabsTrigger value="results" data-demo-tab="results" wave={false}>
                  Results
                </TabsTrigger>
              </TabsList>
              <div data-demo-tab-panel className="min-h-7 rounded-sm bg-sunken px-2 py-1">
                <TabsContent value="inputs" className="text-sm text-fg-secondary">
                  Workspace instructions
                </TabsContent>
                <TabsContent value="results" className="text-sm text-fg-secondary">
                  Run summary and sources
                </TabsContent>
              </div>
            </Tabs>
          )}
        </WaveExample>
        <WaveExample title="Disclosure" wave={wave} preserveText>
          {(run) => (
            <details open={expanded}>
              <summary
                className="flex w-fit cursor-pointer items-center gap-1 font-medium text-accent"
                onClick={(event) => {
                  event.preventDefault();
                  run("summary", () => setExpanded((current) => !current));
                }}
              >
                <ChevronRight aria-hidden="true" className={`inline size-4 ${expanded ? "rotate-90" : ""}`} />
                Run details
              </summary>
              <p className="pt-2 text-sm text-fg-secondary">Checked three sources.</p>
            </details>
          )}
        </WaveExample>
        <WaveExample title="Chat send" wave={wave} preserveText>
          {(run) => (
            <div className="space-y-2">
              <p className="text-sm text-fg-secondary">Summarize today’s activity.</p>
              <Button
                size="sm"
                className="whitespace-nowrap"
                aria-describedby="gallery-send-result"
                onClick={() => run("button", () => setSent((count) => count + 1), "#gallery-send-result")}
              >
                Send sample
              </Button>
              <p id="gallery-send-result" className="min-h-5 rounded-sm bg-sunken px-2 text-sm text-fg-secondary">
                {sent > 0 ? `Sample messages sent: ${sent}` : ""}
              </p>
            </div>
          )}
        </WaveExample>
        <WaveExample title="Install confirmation" wave={wave} preserveText>
          {(run) => (
            <div className="space-y-2">
              <Button
                size="sm"
                className="cockpit-gallery-install-button inline-grid min-w-32! whitespace-nowrap"
                data-width-label={SIMULATE_INSTALL_LABEL}
                aria-describedby="gallery-install-result"
                onClick={() => run("button", () => setInstalled((current) => !current), "#gallery-install-result")}
              >
                <span>{installed ? "Reset demo" : SIMULATE_INSTALL_LABEL}</span>
              </Button>
              <p id="gallery-install-result" className="min-h-5 rounded-sm bg-sunken px-2 text-sm text-fg-secondary">
                {installed ? "Installed." : ""}
              </p>
            </div>
          )}
        </WaveExample>
      </div>
    </section>
  );
}
