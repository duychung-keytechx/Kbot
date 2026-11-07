// The orchestrator's Plan card in a team chat (design/Kbot_agentteam_05 and _12).

import { useEffect, useState } from "react";
import { backend, errorText } from "../../lib/api";
import type { Bot, PlanCard as Plan, PlanEdit, PlanTask, Team } from "../../lib/types";
import { BotAvatar } from "../avatars/BotAvatar";
import { CloseIcon } from "../Icons";
import { cancelButton, field, okButton, Pill, smallButton, StatusLabel } from "./parts";

export function PlanCard({
  team,
  plan,
  bots,
  latest,
  onOpen,
  onViewFlow,
}: {
  team: Team;
  plan: Plan;
  bots: Bot[];
  /** Only the newest card of a live run can be paused or edited. */
  latest: boolean;
  onOpen: (memberId: string) => void;
  onViewFlow: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();
  const live = latest && (plan.state === "running" || plan.state === "paused") && !!team.activity;
  const done = plan.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
  const flow = plan.mode === "flow";
  const steps = flow ? stepsOf(plan.tasks) : [];
  const avatar = (task: PlanTask) => bots.find((b) => b.id === task.memberId)?.avatar;
  const run = (call: Promise<unknown>) => {
    setError(undefined);
    call.catch((e) => setError(errorText(e)));
  };

  // "Step 2 of 3": the first step with unfinished work.
  const current = steps.findIndex((s) => s.some((t) => !finished(t)));
  const badge =
    plan.state === "paused" ? (
      <Pill>Paused</Pill>
    ) : plan.state === "stopped" ? (
      <span className="text-[12px] text-hint">Stopped</span>
    ) : plan.state === "done" ? (
      <StatusLabel status="done" />
    ) : flow ? (
      <Pill>
        Step {current < 0 ? steps.length : current + 1} of {steps.length}
      </Pill>
    ) : (
      <Pill>
        {done} of {plan.tasks.length} done
      </Pill>
    );

  const row = (task: PlanTask, index: number) => (
    <TaskRow
      key={task.id}
      task={task}
      index={index}
      tasks={plan.tasks}
      avatar={avatar(task)}
      flow={flow}
      live={live}
      onOpen={() => onOpen(task.memberId)}
      onAction={(action) => run(backend.answerTeamTask(team.id, task.id, action))}
    />
  );

  return (
    <div className="flex w-[560px] max-w-full flex-col gap-2 rounded-2xl bg-bubble p-3">
      <div className="flex items-center gap-2 px-0.5 pt-0.5 pb-1">
        <p className="text-[14px] font-semibold text-ink">{flow ? `${team.name} flow` : "Plan"}</p>
        {flow && <span className="rounded-[6px] bg-surface px-1.5 py-px text-[11.5px] text-subtle">Custom</span>}
        <div className="flex-1" />
        {badge}
      </div>
      {flow
        ? steps.map((tasks, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 px-1 pt-1">
                <span
                  className={`flex size-[18px] items-center justify-center rounded-full text-[11px] font-semibold ${
                    i === current ? "bg-ink-strong text-ink-inverse" : "border border-button-line bg-surface text-subtle"
                  }`}
                >
                  {i + 1}
                </span>
                <p className="text-[12.5px] font-medium text-subtle">{i === 0 ? "Starts first" : "Then"}</p>
              </div>
              {tasks.map((t) => row(t, plan.tasks.indexOf(t)))}
            </div>
          ))
        : plan.tasks.map(row)}
      {error && <p className="px-1 text-[12.5px] text-danger">{error}</p>}
      {live && (
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={() => run(backend.pauseTeam(team.id, plan.state !== "paused"))}
            className={smallButton}
          >
            {plan.state === "paused" ? "Resume team" : "Pause team"}
          </button>
          {flow ? (
            <button type="button" onClick={onViewFlow} className={smallButton}>
              View flow
            </button>
          ) : (
            <button
              type="button"
              disabled={!plan.tasks.some((t) => t.status === "waiting")}
              onClick={() => setEditing(true)}
              className={smallButton}
            >
              Edit plan
            </button>
          )}
        </div>
      )}
      {editing && (
        <EditPlanDialog team={team} tasks={plan.tasks} bots={bots} onClose={() => setEditing(false)} />
      )}
    </div>
  );
}

const finished = (t: PlanTask) => t.status === "done" || t.status === "skipped" || t.status === "failed";

/** Flow tasks grouped by step. */
function stepsOf(tasks: PlanTask[]): PlanTask[][] {
  const steps = [...new Set(tasks.map((t) => t.step ?? 0))].sort((a, b) => a - b);
  return steps.map((s) => tasks.filter((t) => (t.step ?? 0) === s));
}

function TaskRow({
  task,
  index,
  tasks,
  avatar,
  flow,
  live,
  onOpen,
  onAction,
}: {
  task: PlanTask;
  index: number;
  tasks: PlanTask[];
  avatar: Bot["avatar"] | undefined;
  flow: boolean;
  live: boolean;
  onOpen: () => void;
  onAction: (action: "retry" | "skip" | "stop") => void;
}) {
  const started = task.status !== "waiting";
  const detail = task.detail || (task.status === "waiting" && !flow ? waitingText(task, tasks) : "");
  const runs = task.runs > 1 && (task.status === "working" || task.status === "review") ? `Run ${task.run} of ${task.runs}` : "";
  return (
    <div className="flex flex-col gap-2 rounded-[10px] bg-surface px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        {avatar ? <BotAvatar avatar={avatar} size={26} /> : <span className="size-[26px] shrink-0 rounded-full bg-bubble" />}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="truncate text-[13.5px] font-medium text-ink" title={task.brief}>
            {flow ? task.memberName : task.title || `Task ${index + 1}`}
            {task.runs > 1 && <span className="ml-1.5 text-[12px] font-normal text-hint">{task.runs}×</span>}
          </p>
          <p className="truncate text-[12px] text-hint">
            {flow ? (
              [runs, detail || task.title].filter(Boolean).join(" · ")
            ) : (
              <>
                {task.memberName}
                {(runs || detail) && ` · ${[runs, detail].filter(Boolean).join(" · ")}`}
              </>
            )}
          </p>
        </div>
        <StatusLabel status={task.status} />
        {started && (
          <button
            type="button"
            onClick={onOpen}
            title={`Open ${task.memberName}'s chat`}
            className="flex shrink-0 items-center gap-1 rounded-xl bg-bubble py-1 pr-2 pl-2.5 text-[12px] font-medium text-ink hover:bg-row-active"
          >
            Open ›
          </button>
        )}
      </div>
      {live && (task.status === "blocked" || task.status === "failed") && (
        <div className="flex gap-2 pl-[36px]">
          <button type="button" onClick={() => onAction("retry")} className={smallButton}>
            Retry
          </button>
          <button type="button" onClick={() => onAction("skip")} className={smallButton}>
            Skip
          </button>
          <button type="button" onClick={() => onAction("stop")} className={`${smallButton} text-danger`}>
            Stop team
          </button>
        </div>
      )}
    </div>
  );
}

/** "Starts after task 2", when the backend left the detail empty. */
function waitingText(task: PlanTask, tasks: PlanTask[]) {
  const nums = task.after.map((id) => tasks.findIndex((t) => t.id === id) + 1).filter((n) => n > 0);
  if (nums.length === 0) return "";
  return `Starts after task${nums.length > 1 ? "s" : ""} ${nums.join(" and ")}`;
}

/** "Edit plan": change, reassign or drop tasks that haven't started. */
function EditPlanDialog({ team, tasks, bots, onClose }: { team: Team; tasks: PlanTask[]; bots: Bot[]; onClose: () => void }) {
  const open = tasks.filter((t) => t.status === "waiting");
  const [drafts, setDrafts] = useState<PlanEdit[]>(() =>
    open.map((t) => ({ taskId: t.id, title: t.title, brief: t.brief, memberId: t.memberId, remove: false })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const members = team.members.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => !!b);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (i: number, patch: Partial<PlanEdit>) => setDrafts((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const changed = drafts.filter((d, i) => {
        const t = open[i];
        return d.remove || d.title !== t.title || d.brief !== t.brief || d.memberId !== t.memberId;
      });
      if (changed.length > 0) await backend.editTeamPlan(team.id, changed);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-6" onMouseDown={onClose}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label="Edit plan"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="flex max-h-full w-[560px] max-w-full flex-col overflow-hidden rounded-2xl border border-modal-line bg-surface shadow-[0_20px_50px_rgba(0,0,0,0.2),0_2px_6px_rgba(0,0,0,0.06)]"
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-divider pr-4 pl-5">
          <p className="text-[15px] font-semibold text-ink">Edit plan</p>
          <button type="button" aria-label="Close" onClick={onClose} className="flex size-7 items-center justify-center rounded-lg hover:bg-bubble">
            <CloseIcon />
          </button>
        </div>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 py-5">
          <p className="text-[13px] text-hint">Tasks that haven't started yet. Running and finished tasks stay as they are.</p>
          {drafts.map((d, i) => (
            <div key={d.taskId} className={`flex flex-col gap-2 rounded-xl border border-modal-line p-3 ${d.remove ? "opacity-50" : ""}`}>
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-hint">Task {tasks.indexOf(open[i]) + 1}</span>
                <div className="flex-1" />
                <select
                  value={d.memberId}
                  disabled={d.remove}
                  onChange={(e) => set(i, { memberId: e.target.value })}
                  aria-label="Member"
                  className="rounded-lg border border-composer-line bg-surface px-2 py-1 text-[13px] text-ink"
                >
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => set(i, { remove: !d.remove })} className={smallButton}>
                  {d.remove ? "Keep" : "Remove"}
                </button>
              </div>
              <input
                value={d.title}
                disabled={d.remove}
                aria-label="Title"
                onChange={(e) => set(i, { title: e.target.value })}
                className={`${field} h-9 py-1.5`}
              />
              <textarea
                rows={3}
                value={d.brief}
                disabled={d.remove}
                aria-label="Brief"
                onChange={(e) => set(i, { brief: e.target.value })}
                className={`${field} resize-none leading-[20px]`}
              />
            </div>
          ))}
          {drafts.length === 0 && <p className="text-[13px] text-subtle">Every task has started.</p>}
          {error && <p className="text-[12.5px] text-danger">{error}</p>}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2.5 border-t border-divider px-4 pt-3.5 pb-4">
          <button type="button" onClick={onClose} className={cancelButton}>
            Cancel
          </button>
          <button type="submit" disabled={busy || drafts.length === 0} className={okButton}>
            Save plan
          </button>
        </div>
      </form>
    </div>
  );
}
