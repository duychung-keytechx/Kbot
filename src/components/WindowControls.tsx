// The mock's three 12px "traffic lights".
//
// macOS (in Tauri): the real ones are drawn by the OS (titleBarStyle "Overlay",
// trafficLightPosition in tauri.conf.json), so we only reserve their space.
// Windows/Linux (decorations: false) and the browser preview: we draw them,
// and inside Tauri they close / minimize / maximize the window.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "../lib/api";
import { isMac } from "../lib/format";

const nativeTrafficLights = isTauri && isMac;

function Light({ color, glyph, label, onClick }: { color: string; glyph: string; label: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="relative flex size-3 shrink-0 items-center justify-center rounded-full"
      style={{ background: color }}
    >
      <svg width="6" height="6" viewBox="0 0 6 6" aria-hidden className="opacity-0 group-hover/lights:opacity-100">
        <path d={glyph} stroke="rgb(0 0 0 / 0.5)" strokeWidth="1.1" strokeLinecap="round" />
      </svg>
    </button>
  );
}

export function WindowControls() {
  if (nativeTrafficLights) {
    // The OS lights are bigger than the mock's on macOS 26 (3 × 14px circles,
    // 23px apart = ~60px vs 52px), so reserve their real width.
    return <div data-tauri-drag-region className="h-3 w-[60px] shrink-0" />;
  }
  const win = isTauri ? getCurrentWindow() : null;
  return (
    <div className="group/lights flex shrink-0 items-center gap-2">
      <Light color="#FF5F57" glyph="M0.5 0.5L5.5 5.5M5.5 0.5L0.5 5.5" label="Close" onClick={() => win?.close()} />
      <Light color="#FEBC2E" glyph="M0.5 3L5.5 3" label="Minimize" onClick={() => win?.minimize()} />
      <Light color="#28C840" glyph="M3 0.5L3 5.5M0.5 3L5.5 3" label="Maximize" onClick={() => win?.toggleMaximize()} />
    </div>
  );
}
