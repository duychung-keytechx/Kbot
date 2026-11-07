// The two Flow editors for a team's custom flow:
//  - FlowStepsList: design/Kbot_agentteam_10_flow_steps_list.html (fits the wizard)
//  - FlowCanvas:    design/Kbot_agentteam_11_flow_canvas.html (wide editor)
// Dragging uses pointer events, not HTML5 drag and drop, which Tauri's
// file-drop handler swallows.

import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { type Avatar, type Flow, type FlowInput, type FlowNode, MAX_RUNS, newFlowNode, type OnFail } from "../../lib/types";
import { BotAvatar } from "../avatars/BotAvatar";
import { Switch } from "../fields";
import { LeadAvatar, smallButton } from "./parts";

export type FlowMember = { id: string; name: string; avatar: Avatar };

// ---------------------------------------------------------------------------
// Model helpers (mirror `Flow::normalized` and `Flow::waits_for` in models.rs)

/**
 * Drops nodes of unknown members, renumbers steps from 0 without gaps (steps
 * may be fractional while editing, e.g. -0.5 for "before the first"), keeps
 * waits that point at an earlier step and clamps runs.
 */
function normalize(flow: Flow, members: FlowMember[]): Flow {
  const known = new Set(members.map((m) => m.id));
  const nodes = flow.nodes.filter((n) => n.id && known.has(n.memberId));
  const steps = [...new Set(nodes.map((n) => n.step))].sort((a, b) => a - b);
  const renumbered = nodes.map((n) => ({
    ...n,
    step: steps.indexOf(n.step),
    runs: Math.min(MAX_RUNS, Math.max(1, Math.round(n.runs) || 1)),
  }));
  const stepOf = new Map(renumbered.map((n) => [n.id, n.step]));
  const out = renumbered.map((n) => ({
    ...n,
    after: [...new Set(n.after)].filter((id) => (stepOf.get(id) ?? Infinity) < n.step),
  }));
  out.sort((a, b) => a.step - b.step); // stable: keeps the order within a step
  return { ...flow, nodes: out };
}

/** The nodes `node` waits for: its own `after`, or every node of the nearest earlier step. */
function waitsFor(nodes: FlowNode[], node: FlowNode): FlowNode[] {
  if (node.after.length > 0) {
    return node.after.map((id) => nodes.find((n) => n.id === id)).filter((n): n is FlowNode => !!n);
  }
  const earlier = nodes.filter((n) => n.step < node.step).map((n) => n.step);
  if (earlier.length === 0) return [];
  const before = Math.max(...earlier);
  return nodes.filter((n) => n.step === before);
}

/** What `waitsFor` gives when `after` is empty. */
const defaultWaits = (nodes: FlowNode[], node: FlowNode) => waitsFor(nodes, { ...node, after: [] });

/** Nodes by step, in order. */
const groupSteps = (nodes: FlowNode[]) => {
  const count = nodes.reduce((m, n) => Math.max(m, n.step + 1), 0);
  return Array.from({ length: count }, (_, i) => nodes.filter((n) => n.step === i));
};

/** `node` with `ids` as what it waits for; the default set is stored as `[]`. */
function withWaits(nodes: FlowNode[], node: FlowNode, ids: string[]): FlowNode {
  const def = defaultWaits(nodes, node).map((n) => n.id);
  const same = def.length === ids.length && def.every((id) => ids.includes(id));
  return { ...node, after: same ? [] : ids };
}

/** Moves (or inserts) `node` into `step`, before the `index`-th node already there. */
function place(nodes: FlowNode[], node: FlowNode, step: number, index: number): FlowNode[] {
  const rest = nodes.filter((n) => n.id !== node.id);
  const before = rest.filter((n) => n.step === step)[index];
  const moved = { ...node, step };
  if (before) rest.splice(rest.indexOf(before), 0, moved);
  else rest.push(moved);
  return rest;
}

/** "A", "A and B", "A, B and C". */
const listNames = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** "Starts when A is done", "…when A and B are both done", "…are all done". */
function whenDone(names: string[]) {
  const who = listNames(names);
  return names.length === 1 ? `${who} is done` : names.length === 2 ? `${who} are both done` : `${who} are all done`;
}

/** "Sales Outbound and Researcher start together → Account Manager starts when Sales Outbound is done → … → {lead} reviews and replies." */
export function describeRunOrder(flow: Flow, members: FlowMember[], leadName: string): string {
  const view = normalize(flow, members);
  const name = (n: FlowNode) => members.find((m) => m.id === n.memberId)?.name ?? "";
  const parts: string[] = [];
  for (const step of groupSteps(view.nodes)) {
    // Nodes of a step that wait for the same nodes read as one clause.
    const groups = new Map<string, FlowNode[]>();
    for (const n of step) {
      const key = waitsFor(view.nodes, n)
        .map((w) => w.id)
        .sort()
        .join(",");
      groups.set(key, [...(groups.get(key) ?? []), n]);
    }
    for (const group of groups.values()) {
      const who = listNames(group.map(name));
      const plural = group.length > 1;
      const waits = waitsFor(view.nodes, group[0]);
      let clause =
        waits.length === 0
          ? plural
            ? `${who} start together`
            : `${who} starts first`
          : `${who} ${plural ? "start" : "starts"} when ${whenDone(waits.map(name))}`;
      const loops = group.filter((n) => n.runs > 1);
      if (!plural && loops.length === 1) clause += `, and runs up to ${loops[0].runs} times`;
      else for (const n of loops) clause += `; ${name(n)} runs up to ${n.runs} times`;
      parts.push(clause);
    }
  }
  if (parts.length === 0) return `Add members to set the order. ${leadName} reviews and replies.`;
  return [...parts, `${leadName} reviews and replies.`].join(" → ");
}

/** Shared editing calls for both editors. */
function useFlowEdits(flow: Flow, members: FlowMember[], onChange: (flow: Flow) => void) {
  const view = useMemo(() => normalize(flow, members), [flow, members]);
  const update = (fn: (nodes: FlowNode[]) => FlowNode[]) => onChange(normalize({ ...view, nodes: fn(view.nodes) }, members));
  const patch = (id: string, p: Partial<FlowNode>) => update((nodes) => nodes.map((n) => (n.id === id ? { ...n, ...p } : n)));
  const remove = (id: string) =>
    update((nodes) => nodes.filter((n) => n.id !== id).map((n) => ({ ...n, after: n.after.filter((a) => a !== id) })));
  /** Turns waiting for `waitId` on or off; the last wait can't be turned off. */
  const toggleWait = (node: FlowNode, waitId: string) =>
    update((nodes) => {
      const current = waitsFor(nodes, node).map((n) => n.id);
      const next = current.includes(waitId) ? current.filter((id) => id !== waitId) : [...current, waitId];
      if (next.length === 0) return nodes;
      return nodes.map((n) => (n.id === node.id ? withWaits(nodes, n, next) : n));
    });
  return { view, update, patch, remove, toggleWait };
}

// ---------------------------------------------------------------------------
// Small parts

function GripIcon() {
  return (
    <svg width="8.4" height="14" viewBox="0 0 8.4 14" aria-hidden className="shrink-0">
      {[1, 5.8, 10.6].flatMap((y) =>
        [1, 5].map((x) => <circle key={`${x}-${y}`} cx={x + 1.2} cy={y + 1.2} r="1.2" fill="var(--color-waiting)" />),
      )}
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className="shrink-0">
      {[2.3, 7, 11.7].map((x) => (
        <circle key={x} cx={x} cy="7" r="1.3" fill="var(--color-hint)" />
      ))}
    </svg>
  );
}

function PlusIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden fill="none" className="shrink-0">
      <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function WaitIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden fill="none" className="shrink-0">
      <path d="M3 2v5.5a2 2 0 0 0 2 2h6M8.5 7l2.5 2.5L8.5 12" stroke="var(--color-hint)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LoopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden fill="none" className="shrink-0">
      <path
        d="M2.5 6.5a4 4 0 0 1 7-2.6M11.5 7.5a4 4 0 0 1-7 2.6M9.6 1.6l.1 2.5-2.5.1M4.4 12.4l-.1-2.5 2.5-.1"
        stroke="var(--color-subtle)"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden fill="none" className="shrink-0">
      <path d="M1 1l6 6M7 1L1 7" stroke="var(--color-hint)" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function CheckBox({ checked }: { checked: boolean }) {
  return checked ? (
    <span className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-ink-strong">
      <svg width="9" height="7.4" viewBox="0 0 9 7.4" aria-hidden fill="none">
        <path d="M1 3.8L3.4 6.2L8 1" stroke="var(--color-ink-inverse)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  ) : (
    <span className="size-4 shrink-0 rounded-[4px] border-[1.3px] border-radio-line bg-surface" />
  );
}

/** − N + */
function Stepper({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  const btn = "flex size-[26px] items-center justify-center text-[14px] font-medium text-subtle disabled:opacity-35";
  return (
    <div className="flex shrink-0 items-center rounded-[8px] border border-composer-line bg-surface px-0.5 py-px">
      <button type="button" aria-label={`Fewer ${label}`} disabled={value <= 1} onClick={() => onChange(value - 1)} className={btn}>
        −
      </button>
      <span aria-label={label} className="w-7 text-center text-[13px] font-medium text-ink">
        {value}
      </span>
      <button type="button" aria-label={`More ${label}`} disabled={value >= MAX_RUNS} onClick={() => onChange(value + 1)} className={btn}>
        +
      </button>
    </div>
  );
}

/** "N run together" in the mock's blue. */
function TogetherChip({ children }: { children: ReactNode }) {
  return (
    <span
      style={{ background: "color-mix(in srgb, var(--color-unread) 14%, transparent)", color: "var(--color-unread)" }}
      className="shrink-0 rounded-[11px] px-2 py-[3px] text-[12px] font-medium"
    >
      {children}
    </span>
  );
}

function RunsChip({ runs }: { runs: number }) {
  return (
    <span className="flex shrink-0 items-center gap-[5px] rounded-[11px] bg-bubble py-[3px] pr-2 pl-1.5 text-[12px] font-medium text-subtle">
      <LoopIcon />
      {runs}×
    </span>
  );
}

function StepNumber({ n, size = 20 }: { n: number; size?: number }) {
  return (
    <span
      style={{ width: size, height: size }}
      className="flex shrink-0 items-center justify-center rounded-full bg-ink text-[11px] font-semibold text-ink-inverse"
    >
      {n}
    </span>
  );
}

/** Closes on a click outside `ref` or Escape (which it keeps from closing the dialog). */
function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => ref.current?.contains(e.target as Node) || onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("mousedown", down);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key, true);
    };
  }, [ref, open, onClose]);
}

/** A list of members to pick from; members already in the flow say where. */
function MemberPicker({
  members,
  nodes,
  onPick,
  onClose,
  className,
}: {
  members: FlowMember[];
  nodes: FlowNode[];
  onPick: (memberId: string) => void;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, true, onClose);
  return (
    <div
      ref={ref}
      role="menu"
      className={`absolute z-30 flex max-h-[260px] w-[240px] flex-col gap-0.5 overflow-y-auto rounded-xl border border-modal-line bg-surface p-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.12),0_1px_3px_rgba(0,0,0,0.06)] ${className ?? ""}`}
    >
      {members.length === 0 ? (
        <p className="px-2.5 py-2 text-[12.5px] text-hint">Add members to the team first.</p>
      ) : (
        members.map((m) => {
          const steps = [...new Set(nodes.filter((n) => n.memberId === m.id).map((n) => n.step + 1))];
          return (
            <button
              key={m.id}
              type="button"
              role="menuitem"
              onClick={() => {
                onPick(m.id);
                onClose();
              }}
              className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-row-hover"
            >
              <BotAvatar avatar={m.avatar} size={22} />
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{m.name}</span>
              {steps.length > 0 && (
                <span className="shrink-0 text-[11.5px] text-hint">in step {listNames(steps.map(String))}</span>
              )}
            </button>
          );
        })
      )}
    </div>
  );
}

/** Lead's "plans" / "reviews and replies" rows at both ends of the steps list. */
function Endpoint({ color, title, subtitle }: { color: string; title: string; subtitle: string }) {
  return (
    <div className="flex items-center gap-2.5 self-stretch rounded-[10px] border border-button-line py-2 pr-3 pl-2.5">
      <LeadAvatar color={color} size={24} />
      <p className="truncate text-[13px] font-medium text-ink">{title}</p>
      <p className="truncate text-[12px] text-hint">{subtitle}</p>
    </div>
  );
}

function Link() {
  return (
    <div className="flex self-stretch pl-[22px]">
      <div className="h-3 w-[1.5px] bg-checkbox-line" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Option A: steps list

type ListDrag = { id: string; x: number; y: number; target?: string };

export function FlowStepsList({
  flow,
  members,
  leadName,
  leadColor,
  onChange,
}: {
  flow: Flow;
  members: FlowMember[];
  leadName: string;
  leadColor: string;
  onChange: (flow: Flow) => void;
}) {
  const { view, update, patch, remove, toggleWait } = useFlowEdits(flow, members, onChange);
  const steps = groupSteps(view.nodes);
  const memberOf = (n: FlowNode) => members.find((m) => m.id === n.memberId)!;
  // The card whose ⋯ section is open, and the one whose waits are being edited.
  const [open, setOpen] = useState<string>();
  const [editing, setEditing] = useState<string>();
  // Which "Add member" picker is open: a step index, or steps.length for "Add step".
  const [picker, setPicker] = useState<number>();
  const [drag, setDrag] = useState<ListDrag>();

  const add = (memberId: string, step: number) => update((nodes) => [...nodes, newFlowNode(memberId, step)]);

  /** "step:N", "node:ID" or "new" under the pointer. */
  const dropTarget = (x: number, y: number) =>
    document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]")?.dataset.drop;

  const drop = (d: ListDrag) => {
    const node = view.nodes.find((n) => n.id === d.id);
    if (!node || !d.target) return;
    const [kind, value] = d.target.split(":");
    update((nodes) => {
      if (kind === "new") return place(nodes, node, steps.length, 0);
      if (kind === "step") return place(nodes, node, Number(value), Infinity);
      const before = nodes.find((n) => n.id === value);
      if (!before || before.id === node.id) return nodes;
      const col = nodes.filter((n) => n.step === before.step && n.id !== node.id);
      return place(nodes, node, before.step, col.indexOf(before));
    });
  };

  const highlighted = (target: string) => drag?.target === target;

  return (
    <div className="flex flex-col gap-0 self-stretch">
      <Endpoint color={leadColor} title={`${leadName} plans`} subtitle="writes each member's brief" />
      <Link />
      {steps.map((col, i) => (
        <div key={i} className="flex flex-col self-stretch">
          <div
            data-drop={`step:${i}`}
            className={`flex flex-col gap-2 self-stretch rounded-xl bg-sidebar p-2.5 ${
              highlighted(`step:${i}`) ? "shadow-[inset_0_0_0_1.5px_var(--color-ink)]" : ""
            }`}
          >
            <div className="flex items-center gap-2">
              <StepNumber n={i + 1} />
              <p className="text-[13.5px] font-semibold text-ink">{i === 0 ? "Starts first" : "Then"}</p>
              <div className="flex-1" />
              {col.length > 1 && <TogetherChip>{col.length} run together</TogetherChip>}
            </div>
            {col.map((node) => {
              const member = memberOf(node);
              const waits = waitsFor(view.nodes, node);
              const earlier = view.nodes.filter((n) => n.step < node.step);
              return (
                <div key={node.id} className={`flex flex-col gap-1.5 self-stretch ${drag?.id === node.id ? "opacity-40" : ""}`}>
                  <div
                    data-drop={`node:${node.id}`}
                    className={`flex items-center gap-2.5 self-stretch rounded-[10px] border bg-surface py-[9px] pr-2.5 pl-2 ${
                      highlighted(`node:${node.id}`) ? "border-ink" : "border-modal-line"
                    }`}
                  >
                    <span
                      role="button"
                      aria-label={`Drag ${member.name} to another step`}
                      title="Drag to another step"
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.preventDefault();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        setDrag({ id: node.id, x: e.clientX, y: e.clientY });
                      }}
                      onPointerMove={(e) =>
                        drag && setDrag({ ...drag, x: e.clientX, y: e.clientY, target: dropTarget(e.clientX, e.clientY) })
                      }
                      onPointerUp={(e) => {
                        // Where the pointer is now, even if no move landed in between.
                        if (drag) drop({ ...drag, target: dropTarget(e.clientX, e.clientY) });
                        setDrag(undefined);
                      }}
                      onPointerCancel={() => setDrag(undefined)}
                      className="flex h-6 cursor-grab touch-none items-center px-0.5 active:cursor-grabbing"
                    >
                      <GripIcon />
                    </span>
                    <BotAvatar avatar={member.avatar} size={24} />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <p className="truncate text-[13.5px] font-medium text-ink">{member.name}</p>
                        {node.runs > 1 && <RunsChip runs={node.runs} />}
                      </div>
                      <input
                        value={node.task}
                        onChange={(e) => patch(node.id, { task: e.target.value })}
                        placeholder="What should it do in this flow?"
                        aria-label={`${member.name}'s task`}
                        spellCheck={false}
                        className="w-full bg-transparent text-[12px] text-subtle placeholder:text-placeholder"
                      />
                    </div>
                    <button
                      type="button"
                      aria-label={`${member.name} options`}
                      aria-expanded={open === node.id}
                      onClick={() => setOpen(open === node.id ? undefined : node.id)}
                      className={`flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-row-hover ${
                        open === node.id ? "bg-row-hover" : ""
                      }`}
                    >
                      <MoreIcon />
                    </button>
                  </div>

                  {i > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 self-stretch pl-11">
                      <WaitIcon />
                      <span className="text-[12px] text-hint">Waits for</span>
                      {editing === node.id ? (
                        <>
                          {earlier.map((e) => {
                            const on = waits.some((w) => w.id === e.id);
                            const m = memberOf(e);
                            return (
                              <button
                                key={e.id}
                                type="button"
                                aria-pressed={on}
                                disabled={on && waits.length === 1}
                                title={on && waits.length === 1 ? "It has to wait for at least one" : undefined}
                                onClick={() => toggleWait(node, e.id)}
                                className={`flex items-center gap-[5px] rounded-[11px] py-[3px] pr-2 pl-1.5 text-[12px] font-medium ${
                                  on
                                    ? "bg-surface text-ink shadow-[inset_0_0_0_1px_var(--color-ink)]"
                                    : "bg-surface/50 text-hint shadow-[inset_0_0_0_1px_var(--color-modal-line)]"
                                }`}
                              >
                                <BotAvatar avatar={m.avatar} size={14} />
                                {m.name}
                                <span className="font-normal text-hint">· {e.step + 1}</span>
                              </button>
                            );
                          })}
                          <button
                            type="button"
                            onClick={() => setEditing(undefined)}
                            className="rounded-[11px] bg-bubble px-2 py-[3px] text-[12px] font-medium text-subtle hover:bg-row-hover"
                          >
                            Done
                          </button>
                        </>
                      ) : (
                        <>
                          {waits.map((w) => {
                            const m = memberOf(w);
                            return (
                              <span
                                key={w.id}
                                className="flex items-center gap-[5px] rounded-[11px] bg-surface py-[3px] pr-2 pl-1.5 text-[12px] font-medium text-ink"
                              >
                                <BotAvatar avatar={m.avatar} size={14} />
                                {m.name}
                                {waits.length > 1 && (
                                  <button
                                    type="button"
                                    aria-label={`Don't wait for ${m.name}`}
                                    onClick={() => toggleWait(node, w.id)}
                                    className="-mr-0.5 flex size-3.5 items-center justify-center rounded-full hover:bg-row-hover"
                                  >
                                    <XIcon />
                                  </button>
                                )}
                              </span>
                            );
                          })}
                          {earlier.length > waits.length || waits.length > 1 ? (
                            <button
                              type="button"
                              onClick={() => setEditing(node.id)}
                              className="rounded-[11px] bg-bubble px-2 py-[3px] text-[12px] font-medium text-subtle hover:bg-row-hover"
                            >
                              Edit
                            </button>
                          ) : null}
                        </>
                      )}
                    </div>
                  )}

                  {open === node.id && (
                    <div className="flex flex-wrap items-center gap-2 self-stretch pl-11">
                      <LoopIcon />
                      <span className="text-[12px] text-hint">Runs</span>
                      <Stepper value={node.runs} label="runs" onChange={(runs) => patch(node.id, { runs })} />
                      <span className="text-[12px] text-hint">times · each run improves the last</span>
                      <div className="flex-1" />
                      <button
                        type="button"
                        onClick={() => {
                          setOpen(undefined);
                          remove(node.id);
                        }}
                        className="text-[12px] font-medium text-danger hover:underline"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            <div className="relative flex">
              <button
                type="button"
                onClick={() => setPicker(picker === i ? undefined : i)}
                className="flex items-center gap-1.5 px-1 pt-0.5 text-[12px] font-medium text-subtle hover:text-ink"
              >
                <PlusIcon />
                Add member to step {i + 1}
              </button>
              {picker === i && (
                <MemberPicker
                  members={members}
                  nodes={view.nodes}
                  onPick={(id) => add(id, i)}
                  onClose={() => setPicker(undefined)}
                  className="top-full left-0 mt-1"
                />
              )}
            </div>
          </div>
          <Link />
        </div>
      ))}
      <div className="relative flex flex-col self-stretch">
        <button
          type="button"
          data-drop="new"
          onClick={() => setPicker(picker === steps.length ? undefined : steps.length)}
          className={`flex items-center justify-center gap-1.5 self-stretch rounded-[10px] border border-dashed py-[9px] text-[12.5px] font-medium text-subtle hover:bg-row-hover ${
            highlighted("new") ? "border-ink bg-row-hover" : "border-checkbox-line"
          }`}
        >
          <PlusIcon />
          {steps.length === 0 ? "Add the first step" : "Add step"}
        </button>
        {picker === steps.length && (
          <MemberPicker
            members={members}
            nodes={view.nodes}
            onPick={(id) => add(id, steps.length)}
            onClose={() => setPicker(undefined)}
            className="top-full left-1/2 mt-1 -translate-x-1/2"
          />
        )}
      </div>
      <Link />
      <Endpoint color={leadColor} title={`${leadName} reviews and replies`} subtitle="one answer to you" />
      <div className="mt-3.5 rounded-xl border border-modal-line py-0.5 pr-3.5 pl-4">
        <Switch checked={flow.skipUnneeded} onChange={(skipUnneeded) => onChange({ ...view, skipUnneeded })}>
          <span className="flex flex-col gap-0.5">
            <span className="text-[13.5px] text-ink">Skip members a request doesn't need</span>
            <span className="text-[12px] text-hint">{leadName} can leave out a step, but never changes the order</span>
          </span>
        </Switch>
      </div>

      {drag && (
        <div
          style={{ left: drag.x + 12, top: drag.y + 8 }}
          className="pointer-events-none fixed z-50 flex items-center gap-2 rounded-[10px] border border-modal-line bg-surface px-2.5 py-1.5 text-[13px] font-medium text-ink shadow-[0_8px_24px_rgba(0,0,0,0.14)]"
        >
          {(() => {
            const n = view.nodes.find((x) => x.id === drag.id);
            const m = n && memberOf(n);
            return m ? (
              <>
                <BotAvatar avatar={m.avatar} size={18} />
                {m.name}
              </>
            ) : null;
          })()}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Option B: canvas

// Geometry of the mock's canvas (design/Kbot_agentteam_11_flow_canvas.html).
const END_X = 16;
const END_W = 104;
const END_H = 74;
const COL_X0 = 146;
const COL_W = 178;
const PITCH = 204;
const COL_TOP = 50;
const MIN_COL_H = 340;
const CARD_W = 162;
const CARD_H = 60;
const CARD_GAP = 24;
const ADD_W = 88;
const BOTTOM = 84; // room for the palette and zoom overlays

type CanvasDrag =
  | { kind: "link"; from: string; x: number; y: number; over?: string }
  | { kind: "move"; id: string; x: number; y: number; sx: number; sy: number; offX: number; offY: number; moved: boolean }
  | { kind: "new"; memberId: string; x: number; y: number; sx: number; sy: number; moved: boolean };

const ZOOMS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5];

export function FlowCanvas({
  flow,
  members,
  leadName,
  leadColor,
  onChange,
}: {
  flow: Flow;
  members: FlowMember[];
  leadName: string;
  leadColor: string;
  onChange: (flow: Flow) => void;
}) {
  const { view, update, patch, remove, toggleWait } = useFlowEdits(flow, members, onChange);
  const steps = groupSteps(view.nodes);
  const memberOf = (n: FlowNode) => members.find((m) => m.id === n.memberId)!;
  const [selectedId, setSelectedId] = useState<string>();
  const selected = view.nodes.find((n) => n.id === selectedId);
  const [drag, setDrag] = useState<CanvasDrag>();
  const [zoom, setZoom] = useState(1);
  const [adding, setAdding] = useState(false);
  const content = useRef<HTMLDivElement>(null);

  // Layout: columns share the tallest column's height; cards are centered in theirs.
  const colH = Math.max(MIN_COL_H, ...steps.map((col) => col.length * CARD_H + (col.length - 1) * CARD_GAP + 88));
  const midY = COL_TOP + colH / 2;
  const pos = new Map<string, { x: number; y: number }>();
  steps.forEach((col, i) => {
    const stackH = col.length * CARD_H + (col.length - 1) * CARD_GAP;
    const top = COL_TOP + (colH - stackH) / 2;
    col.forEach((n, j) => pos.set(n.id, { x: COL_X0 + i * PITCH + 8, y: top + j * (CARD_H + CARD_GAP) }));
  });
  const addX = COL_X0 + steps.length * PITCH;
  const endX = addX + ADD_W + 26;
  const width = endX + END_W + 24;
  const height = COL_TOP + colH + BOTTOM;

  // Edges: lead → first step, waits, and nodes nobody waits for → lead.
  const waited = new Set<string>();
  const edges: { from: string | "plans"; to: string | "replies" }[] = [];
  for (const n of view.nodes) {
    const waits = waitsFor(view.nodes, n);
    if (waits.length === 0) edges.push({ from: "plans", to: n.id });
    for (const w of waits) {
      edges.push({ from: w.id, to: n.id });
      waited.add(w.id);
    }
  }
  for (const n of view.nodes) if (!waited.has(n.id)) edges.push({ from: n.id, to: "replies" });

  const outPoint = (id: string) =>
    id === "plans" ? { x: END_X + END_W, y: midY } : { x: pos.get(id)!.x + CARD_W, y: pos.get(id)!.y + CARD_H / 2 };
  const inPoint = (id: string) => (id === "replies" ? { x: endX, y: midY } : { x: pos.get(id)!.x, y: pos.get(id)!.y + CARD_H / 2 });

  /** Pointer position in canvas (unzoomed) coordinates. */
  const local = (clientX: number, clientY: number) => {
    const r = content.current!.getBoundingClientRect();
    return { x: (clientX - r.left) / zoom, y: (clientY - r.top) / zoom };
  };

  /** Where a card dropped at (x, y) goes: a step (fractional = a new one) and its place in it. */
  const targetOf = (x: number, y: number, exclude?: string) => {
    let step: number;
    if (x < COL_X0 - 13) step = -0.5;
    else {
      const i = Math.floor((x - COL_X0 + 13) / PITCH);
      step = i >= steps.length ? steps.length : i;
    }
    const col = view.nodes.filter((n) => n.step === step && n.id !== exclude);
    const index = col.filter((n) => pos.get(n.id)!.y + CARD_H / 2 < y).length;
    return { step, index };
  };
  const dropStep =
    drag && drag.kind !== "link" && drag.moved
      ? targetOf(drag.x, drag.y, drag.kind === "move" ? drag.id : undefined).step
      : undefined;

  const nodeAt = (clientX: number, clientY: number) =>
    document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-node]")?.dataset.node;

  /** `to` waits for `from`; if `to` isn't later, it moves to just after `from`. */
  const connect = (fromId: string, toId: string) =>
    update((nodes) => {
      const from = nodes.find((n) => n.id === fromId);
      const to = nodes.find((n) => n.id === toId);
      if (!from || !to || from.id === to.id) return nodes;
      if (to.step > from.step) {
        const ids = [...new Set([...waitsFor(nodes, to).map((n) => n.id), from.id])];
        return nodes.map((n) => (n.id === to.id ? withWaits(nodes, n, ids) : n));
      }
      return nodes.map((n) => (n.id === to.id ? { ...n, step: from.step + 0.5, after: [from.id] } : n));
    });

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const { x, y } = local(e.clientX, e.clientY);
    if (drag.kind === "link") setDrag({ ...drag, x, y, over: nodeAt(e.clientX, e.clientY) });
    else setDrag({ ...drag, x, y, moved: drag.moved || Math.hypot(x - drag.sx, y - drag.sy) > 3 / zoom });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const last = drag;
    setDrag(undefined);
    if (!last) return;
    // Where the pointer is now, even if no move landed in between.
    const { x, y } = local(e.clientX, e.clientY);
    const d =
      last.kind === "link"
        ? last
        : { ...last, x, y, moved: last.moved || Math.hypot(x - last.sx, y - last.sy) > 3 / zoom };
    if (d.kind === "link") {
      const over = nodeAt(e.clientX, e.clientY);
      if (over) connect(d.from, over);
    } else if (d.kind === "move") {
      if (!d.moved) return setSelectedId(d.id);
      const node = view.nodes.find((n) => n.id === d.id);
      if (!node) return;
      const t = targetOf(d.x, d.y, d.id);
      update((nodes) => place(nodes, node, t.step, t.index));
    } else {
      const node = newFlowNode(d.memberId, steps.length);
      if (d.moved) {
        const t = targetOf(d.x, d.y);
        update((nodes) => place(nodes, node, t.step, t.index));
      } else update((nodes) => [...nodes, node]);
      setSelectedId(node.id);
    }
  };

  /** Orders each column by where the cards it waits for sit, so arrows cross less. */
  const tidy = () =>
    update((nodes) => {
      const rank = new Map<string, number>();
      const out: FlowNode[] = [];
      groupSteps(nodes).forEach((col) => {
        const score = (n: FlowNode) => {
          const w = waitsFor(nodes, n);
          return w.length ? w.reduce((s, x) => s + (rank.get(x.id) ?? 0), 0) / w.length : nodes.indexOf(n);
        };
        const sorted = [...col].sort((a, b) => score(a) - score(b));
        sorted.forEach((n, i) => rank.set(n.id, i));
        out.push(...sorted);
      });
      return out;
    });

  const zoomBy = (dir: number) => {
    const i = ZOOMS.indexOf(zoom);
    setZoom(ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (i < 0 ? 5 : i) + dir))]);
  };

  const highlight = (e: { from: string; to: string }) => !!selectedId && (e.from === selectedId || e.to === selectedId);

  return (
    <div className="flex h-full min-h-0 w-full">
      <div className="flex min-w-0 flex-1 flex-col gap-3 px-5 pt-4 pb-[18px]">
        <div className="flex items-center gap-2.5">
          <p className="text-[15px] font-semibold text-ink">Flow</p>
          <div className="ml-2 flex items-center gap-3.5">
            <span className="flex items-center gap-1.5 text-[12px] text-subtle">
              <span className="size-3 rounded-[3px] border border-shape-selected bg-bubble" />
              Same column runs together
            </span>
            <span className="flex items-center gap-1.5 text-[12px] text-subtle">
              <svg width="18" height="10" viewBox="0 0 18 10" aria-hidden fill="none">
                <path d="M1 5h14M12 2l3 3-3 3" stroke="var(--color-hint)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              waits for
            </span>
          </div>
          <div className="flex-1" />
          <button type="button" onClick={tidy} disabled={view.nodes.length < 2} className={smallButton}>
            Tidy up
          </button>
        </div>

        <div
          className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-modal-line bg-main"
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => setDrag(undefined)}
        >
          <div className="absolute inset-0 overflow-auto">
            <div style={{ width: width * zoom, height: height * zoom }}>
              <div
                ref={content}
                style={{ width, height, transform: `scale(${zoom})`, transformOrigin: "0 0" }}
                className="relative"
                onPointerDown={(e) => e.target === e.currentTarget && setSelectedId(undefined)}
              >
                {/* Columns */}
                {steps.map((col, i) => (
                  <div key={i}>
                    <div
                      style={{ left: COL_X0 + i * PITCH + 4, top: 18 }}
                      className="absolute flex items-center gap-[7px] whitespace-nowrap"
                    >
                      <StepNumber n={i + 1} size={18} />
                      <p className="text-[12.5px] font-semibold text-ink">{i === 0 ? "Starts first" : "Then"}</p>
                      {col.length > 1 && <TogetherChip>{col.length} together</TogetherChip>}
                    </div>
                    <div
                      style={{ left: COL_X0 + i * PITCH, top: COL_TOP, width: COL_W, height: colH }}
                      className={`pointer-events-none absolute rounded-xl bg-bubble ${
                        dropStep === i ? "shadow-[inset_0_0_0_1.5px_var(--color-ink)]" : ""
                      }`}
                    />
                  </div>
                ))}

                {/* Add step / drop here */}
                <button
                  type="button"
                  onClick={() => setAdding((a) => !a)}
                  style={{ left: addX, top: COL_TOP, width: ADD_W, height: colH }}
                  className={`absolute flex flex-col items-center gap-1.5 rounded-xl border border-dashed pt-[46px] hover:bg-row-hover ${
                    dropStep === steps.length ? "border-ink bg-row-hover" : "border-checkbox-line"
                  }`}
                >
                  <span className="text-subtle">
                    <PlusIcon />
                  </span>
                  <span className="text-[12px] font-medium text-subtle">Add step</span>
                  <span className="text-[11px] text-hint">drop here</span>
                </button>
                {adding && (
                  <div style={{ left: addX, top: COL_TOP + 130 }} className="absolute">
                    <MemberPicker
                      members={members}
                      nodes={view.nodes}
                      onPick={(id) => {
                        const node = newFlowNode(id, steps.length);
                        update((nodes) => [...nodes, node]);
                        setSelectedId(node.id);
                      }}
                      onClose={() => setAdding(false)}
                      className="top-0 left-0"
                    />
                  </div>
                )}

                {/* Lead: plans and replies */}
                {[
                  { x: END_X, label: "plans" },
                  { x: endX, label: "replies" },
                ].map((end) => (
                  <div
                    key={end.label}
                    style={{ left: end.x, top: midY - END_H / 2, width: END_W, height: END_H }}
                    className="absolute flex flex-col items-center justify-center gap-1 rounded-[10px] border border-dashed border-button-line bg-surface px-2"
                  >
                    <LeadAvatar color={leadColor} size={24} />
                    <p className="max-w-full truncate text-center text-[12px] font-medium text-ink">{leadName}</p>
                    <p className="text-center text-[11px] text-hint">{end.label}</p>
                  </div>
                ))}

                {/* Arrows */}
                <svg width={width} height={height} className="pointer-events-none absolute top-0 left-0 overflow-visible" aria-hidden>
                  {edges.map((e) => {
                    const a = outPoint(e.from);
                    const b = inPoint(e.to);
                    const on = highlight(e);
                    const color = on ? "var(--color-ink)" : "var(--color-waiting)";
                    const dx = Math.max(20, (b.x - a.x) / 2);
                    return (
                      <g key={`${e.from}-${e.to}`}>
                        <path
                          d={`M${a.x} ${a.y} C${a.x + dx} ${a.y} ${b.x - dx} ${b.y} ${b.x - 5} ${b.y}`}
                          stroke={color}
                          strokeWidth={on ? 1.6 : 1.3}
                          fill="none"
                        />
                        <path d={`M${b.x - 6} ${b.y - 3.5} L${b.x - 0.5} ${b.y} L${b.x - 6} ${b.y + 3.5} Z`} fill={color} />
                      </g>
                    );
                  })}
                  {drag?.kind === "link" &&
                    (() => {
                      const a = outPoint(drag.from);
                      const dx = Math.max(20, Math.abs(drag.x - a.x) / 2);
                      return (
                        <path
                          d={`M${a.x} ${a.y} C${a.x + dx} ${a.y} ${drag.x - dx} ${drag.y} ${drag.x} ${drag.y}`}
                          stroke="var(--color-ink)"
                          strokeWidth="1.5"
                          strokeDasharray="4 3"
                          fill="none"
                        />
                      );
                    })()}
                </svg>

                {/* Cards */}
                {view.nodes.map((node) => {
                  const p = pos.get(node.id)!;
                  const m = memberOf(node);
                  const isSelected = node.id === selectedId;
                  const moving = drag?.kind === "move" && drag.id === node.id && drag.moved;
                  const linkOver = drag?.kind === "link" && drag.over === node.id && drag.from !== node.id;
                  return (
                    <div key={node.id}>
                      <div
                        data-node={node.id}
                        role="button"
                        tabIndex={0}
                        aria-pressed={isSelected}
                        aria-label={`${m.name}, step ${node.step + 1}`}
                        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setSelectedId(node.id)}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return;
                          e.currentTarget.setPointerCapture(e.pointerId);
                          const { x, y } = local(e.clientX, e.clientY);
                          setDrag({ kind: "move", id: node.id, x, y, sx: x, sy: y, offX: x - p.x, offY: y - p.y, moved: false });
                        }}
                        style={{ left: p.x, top: p.y, width: CARD_W, height: CARD_H }}
                        className={`absolute flex cursor-grab touch-none items-center gap-2 rounded-[10px] bg-surface p-2.5 ${
                          isSelected || linkOver
                            ? "border-[1.5px] border-ink"
                            : "border border-modal-line hover:border-shape-selected"
                        } ${moving ? "opacity-40" : ""}`}
                      >
                        <BotAvatar avatar={m.avatar} size={24} />
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <p className="truncate text-[12.5px] font-medium text-ink">{m.name}</p>
                          <p className="truncate text-[11.5px] text-hint">{node.task || "No task yet"}</p>
                        </div>
                      </div>
                      {node.runs > 1 && (
                        <div style={{ left: p.x + CARD_W - 40, top: p.y - 11 }} className="pointer-events-none absolute">
                          <RunsChip runs={node.runs} />
                        </div>
                      )}
                      {/* In port (left) and out port (right): drag from out to another card's in. */}
                      <span
                        style={{ left: p.x - 4, top: p.y + CARD_H / 2 - 4 }}
                        className="pointer-events-none absolute size-2 rounded-full border-[1.3px] border-hint bg-surface"
                      />
                      <span
                        role="button"
                        aria-label={`Make another card wait for ${m.name}`}
                        title="Drag to a card that should wait for this one"
                        onPointerDown={(e) => {
                          if (e.button !== 0) return;
                          e.stopPropagation();
                          e.currentTarget.setPointerCapture(e.pointerId);
                          const { x, y } = local(e.clientX, e.clientY);
                          setDrag({ kind: "link", from: node.id, x, y });
                        }}
                        style={{ left: p.x + CARD_W - 7, top: p.y + CARD_H / 2 - 7 }}
                        className="absolute flex size-3.5 cursor-crosshair touch-none items-center justify-center"
                      >
                        <span
                          className={`size-2 rounded-full border-[1.3px] bg-surface ${
                            isSelected || (drag?.kind === "link" && drag.from === node.id) ? "border-ink" : "border-hint"
                          }`}
                        />
                      </span>
                    </div>
                  );
                })}

                {/* What's being dragged */}
                {drag && drag.kind !== "link" && drag.moved && (
                  <div
                    style={{
                      left: drag.kind === "move" ? drag.x - drag.offX : drag.x - CARD_W / 2,
                      top: drag.kind === "move" ? drag.y - drag.offY : drag.y - CARD_H / 2,
                      width: CARD_W,
                      height: CARD_H,
                    }}
                    className="pointer-events-none absolute z-10 flex items-center gap-2 rounded-[10px] border-[1.5px] border-ink bg-surface p-2.5 shadow-[0_8px_24px_rgba(0,0,0,0.14)]"
                  >
                    {(() => {
                      const memberId =
                        drag.kind === "move" ? view.nodes.find((n) => n.id === drag.id)?.memberId : drag.memberId;
                      const m = members.find((x) => x.id === memberId);
                      return m ? (
                        <>
                          <BotAvatar avatar={m.avatar} size={24} />
                          <p className="truncate text-[12.5px] font-medium text-ink">{m.name}</p>
                        </>
                      ) : null;
                    })()}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Drag in: the team's members */}
          <div className="absolute bottom-3 left-4 flex max-w-[calc(100%-180px)] items-center gap-2 overflow-x-auto rounded-[10px] border border-modal-line bg-surface px-2.5 py-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.08)]">
            <span className="shrink-0 text-[12px] font-medium text-subtle">Drag in</span>
            {members.map((m) => (
              <span
                key={m.id}
                role="button"
                tabIndex={0}
                title={`${m.name} · drag into a step, or click to add a step`}
                aria-label={`Add ${m.name}`}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  const node = newFlowNode(m.id, steps.length);
                  update((nodes) => [...nodes, node]);
                  setSelectedId(node.id);
                }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const { x, y } = local(e.clientX, e.clientY);
                  setDrag({ kind: "new", memberId: m.id, x, y, sx: x, sy: y, moved: false });
                }}
                className="flex shrink-0 cursor-grab touch-none rounded-full hover:opacity-80"
              >
                <BotAvatar avatar={m.avatar} size={22} />
              </span>
            ))}
            <span className="shrink-0 text-[11.5px] text-hint">a member can be used twice</span>
          </div>

          {/* Zoom */}
          <div className="absolute right-3 bottom-3 flex items-center gap-3 rounded-[8px] border border-modal-line bg-surface px-2.5 py-[5px]">
            <button type="button" aria-label="Zoom out" disabled={zoom <= ZOOMS[0]} onClick={() => zoomBy(-1)} className="text-[13px] font-medium text-subtle disabled:opacity-35">
              −
            </button>
            <button type="button" title="Reset zoom" onClick={() => setZoom(1)} className="w-9 text-center text-[12px] font-medium text-ink">
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              aria-label="Zoom in"
              disabled={zoom >= ZOOMS[ZOOMS.length - 1]}
              onClick={() => zoomBy(1)}
              className="text-[13px] font-medium text-subtle disabled:opacity-35"
            >
              +
            </button>
          </div>
        </div>

        <div className="flex items-start gap-2.5 rounded-[10px] bg-sidebar px-3 py-2.5">
          <p className="shrink-0 text-[12px] font-semibold text-subtle">Run order</p>
          <p className="selectable min-w-0 flex-1 text-[12px] leading-[145%] text-subtle">
            {describeRunOrder(view, members, leadName)}
          </p>
        </div>
      </div>

      <aside className="flex w-[320px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-divider bg-surface p-[18px]">
        {selected ? (
          <Inspector
            key={selected.id}
            node={selected}
            nodes={view.nodes}
            members={members}
            leadName={leadName}
            onPatch={(p) => patch(selected.id, p)}
            onToggleWait={(id) => toggleWait(selected, id)}
            onRemove={() => {
              remove(selected.id);
              setSelectedId(undefined);
            }}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
            <p className="text-[13.5px] font-medium text-ink">Nothing selected</p>
            <p className="text-[12.5px] leading-[18px] text-hint">
              Click a card to set its task, what it waits for, how often it runs and what happens if it fails.
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 self-stretch">
      <p className="text-[12.5px] font-medium text-subtle">{title}</p>
      {children}
      {hint && <p className="text-[11.5px] leading-[140%] text-hint">{hint}</p>}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-0.5 self-stretch rounded-[9px] bg-bubble p-[3px]">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={`flex-1 rounded-[7px] p-1.5 text-[12.5px] ${
              on ? "bg-surface font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,0.1)]" : "text-subtle hover:text-ink"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** The canvas's settings panel for the picked card. */
function Inspector({
  node,
  nodes,
  members,
  leadName,
  onPatch,
  onToggleWait,
  onRemove,
}: {
  node: FlowNode;
  nodes: FlowNode[];
  members: FlowMember[];
  leadName: string;
  onPatch: (p: Partial<FlowNode>) => void;
  onToggleWait: (id: string) => void;
  onRemove: () => void;
}) {
  const memberOf = (n: FlowNode) => members.find((m) => m.id === n.memberId)!;
  const m = memberOf(node);
  const waits = waitsFor(nodes, node);
  // Nearest step first, as in the mock.
  const earlier = nodes.filter((n) => n.step < node.step).sort((a, b) => b.step - a.step);
  return (
    <>
      <div className="flex items-center gap-2.5 self-stretch">
        <BotAvatar avatar={m.avatar} size={30} />
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <p className="truncate text-[14px] font-semibold text-ink">{m.name}</p>
          <p className="text-[12px] text-hint">Step {node.step + 1}</p>
        </div>
      </div>

      <Section title="Its task in this flow" hint={`${leadName} adds the details from each request.`}>
        <textarea
          rows={3}
          value={node.task}
          onChange={(e) => onPatch({ task: e.target.value })}
          placeholder="What should it do?"
          className="selectable w-full resize-none rounded-[10px] border border-composer-line bg-surface px-3 py-[9px] text-[13px] leading-[145%] text-ink focus:border-ink"
        />
      </Section>

      <Section
        title="Waits for"
        hint={
          earlier.length === 0
            ? `Starts first, as soon as ${leadName} has planned.`
            : `Starts when ${whenDone(waits.map((w) => memberOf(w).name))}.`
        }
      >
        {earlier.map((e) => {
          const on = waits.some((w) => w.id === e.id);
          const locked = on && waits.length === 1;
          const em = memberOf(e);
          return (
            <button
              key={e.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              disabled={locked}
              title={locked ? "It has to wait for at least one" : undefined}
              onClick={() => onToggleWait(e.id)}
              className="flex items-center gap-2.5 self-stretch rounded-[9px] border border-modal-line bg-surface px-2.5 py-2 text-left enabled:hover:bg-row-hover"
            >
              <CheckBox checked={on} />
              <BotAvatar avatar={em.avatar} size={20} />
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{em.name}</span>
              <span className="shrink-0 text-[12px] text-hint">Step {e.step + 1}</span>
            </button>
          );
        })}
      </Section>

      <Section
        title="Runs"
        hint={`Default is 1. Each run gets its last result plus ${leadName}'s notes, so it can improve it.`}
      >
        <div className="flex items-center gap-2">
          <Stepper value={node.runs} label="runs" onChange={(runs) => onPatch({ runs })} />
          <span className="text-[13px] text-ink">{node.runs === 1 ? "time" : "times"}</span>
        </div>
      </Section>
      {node.runs > 1 && (
        <div className="-my-2 self-stretch">
          <Switch checked={node.stopEarly} onChange={(stopEarly) => onPatch({ stopEarly })}>
            <span className="text-[13px] text-ink">Stop early when {leadName} is happy</span>
          </Switch>
        </div>
      )}

      <Section title="Gets">
        <Segmented<FlowInput>
          label="Gets"
          value={node.gets}
          onChange={(gets) => onPatch({ gets })}
          options={[
            { value: "results", label: "Results it waits for" },
            { value: "everything", label: "Everything so far" },
          ]}
        />
      </Section>

      <Section title="If it fails">
        <Segmented<OnFail>
          label="If it fails"
          value={node.onFail}
          onChange={(onFail) => onPatch({ onFail })}
          options={[
            { value: "stop", label: "Stop flow" },
            { value: "skip", label: "Skip it" },
            { value: "ask", label: "Ask me" },
          ]}
        />
      </Section>

      <button type="button" onClick={onRemove} className="self-start text-[13px] font-medium text-danger hover:underline">
        Remove from flow
      </button>
    </>
  );
}
