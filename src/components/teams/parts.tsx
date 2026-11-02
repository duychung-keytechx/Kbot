// Small pieces shared by the team views (design/Kbot_agentteam_*.html).

import type { ReactNode } from "react";
import type { Avatar, Bot, BotImage, Team, TaskStatus } from "../../lib/types";
import { BotAvatar } from "../avatars/BotAvatar";

/** A team's avatar: a rounded tile in the team color with three member heads. */
export function TeamAvatar({ color, size = 34 }: { color: string; size?: number }) {
  // Drawn on the mock's 84px tile.
  const heads = [
    [26.6, 14],
    [12.6, 37.8],
    [40.6, 37.8],
  ];
  return (
    <svg width={size} height={size} viewBox="0 0 84 84" aria-hidden className="shrink-0">
      <rect width="84" height="84" rx="22.4" fill={color} />
      {heads.map(([x, y]) => (
        <g key={`${x}-${y}`}>
          <circle cx={x + 15.4} cy={y + 15.4} r="15.4" fill="#fff" />
          <rect x={x + 9.24} y={y + 10.92} width="3.64" height="7.28" rx="1.68" fill={color} />
          <rect x={x + 18.2} y={y + 10.92} width="3.64" height="7.28" rx="1.68" fill={color} />
        </g>
      ))}
    </svg>
  );
}

/** The orchestrator's avatar: a body in the team color wearing a crown. */
export function LeadAvatar({ color, size = 22 }: { color: string; size?: number }) {
  // Drawn on the mock's 22px box.
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" aria-hidden className="shrink-0">
      <rect x="2.93" y="6.6" width="16.13" height="13.93" rx="6.6" fill={color} />
      <path transform="translate(5.87 1.47)" d="M0 5.867L1.467 0L3.667 3.3L5.133 0L6.6 3.3L8.8 0L10.267 5.867L0 5.867Z" fill="var(--color-crown)" />
      <rect x="7.6" y="11.2" width="1.9" height="3.8" rx="0.95" fill="#fff" />
      <rect x="12.5" y="11.2" width="1.9" height="3.8" rx="0.95" fill="#fff" />
    </svg>
  );
}

/** A team bot's avatar: the crown for its orchestrator, its own picture otherwise. */
export function MemberAvatar({ bot, team, size = 22 }: { bot: Pick<Bot, "id" | "avatar">; team?: Team; size?: number }) {
  return team && team.leadId === bot.id ? <LeadAvatar color={team.color} size={size} /> : <BotAvatar avatar={bot.avatar} size={size} />;
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  waiting: "Waiting",
  working: "Working",
  review: "Review",
  done: "Done",
  skipped: "Skipped",
  failed: "Failed",
  blocked: "Needs you",
};

/** "● Working", "✓ Done", "○ Waiting". */
export function StatusLabel({ status }: { status: TaskStatus }) {
  const label = STATUS_LABEL[status];
  switch (status) {
    case "done":
      return (
        <span className="flex shrink-0 items-center gap-1 text-[12px] text-done">
          <svg width="10" height="8" viewBox="-1 -1 12 10" aria-hidden fill="none">
            <path d="M0 4.286L3.25 8L10 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {label}
        </span>
      );
    case "working":
    case "review":
      return (
        <span className="flex shrink-0 items-center gap-[5px] text-[12px] text-working-ink">
          <span className="size-1.5 animate-pulse rounded-full bg-working" />
          {label}
        </span>
      );
    case "failed":
    case "blocked":
      return (
        <span className="flex shrink-0 items-center gap-[5px] text-[12px] text-danger">
          <span className="size-1.5 rounded-full bg-danger" />
          {label}
        </span>
      );
    default:
      return (
        <span className="flex shrink-0 items-center gap-[5px] text-[12px] text-hint">
          <span className="size-1.5 rounded-full border-[1.2px] border-waiting" />
          {label}
        </span>
      );
  }
}

/** A small pill like "1 of 3 done" in the working colors. */
export function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="flex shrink-0 items-center gap-[5px] rounded-[11px] bg-control-bg px-2 py-[3px] text-[12px] font-medium text-working-ink">
      <span className="size-[5px] rounded-full bg-control-dot" />
      {children}
    </span>
  );
}

/** The wizard and settings dialogs' stepper-less header/footer buttons. */
export const cancelButton =
  "rounded-[17px] border border-cancel-line bg-bubble px-4 py-2 text-[14px] font-medium text-ink disabled:opacity-50";
export const okButton =
  "rounded-[17px] bg-ink-strong px-4 py-2 text-[14px] font-medium text-ink-inverse disabled:bg-disabled disabled:text-disabled-ink";
export const field =
  "selectable w-full rounded-[10px] border border-composer-line bg-surface px-3.5 py-2.5 text-[14px] text-ink focus:border-ink focus:shadow-[0_0_0_0.5px_var(--color-ink)]";
export const smallButton =
  "flex items-center gap-1.5 rounded-[15px] border border-button-line bg-surface px-[13px] py-1.5 text-[13px] font-medium text-ink hover:bg-row-hover disabled:opacity-50";

/** Avatar for a wizard member that doesn't exist yet. */
export const imageAvatar = (image: BotImage): Avatar => ({ kind: "image", image });

/** A brief or review from the orchestrator, in a member's chat (peach). */
export function BriefBubble({
  color,
  message,
}: {
  color: string;
  message: { from: string; to: string; text: string; review: boolean };
}) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="flex items-center gap-1.5">
        <LeadAvatar color={color} size={16} />
        <p className="text-[12px] font-medium text-brief-ink">
          {message.from} → {message.to}
          {message.review && " · review"}
        </p>
      </div>
      <div className="rounded-2xl border border-brief-line bg-brief-bg px-3.5 py-[11px]">
        <p className="selectable max-w-[530px] text-[14px] leading-[21px] break-words whitespace-pre-wrap text-ink">
          {message.text}
        </p>
      </div>
    </div>
  );
}

/**
 * A system note. Review round-trips get an icon: a check for "accepted the
 * result", a return arrow for "sent … back".
 */
export function CheckNote({ text }: { text: string }) {
  const icon = /accepted the result/.test(text) ? (
    <svg width="10" height="8" viewBox="-1 -1 12 10" aria-hidden fill="none" className="shrink-0 text-done">
      <path d="M0 4.286L3.25 8L10 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : / back[: ]/.test(text) ? (
    <svg width="14" height="11" viewBox="-0.7 -0.7 15.4 12.4" aria-hidden fill="none" className="shrink-0 text-hint">
      <path
        d="M4.667 0L0 4.889L4.667 9.778M0 4.889L9.333 4.889C11.911 4.889 14 7.078 14 9.778L14 11"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : null;
  return (
    <div className="flex items-center justify-center gap-1.5 self-stretch py-1.5">
      {icon}
      <p className="selectable max-w-[530px] text-center text-[12.5px] text-hint">{text}</p>
    </div>
  );
}

/** "Sales Lead" over a lead or member reply. */
export function Speaker({ avatar, name }: { avatar: ReactNode; name: string }) {
  return (
    <div className="flex items-center gap-1.5">
      {avatar}
      <p className="text-[12px] font-medium text-subtle">{name}</p>
    </div>
  );
}
