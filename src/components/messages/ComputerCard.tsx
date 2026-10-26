import type { Control } from "../../lib/types";

/**
 * "Computer" card: the agent asks the user to act inside its browser session.
 * `control` lives in Rust; the buttons call `set_computer_control`.
 */
export function ComputerCard({
  prompt,
  control,
  onControl,
}: {
  prompt: string;
  control: Control;
  onControl: (control: Control) => void;
}) {
  const userHasControl = control === "user";
  return (
    <div className="flex w-[420px] max-w-full flex-col gap-2.5 rounded-2xl bg-bubble p-3">
      <div className="flex items-center self-stretch">
        <p className="text-[14px] font-semibold text-ink">Computer</p>
        <div className="flex-1" />
        {userHasControl ? (
          <ControlPill dot="var(--color-control-dot)" bg="var(--color-control-bg)" ink="var(--color-control-ink)">
            You're in control
          </ControlPill>
        ) : (
          <ControlPill dot="#8A8A88" bg="#E6E6E4" ink="#6E6E6B">
            Agent is in control
          </ControlPill>
        )}
      </div>

      <p className="selectable self-stretch text-[14px] leading-[21px] text-ink">{prompt}</p>

      <LiveViewPlaceholder />

      <div className="flex items-center gap-2 self-stretch">
        <button
          type="button"
          onClick={() => onControl("user")}
          className="rounded-[15px] bg-ink-strong px-[13px] py-1.5 text-[13px] font-medium text-white"
        >
          Take over
        </button>
        {userHasControl && (
          <button
            type="button"
            onClick={() => onControl("agent")}
            className="rounded-[15px] border border-button-line bg-white px-[13px] py-1.5 text-[13px] font-medium text-ink"
          >
            I'm done
          </button>
        )}
      </div>
    </div>
  );
}

function ControlPill({ dot, bg, ink, children }: { dot: string; bg: string; ink: string; children: string }) {
  return (
    <div className="flex items-center gap-[5px] rounded-[11px] py-[3px] pr-2 pl-[7px]" style={{ background: bg }}>
      <div className="size-[5px] rounded-full" style={{ background: dot }} />
      <p className="text-[12px] font-medium" style={{ color: ink }}>
        {children}
      </p>
    </div>
  );
}

/**
 * The mock's illustrated stand-in for the live browser stream (396×250).
 * Replace with real frames (e.g. a <canvas> fed by a Rust event) later.
 */
export function LiveViewPlaceholder() {
  return (
    <div
      className="relative h-[250px] self-stretch overflow-hidden rounded-[10px]"
      style={{ background: "linear-gradient(180deg, #3E6E9C 0%, #9C8FA8 45%, #E9907A 75%, #F0A25A 100%)" }}
    >
      <svg className="absolute top-[95px] left-0" width="396" height="155" viewBox="0 0 396 155" fill="none" aria-hidden>
        <defs>
          <linearGradient id="kbot-live-ridge" x1="198" y1="0" x2="198" y2="155" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#E0532E" />
            <stop offset="1" stopColor="#9C2F1C" />
          </linearGradient>
        </defs>
        <path
          d="M0 45.53C40 34.583 70 1.742 110 12.689C150 23.636 170 56.477 210 45.53C250 34.583 290 -9.205 330 1.742C360 10.5 380 29.11 396 34.583L396 155L0 155L0 45.53Z"
          fill="url(#kbot-live-ridge)"
        />
      </svg>
      <svg className="absolute top-[175px] left-0" width="396" height="75" viewBox="0 0 396 75" fill="none" aria-hidden>
        <defs>
          <linearGradient id="kbot-live-hills" x1="198" y1="0" x2="198" y2="75" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#4A5A26" />
            <stop offset="1" stopColor="#1F2914" />
          </linearGradient>
        </defs>
        <path
          d="M0 27.214C50 8.099 90 36.771 140 31.992C200 25.302 240 -11.015 300 3.321C340 12.878 370 27.214 396 22.435L396 75L0 75L0 27.214Z"
          fill="url(#kbot-live-hills)"
        />
      </svg>

      <div className="absolute top-5 left-[100px] h-[170px] w-[196px] overflow-hidden rounded-[4px] bg-white shadow-[0_6px_18px_rgba(0,0,0,0.2)]">
        <div className="absolute top-0 left-0 h-3 w-[196px] bg-[#F3F3F3]">
          {[5, 10, 15].map((x) => (
            <div key={x} className="absolute top-[4.5px] size-[3px] rounded-full bg-[#CFCFCF]" style={{ left: x }} />
          ))}
        </div>
        <div className="absolute top-4 left-[63px] h-1 w-[70px] rounded-[2px] bg-[#EDEDED]" />
        <div className="absolute top-[46px] left-[90px] size-4 rounded-full bg-[#E6E6E6]" />
        <div className="absolute top-[76px] left-[43px] h-3 w-[110px] rounded-[2px] border-[0.75px] border-[#DDDDDD] bg-white" />
        <div className="absolute top-[94px] left-[43px] h-3 w-[110px] rounded-[2px] border-[0.75px] border-[#DDDDDD] bg-white" />
        <div className="absolute top-[116px] left-[43px] h-[13px] w-[110px] rounded-[2px] bg-[#3A3A3A]" />
      </div>
    </div>
  );
}
