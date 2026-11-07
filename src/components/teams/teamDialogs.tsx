// Dialogs shared by the "Create team" wizard and Team settings:
// a new agent in the team (design/Kbot_agentteam_04b_new_agent_in_team.html),
// the "Add existing bot" picker (04) and the flow canvas (11).

import { useEffect, useRef, useState } from "react";
import { errorText } from "../../lib/api";
import { BOT_IMAGES, type Bot, type BotImage, type Flow, MAX_NAME, type Team } from "../../lib/types";
import { BotAvatar } from "../avatars/BotAvatar";
import { ImageAvatar } from "../avatars/ImageAvatar";
import { CloseIcon, SearchIcon } from "../Icons";
import { FlowCanvas, type FlowMember } from "./FlowEditor";
import { cancelButton, field, okButton } from "./parts";

export const randomImage = (): BotImage => BOT_IMAGES[Math.floor(Math.random() * BOT_IMAGES.length)];

/** Escape closes, unless something inside used it. */
export function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

/** The flow without nodes for members that are gone, and waits on removed nodes. */
export function pruneFlow(flow: Flow, memberIds: string[]): Flow {
  const keep = new Set(memberIds);
  const nodes = flow.nodes.filter((n) => keep.has(n.memberId));
  const ids = new Set(nodes.map((n) => n.id));
  return { ...flow, nodes: nodes.map((n) => ({ ...n, after: n.after.filter((a) => ids.has(a)) })) };
}

const modal =
  "flex max-h-full flex-col overflow-hidden rounded-2xl border border-modal-line bg-surface shadow-[0_20px_50px_rgba(0,0,0,0.2),0_2px_6px_rgba(0,0,0,0.06)]";

/** "Create new agent": a bot that joins the team as a member. */
export function NewMemberDialog({
  teamName,
  leadName,
  onAdd,
  onClose,
}: {
  teamName: string;
  leadName: string;
  /** Rejects to show an error and keep the dialog open. */
  onAdd: (name: string, image: BotImage, role: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [image, setImage] = useState<BotImage>(randomImage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const canAdd = name.trim().length > 0 && !busy;
  useEscape(onClose);

  const add = async () => {
    if (!canAdd) return;
    setBusy(true);
    setError(undefined);
    try {
      await onAdd(name.trim(), image, role.trim());
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim p-6" onMouseDown={onClose}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label={`New agent in ${teamName}`}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
        className={`${modal} w-[440px]`}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-divider pr-4 pl-5">
          <p className="text-[15px] font-semibold text-ink">New agent in {teamName}</p>
          <button type="button" aria-label="Close" onClick={onClose} className="flex size-7 items-center justify-center rounded-lg hover:bg-bubble">
            <CloseIcon />
          </button>
        </div>
        <div className="flex min-h-0 flex-col items-center gap-[18px] overflow-y-auto px-5 py-6">
          <span className="rounded-[11px] bg-brief-bg px-2.5 py-[3px] text-[12px] font-medium text-brief-ink">
            Joins {teamName} as a member
          </span>
          <ImageAvatar image={image} size={84} />
          <div role="radiogroup" aria-label="Picture" className="flex flex-wrap justify-center gap-2">
            {BOT_IMAGES.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={s === image}
                aria-label={s}
                onClick={() => setImage(s)}
                className={`flex size-9 items-center justify-center rounded-full ${
                  s === image ? "shadow-[inset_0_0_0_1.5px_var(--color-shape-selected)]" : "hover:bg-bubble"
                }`}
              >
                <ImageAvatar image={s} size={26} />
              </button>
            ))}
          </div>
          <input
            autoFocus
            value={name}
            maxLength={MAX_NAME}
            spellCheck={false}
            placeholder="Name the agent"
            onChange={(e) => setName(e.target.value)}
            className={`${field} h-[42px] text-center`}
          />
          <div className="flex flex-col gap-1.5 self-stretch">
            <label htmlFor="new-member-role" className="text-[13px] text-subtle">
              Role in the team
            </label>
            <textarea
              id="new-member-role"
              rows={2}
              value={role}
              placeholder="e.g. Looks up companies and people on the web"
              onChange={(e) => setRole(e.target.value)}
              className={`${field} resize-none leading-[20px]`}
            />
            <p className="text-[12px] text-hint">{leadName} reads this to decide which tasks to send here.</p>
          </div>
          {error && <p className="text-[12.5px] text-danger">{error}</p>}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2.5 border-t border-divider px-4 pt-3.5 pb-4">
          <button type="button" onClick={onClose} className={cancelButton}>
            Cancel
          </button>
          <button type="submit" disabled={!canAdd} className={okButton}>
            Add to team
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * "Add existing bot": bots not in a team first, then bots in another team
 * (they get moved). Other teams' orchestrators can't move, so aren't listed.
 */
export function AddBotsPicker({
  bots,
  teams,
  exclude,
  onAdd,
  onClose,
}: {
  bots: Bot[];
  teams: Team[];
  /** Bots already in (or added to) this team. */
  exclude: string[];
  onAdd: (bots: Bot[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const leads = new Set(teams.map((t) => t.leadId));
  const q = query.trim().toLowerCase();
  const candidates = bots.filter((b) => !exclude.includes(b.id) && !leads.has(b.id) && b.name.toLowerCase().includes(q));
  const free = candidates.filter((b) => !b.teamId);
  const taken = candidates.filter((b) => b.teamId);
  const teamName = (id: string | null) => teams.find((t) => t.id === id)?.name ?? "another team";

  useEffect(() => {
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const row = (b: Bot, hint: string) => (
    <label key={b.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-row-hover">
      <input type="checkbox" checked={picked.includes(b.id)} onChange={() => toggle(b.id)} className="size-4 accent-[var(--color-ink)]" />
      <BotAvatar avatar={b.avatar} size={24} />
      <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{b.name}</span>
      <span className="shrink-0 text-[12px] text-hint">{hint}</span>
    </label>
  );

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 z-30 mb-2 flex max-h-[360px] w-[340px] flex-col rounded-xl border border-modal-line bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.12),0_1px_3px_rgba(0,0,0,0.06)]"
    >
      <div className="flex items-center gap-2 border-b border-divider px-3 py-2.5">
        <SearchIcon />
        <input
          autoFocus
          value={query}
          placeholder="Search your bots"
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none"
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
        {free.length > 0 && <p className="px-2 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-hint">NOT IN A TEAM</p>}
        {free.map((b) => row(b, "Your bots"))}
        {taken.length > 0 && <p className="px-2 pt-2.5 pb-1 text-[11px] font-semibold tracking-wide text-hint">IN ANOTHER TEAM</p>}
        {taken.map((b) => row(b, `In ${teamName(b.teamId)} · move it here`))}
        {candidates.length === 0 && <p className="px-2 py-3 text-center text-[13px] text-hint">No bots to add</p>}
      </div>
      <div className="flex items-center justify-between border-t border-divider px-3 py-2.5">
        <p className="text-[12px] text-hint">{picked.length} selected</p>
        <button
          type="button"
          disabled={picked.length === 0}
          onClick={() => {
            onAdd(picked.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => !!b));
            onClose();
          }}
          className={`${okButton} px-3 py-1.5 text-[13px]`}
        >
          Add {picked.length || ""} bot{picked.length === 1 ? "" : "s"}
        </button>
      </div>
    </div>
  );
}

/** "Open in editor": the flow canvas, full window. */
export function FlowCanvasModal({
  title,
  flow,
  members,
  leadName,
  leadColor,
  onChange,
  onClose,
}: {
  title: string;
  flow: Flow;
  members: FlowMember[];
  leadName: string;
  leadColor: string;
  onChange: (flow: Flow) => void;
  onClose: () => void;
}) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim p-6" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className={`${modal} h-full w-full max-w-[1200px]`}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-divider pr-3 pl-5">
          <p className="text-[14px] font-semibold text-ink">{title}</p>
          <button type="button" onClick={onClose} className={`${okButton} px-3.5 py-1.5 text-[13px]`}>
            Done
          </button>
        </div>
        <div className="relative min-h-0 flex-1">
          <FlowCanvas flow={flow} members={members} leadName={leadName} leadColor={leadColor} onChange={onChange} />
        </div>
      </div>
    </div>
  );
}
