import type { Dispatch, SetStateAction } from "react";
import type { OfficeMotionMode } from "../../components/OfficeCanvas";
import { FieldHelp } from "../../components/FieldHelp";
import { GCSelect } from "../../components/ui";

export interface OfficePlaybackState {
  mode: "live" | "replay";
  playing: boolean;
  speed: 1 | 2 | 4;
  cursorTime?: number;
}

export interface OfficeOperatorPrefsLike {
  motionMode: OfficeMotionMode;
  showCollabOverlay: boolean;
  idleMillingEnabled: boolean;
  showInspectorDock: boolean;
  showRailDock: boolean;
  focusMode: boolean;
  quietMode: boolean;
  followSelection: boolean;
}

export interface OfficeReplayWindowLike {
  startTime: number;
  endTime: number;
  replayableEvents: unknown[];
}

export interface OfficeStageControlBarProps<P extends OfficeOperatorPrefsLike> {
  playback: OfficePlaybackState;
  setPlayback: Dispatch<SetStateAction<OfficePlaybackState>>;
  replayWindow: OfficeReplayWindowLike;
  playbackCursorTime: number | null;
  onPlaybackModeChange: (mode: OfficePlaybackState["mode"]) => void;
  playbackSpeedOptions: Array<{ value: string; label: string }>;
  operatorPrefs: P;
  setOperatorPrefs: Dispatch<SetStateAction<P>>;
  effectiveMotionMode: OfficeMotionMode;
  prefersReducedMotion: boolean;
  motionModeOptions: Array<{ value: OfficeMotionMode; label: string }>;
}

export function OfficeStageControlBar<P extends OfficeOperatorPrefsLike>(props: OfficeStageControlBarProps<P>) {
  const {
    playback,
    setPlayback,
    replayWindow,
    playbackCursorTime,
    onPlaybackModeChange,
    playbackSpeedOptions,
    operatorPrefs,
    setOperatorPrefs,
    effectiveMotionMode,
    prefersReducedMotion,
    motionModeOptions,
  } = props;

  return (
    <>
      <div className="office-playback-bar">
        <div className="office-playback-head">
          <div>
            <p className="office-playback-label">Activity playback</p>
            <p className="office-playback-copy">
              Rewind the last five minutes to watch traffic, approvals, and handoffs condense into a faster operations
              replay.
            </p>
          </div>
          <div className="office-playback-actions">
            <button
              type="button"
              className={["gc-button", (playback.mode === "live" ? "active" : "")].filter(Boolean).join(" ")}
              onClick={() => onPlaybackModeChange("live")}
            >
              Live
            </button>
            <button
              type="button"
              className={["gc-button", (playback.mode === "replay" ? "active" : "")].filter(Boolean).join(" ")}
              onClick={() => onPlaybackModeChange("replay")}
              disabled={replayWindow.replayableEvents.length === 0}
            >
              Replay 5m
            </button>
            <button
              type="button"
              disabled={playback.mode !== "replay" || replayWindow.replayableEvents.length === 0}
              onClick={() =>
                setPlayback((current) => ({
                  ...current,
                  playing: current.mode === "replay" ? !current.playing : false,
                  cursorTime:
                    current.mode === "replay" ? (current.cursorTime ?? replayWindow.startTime) : current.cursorTime,
                }))
              }
             className="gc-button">
              {playback.playing ? "Pause" : "Play"}
            </button>
          </div>
        </div>
        <div className="office-playback-controls">
          <label htmlFor="officePlaybackCursor">Replay cursor</label>
          <input
            id="officePlaybackCursor"
            type="range"
            min={0}
            max={100}
            value={
              playback.mode === "replay" && replayWindow.endTime > replayWindow.startTime
                ? Math.round(
                    (((playbackCursorTime ?? replayWindow.startTime) - replayWindow.startTime) /
                      (replayWindow.endTime - replayWindow.startTime)) *
                      100,
                  )
                : 100
            }
            disabled={playback.mode !== "replay" || replayWindow.replayableEvents.length === 0}
            onChange={(event) => {
              const ratio = Number.parseFloat(event.target.value) / 100;
              const nextCursor = replayWindow.startTime + (replayWindow.endTime - replayWindow.startTime) * ratio;
              setPlayback((current) => ({
                ...current,
                cursorTime: nextCursor,
                playing: false,
              }));
            }}
          />
          <GCSelect
            id="officePlaybackSpeed"
            value={String(playback.speed)}
            onChange={(value) =>
              setPlayback((current) => ({
                ...current,
                speed: Number.parseInt(value, 10) as OfficePlaybackState["speed"],
              }))
            }
            options={playbackSpeedOptions}
            disabled={playback.mode !== "replay"}
          />
        </div>
      </div>

      <div className="office-stage-toolbar">
        <div className="office-stage-toolbar-group office-stage-toolbar-motion">
          <label htmlFor="officeMotionMode">Motion</label>
          <GCSelect
            id="officeMotionMode"
            value={effectiveMotionMode}
            disabled={prefersReducedMotion}
            onChange={(value) =>
              setOperatorPrefs((prev) => ({
                ...prev,
                motionMode: value as OfficeMotionMode,
              }))
            }
            options={motionModeOptions}
          />
          <FieldHelp>
            Use reduced or subtle motion for longer monitoring sessions. Reduced-motion system settings take priority.
          </FieldHelp>
        </div>
        <div className="office-stage-toolbar-group office-stage-toolbar-toggles">
          <div className="office-toggle-row">
            <label>
              <input
                type="checkbox"
                checked={operatorPrefs.showCollabOverlay}
                onChange={(event) =>
                  setOperatorPrefs((prev) => ({
                    ...prev,
                    showCollabOverlay: event.target.checked,
                  }))
                }
              />
              Collaboration Flow
            </label>
            <label>
              <input
                type="checkbox"
                checked={operatorPrefs.idleMillingEnabled}
                onChange={(event) =>
                  setOperatorPrefs((prev) => ({
                    ...prev,
                    idleMillingEnabled: event.target.checked,
                  }))
                }
              />
              Idle Milling
            </label>
            <label>
              <input
                type="checkbox"
                checked={operatorPrefs.showInspectorDock}
                onChange={(event) =>
                  setOperatorPrefs((prev) => ({
                    ...prev,
                    showInspectorDock: event.target.checked,
                  }))
                }
              />
              Show Inspector
            </label>
            <label>
              <input
                type="checkbox"
                checked={operatorPrefs.showRailDock}
                onChange={(event) =>
                  setOperatorPrefs((prev) => ({
                    ...prev,
                    showRailDock: event.target.checked,
                  }))
                }
              />
              Show Rail
            </label>
            <label>
              <input
                type="checkbox"
                checked={operatorPrefs.focusMode}
                onChange={(event) =>
                  setOperatorPrefs((prev) => ({
                    ...prev,
                    focusMode: event.target.checked,
                  }))
                }
              />
              Focus Mode
            </label>
            <label>
              <input
                type="checkbox"
                checked={operatorPrefs.quietMode}
                onChange={(event) =>
                  setOperatorPrefs((prev) => ({
                    ...prev,
                    quietMode: event.target.checked,
                  }))
                }
              />
              Quiet Office
            </label>
            <label>
              <input
                type="checkbox"
                checked={operatorPrefs.followSelection}
                onChange={(event) =>
                  setOperatorPrefs((prev) => ({
                    ...prev,
                    followSelection: event.target.checked,
                  }))
                }
              />
              Follow Selected
            </label>
          </div>
          <FieldHelp>
            Focus mode narrows the stage, Quiet Office strips ambient churn, and Follow Selected turns the camera into a
            tighter operator lens.
          </FieldHelp>
        </div>
      </div>
    </>
  );
}
