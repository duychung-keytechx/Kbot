// "New team" (design/Kbot_agentteam_02_team.html, 03_orchestrator, 04_members,
// 09_orchestrator_custom_flow and 10_flow_steps_list): Team, Orchestrator,
// Members, and a Flow step when the run mode is Custom flow.

import { Fragment, type ReactNode, useState } from "react";
import { backend, errorText } from "../../lib/api";
import {
  type Bot,
  EMPTY_FLOW,
  type Flow,
  MAX_NAME,
  MAX_TEAM_NAME,
  type NewMember,
  newFlowNode,
  TAG_COLORS,
  type Team,
  type TeamMode,
} from "../../lib/types";
import { BotAvatar } from "../avatars/BotAvatar";
import { CloseIcon, SmallTrashIcon, TinyPlusIcon } from "../Icons";
import { FlowStepsList, type FlowMember } from "./FlowEditor";
import { cancelButton, field, imageAvatar, LeadAvatar, okButton, smallButton, TeamAvatar } from "./parts";
import { AddBotsPicker, FlowCanvasModal, NewMemberDialog, pruneFlow, randomImage, useEscape } from "./teamDialogs";

type Step = "team" | "lead" | "members" | "flow";
const STEP_LABEL: Record<Step, string> = { team: "Team", lead: "Orchestrator", members: "Members", flow: "Flow" };

/** "Sales Team" → "Sales Lead"; "Research" → "Research Lead". */
export const defaultLeadName = (team: string) => {
  const name = team.trim() || "Team";
  return /\bteam\b/i.test(name) ? name.replace(/\bteam\b/i, "Lead") : `${name} Lead`;
};

export const defaultInstructions = (team: string, purpose: string) =>
  [
    `You lead the ${team.trim() || "team"}.`,
    purpose.trim(),
    "Split each request into tasks, give each task to the best member, run independent tasks at the same time, check every result, and reply with one short summary.",
  ]
    .filter(Boolean)
    .join(" ");

/** A wizard member and the bot it comes from, if any. */
type Draft = NewMember & { bot?: Bot };

const draftOf = (bot: Bot): Draft => ({
  key: bot.id,
  botId: bot.id,
  name: bot.name,
  image: null,
  role: bot.teamRole || bot.config.description,
  bot,
});

export function NewTeamWizard({
  bots,
  teams,
  startWith,
  onClose,
  onCreated,
}: {
  bots: Bot[];
  teams: Team[];
  /** "New team with this bot…": the bot starts out as a member. */
  startWith?: string;
  onClose: () => void;
  onCreated: (team: Team) => void;
}) {
  const [step, setStep] = useState<Step>("team");
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [color, setColor] = useState<string>(TAG_COLORS[7]);
  const [leadName, setLeadName] = useState<string>();
  const [instructions, setInstructions] = useState<string>();
  const [leadImage] = useState(randomImage);
  const [mode, setMode] = useState<TeamMode>("auto");
  const [members, setMembers] = useState<Draft[]>(() => {
    const bot = bots.find((b) => b.id === startWith);
    return bot ? [draftOf(bot)] : [];
  });
  const [flow, setFlow] = useState<Flow>(EMPTY_FLOW);
  const [creatingMember, setCreatingMember] = useState(false);
  const [picking, setPicking] = useState(false);
  const [canvas, setCanvas] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEscape(() => !creatingMember && !canvas && !picking && onClose());

  // Until edited, the orchestrator's name and instructions follow the team's.
  const lead = leadName ?? defaultLeadName(name);
  const brief = instructions ?? defaultInstructions(name, purpose);
  const steps: Step[] = mode === "flow" ? ["team", "lead", "members", "flow"] : ["team", "lead", "members"];
  const index = steps.indexOf(step);
  const last = index === steps.length - 1;
  const flowMembers: FlowMember[] = members.map((m) => ({
    id: m.key,
    name: m.name,
    avatar: m.bot?.avatar ?? imageAvatar(m.image ?? leadImage),
  }));

  const canNext = step === "team" ? name.trim().length > 0 : step === "lead" ? lead.trim().length > 0 : true;

  const next = () => {
    if (!canNext) return;
    if (last) return void create();
    const to = steps[index + 1];
    // Start the flow with every member in step 1, running together.
    if (to === "flow" && flow.nodes.length === 0 && members.length > 0)
      setFlow({ ...flow, nodes: members.map((m) => newFlowNode(m.key, 0)) });
    setStep(to);
  };

  const removeMember = (key: string) => {
    const rest = members.filter((m) => m.key !== key);
    setMembers(rest);
    setFlow((f) => pruneFlow(f, rest.map((m) => m.key)));
  };

  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const team = await backend.createTeam({
        name: name.trim(),
        purpose: purpose.trim(),
        color,
        leadName: lead.trim(),
        leadImage,
        instructions: brief.trim(),
        mode,
        members: members.map(({ key, botId, name, image, role }) => ({ key, botId, name, image, role: role.trim() })),
        flow: mode === "flow" ? pruneFlow(flow, members.map((m) => m.key)) : EMPTY_FLOW,
      });
      onCreated(team);
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
        aria-label="Create team"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          next();
        }}
        className={`flex max-h-full flex-col overflow-hidden rounded-2xl border border-modal-line bg-surface shadow-[0_20px_50px_rgba(0,0,0,0.2),0_2px_6px_rgba(0,0,0,0.06)] ${
          step === "flow" ? "w-[600px]" : "w-[560px]"
        }`}
      >
        <div className="flex shrink-0 flex-col gap-3.5 border-b border-divider px-5 pt-4 pb-3.5">
          <div className="flex items-center justify-between">
            <p className="text-[15px] font-semibold text-ink">Create team</p>
            <button type="button" aria-label="Close" onClick={onClose} className="-mr-1 flex size-7 items-center justify-center rounded-lg hover:bg-bubble">
              <CloseIcon />
            </button>
          </div>
          <Stepper steps={steps} index={index} />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-6 py-5">
          {step === "team" && (
            <>
              <div className="flex justify-center pb-1">
                <TeamAvatar color={color} size={84} />
              </div>
              <Labeled label="Team name" htmlFor="team-name">
                <input
                  id="team-name"
                  autoFocus
                  value={name}
                  maxLength={MAX_TEAM_NAME}
                  spellCheck={false}
                  placeholder="e.g. Sales Team"
                  onChange={(e) => setName(e.target.value)}
                  className={`${field} h-10`}
                />
              </Labeled>
              <Labeled label="What does this team do?" htmlFor="team-purpose" hint="The orchestrator reads this to plan work and split it across members.">
                <textarea
                  id="team-purpose"
                  rows={3}
                  value={purpose}
                  placeholder="e.g. Run outbound sales: find leads that went quiet, research the accounts, and draft follow-ups in my voice."
                  onChange={(e) => setPurpose(e.target.value)}
                  className={`${field} resize-none leading-[20px]`}
                />
              </Labeled>
              <Labeled label="Color">
                <ColorPicker value={color} onChange={setColor} />
              </Labeled>
            </>
          )}

          {step === "lead" && (
            <>
              <p className="text-[13px] leading-[19px] text-hint">
                The orchestrator is who you talk to. It breaks your request into tasks, hands them to members, checks the results and replies with
                one answer.
              </p>
              <div className="flex items-end gap-4">
                <div className="flex flex-col gap-1.5">
                  <p className="text-[13px] text-subtle">Avatar</p>
                  <div className="flex size-10 items-center justify-center rounded-[10px] bg-sidebar">
                    <LeadAvatar color={color} size={28} />
                  </div>
                </div>
                <div className="flex-1">
                  <Labeled label="Orchestrator name" htmlFor="lead-name">
                    <input
                      id="lead-name"
                      autoFocus
                      value={lead}
                      maxLength={MAX_NAME}
                      spellCheck={false}
                      onChange={(e) => setLeadName(e.target.value)}
                      className={`${field} h-10`}
                    />
                  </Labeled>
                </div>
              </div>
              <Labeled label="Instructions" htmlFor="lead-instructions" hint="Prefilled from the team's purpose. Members' own instructions still apply.">
                <textarea
                  id="lead-instructions"
                  rows={4}
                  value={brief}
                  onChange={(e) => setInstructions(e.target.value)}
                  className={`${field} resize-none leading-[20px]`}
                />
              </Labeled>
              <ModePicker leadName={lead || "The orchestrator"} mode={mode} onChange={setMode} />
            </>
          )}

          {step === "members" && (
            <>
              <div className="flex flex-col gap-1">
                <p className="text-[14px] font-semibold text-ink">
                  Members <span className="font-normal text-hint">{members.length}</span>
                </p>
                <p className="text-[13px] text-hint">{lead} can hand tasks to these agents. A bot can be in one team at a time.</p>
              </div>
              <div className="flex flex-col divide-y divide-divider rounded-xl border border-modal-line">
                <div className="flex items-center gap-3 px-3.5 py-2.5">
                  <LeadAvatar color={color} size={28} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <p className="truncate text-[14px] font-medium text-ink">{lead}</p>
                    <p className="text-[12.5px] text-hint">Plans and delegates · talks to you</p>
                  </div>
                  <Chip>Orchestrator</Chip>
                </div>
                {members.map((m) => (
                  <MemberDraftRow
                    key={m.key}
                    member={m}
                    teams={teams}
                    avatar={flowMembers.find((f) => f.id === m.key)!.avatar}
                    onRole={(role) => setMembers((ms) => ms.map((x) => (x.key === m.key ? { ...x, role } : x)))}
                    onRemove={() => removeMember(m.key)}
                  />
                ))}
              </div>
              <div className="relative flex gap-2">
                <button type="button" onClick={() => setCreatingMember(true)} className={smallButton}>
                  <TinyPlusIcon /> Create new agent
                </button>
                <button type="button" onClick={() => setPicking((p) => !p)} className={smallButton}>
                  <TinyPlusIcon /> Add existing bot
                </button>
                {picking && (
                  <AddBotsPicker
                    bots={bots}
                    teams={teams}
                    exclude={members.flatMap((m) => (m.botId ? [m.botId] : []))}
                    onAdd={(added) => setMembers((ms) => [...ms, ...added.map(draftOf)])}
                    onClose={() => setPicking(false)}
                  />
                )}
              </div>
            </>
          )}

          {step === "flow" && (
            <>
              <div className="flex items-start justify-between gap-3">
                <p className="text-[13px] leading-[19px] text-hint">
                  Set who starts first, who runs together and who waits for whom. {lead} still writes each member's brief, but follows your
                  order.
                </p>
                <button type="button" disabled={members.length === 0} onClick={() => setCanvas(true)} className={`${smallButton} shrink-0`}>
                  Open in editor
                </button>
              </div>
              {members.length === 0 ? (
                <p className="rounded-xl bg-sidebar px-4 py-6 text-center text-[13px] text-hint">
                  Add members first. You can also set the flow later in Team settings.
                </p>
              ) : (
                <FlowStepsList flow={flow} members={flowMembers} leadName={lead} leadColor={color} onChange={setFlow} />
              )}
            </>
          )}

          {error && <p className="text-[12.5px] text-danger">{error}</p>}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2.5 border-t border-divider pt-3.5 pr-4 pb-4 pl-6">
          <p className="text-[12px] text-hint">
            Step {index + 1} of {steps.length}
            {step === "members" && " · You can add more later"}
          </p>
          <div className="flex items-center gap-2">
            {index === 0 ? (
              <button type="button" onClick={onClose} className={cancelButton}>
                Cancel
              </button>
            ) : (
              <button type="button" onClick={() => setStep(steps[index - 1])} className={cancelButton}>
                Back
              </button>
            )}
            <button type="submit" disabled={!canNext || busy} className={okButton}>
              {last ? "Create team" : "Next"}
            </button>
          </div>
        </div>
      </form>

      {creatingMember && (
        <NewMemberDialog
          teamName={name.trim() || "the team"}
          leadName={lead}
          onAdd={async (memberName, image, role) =>
            setMembers((ms) => [...ms, { key: crypto.randomUUID(), botId: null, name: memberName, image, role }])
          }
          onClose={() => setCreatingMember(false)}
        />
      )}
      {canvas && (
        <FlowCanvasModal
          title={`${name.trim() || "Team"} flow`}
          flow={flow}
          members={flowMembers}
          leadName={lead}
          leadColor={color}
          onChange={setFlow}
          onClose={() => setCanvas(false)}
        />
      )}
    </div>
  );
}

function Stepper({ steps, index }: { steps: Step[]; index: number }) {
  return (
    <ol className="flex items-center gap-2">
      {steps.map((s, i) => (
        <Fragment key={s}>
          {i > 0 && <span className="h-px w-6 bg-divider" />}
          <li className={`flex items-center gap-1.5 text-[13px] ${i === index ? "font-medium text-ink" : "text-hint"}`}>
            <span
              className={`flex size-5 items-center justify-center rounded-full text-[11px] font-semibold ${
                i < index ? "bg-done text-white" : i === index ? "bg-ink-strong text-ink-inverse" : "bg-bubble text-hint"
              }`}
            >
              {i < index ? "✓" : i + 1}
            </span>
            {STEP_LABEL[s]}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

export function Labeled({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] text-subtle">
        {label}
      </label>
      {children}
      {hint && <p className="text-[12px] leading-[17px] text-hint">{hint}</p>}
    </div>
  );
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-2">
      {TAG_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={c.toLowerCase() === value.toLowerCase()}
          aria-label={c}
          onClick={() => onChange(c)}
          className={`size-7 rounded-full ${
            c.toLowerCase() === value.toLowerCase() ? "shadow-[0_0_0_2px_var(--color-surface),0_0_0_3.5px_var(--color-ink)]" : ""
          }`}
          style={{ background: c }}
        />
      ))}
    </div>
  );
}

/** "How should {lead} run the tasks?" */
export function ModePicker({
  leadName,
  mode,
  onChange,
  inSettings,
}: {
  leadName: string;
  mode: TeamMode;
  onChange: (mode: TeamMode) => void;
  /** In Team settings the flow has its own tab rather than a wizard step. */
  inSettings?: boolean;
}) {
  const options: { value: TeamMode; title: string; text: string }[] = [
    {
      value: "auto",
      title: "Let it decide",
      text: `${leadName} plans each request and picks the order: one after another, or several at once.`,
    },
    {
      value: "flow",
      title: "Custom flow",
      text: `You set who starts first, who runs together and who waits for whom. Adds a Flow ${inSettings ? "tab" : "step"}.`,
    },
  ];
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px] text-subtle">How should {leadName} run the tasks?</p>
      <div role="radiogroup" className="grid grid-cols-2 gap-2.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={mode === o.value}
            onClick={() => onChange(o.value)}
            className={`flex flex-col gap-1 rounded-xl border px-3.5 py-3 text-left ${
              mode === o.value ? "border-ink shadow-[0_0_0_0.5px_var(--color-ink)]" : "border-modal-line hover:bg-row-hover"
            }`}
          >
            <span className="flex items-center gap-2 text-[14px] font-medium text-ink">
              <span
                className={`size-3.5 rounded-full border ${mode === o.value ? "border-[4px] border-ink" : "border-button-line"}`}
              />
              {o.title}
            </span>
            <span className="text-[12.5px] leading-[17px] text-hint">{o.text}</span>
          </button>
        ))}
      </div>
      <p className="text-[12px] leading-[17px] text-hint">
        {mode === "auto"
          ? `Steer it in the instructions above, e.g. "always research the account before drafting". Tasks that don't need each other's results run at the same time.`
          : `${inSettings ? "Lay out the flow in the Flow tab." : "Next you'll lay out the flow."} ${leadName} still writes each member's brief, but follows your order.`}
      </p>
    </div>
  );
}

export function Chip({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "new" | "move" }) {
  const cls =
    tone === "new"
      ? "bg-[color-mix(in_srgb,var(--color-done)_14%,transparent)] text-done"
      : tone === "move"
        ? "bg-brief-bg text-brief-ink"
        : "bg-bubble text-subtle";
  return <span className={`shrink-0 rounded-[10px] px-2 py-[2px] text-[11.5px] font-medium ${cls}`}>{children}</span>;
}

function MemberDraftRow({
  member,
  teams,
  avatar,
  onRole,
  onRemove,
}: {
  member: Draft;
  teams: Team[];
  avatar: FlowMember["avatar"];
  onRole: (role: string) => void;
  onRemove: () => void;
}) {
  const from = member.bot?.teamId ? teams.find((t) => t.id === member.bot?.teamId) : undefined;
  return (
    <div className="group flex items-center gap-3 px-3.5 py-2.5">
      <BotAvatar avatar={avatar} size={28} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <p className="truncate text-[14px] font-medium text-ink">{member.name}</p>
          {!member.botId ? (
            <Chip tone="new">New</Chip>
          ) : from ? (
            <Chip tone="move">In {from.name} · move it here</Chip>
          ) : (
            <Chip>Moved from your bots</Chip>
          )}
        </div>
        <input
          value={member.role}
          placeholder="What does it do in the team?"
          aria-label={`${member.name}'s role`}
          onChange={(e) => onRole(e.target.value)}
          className="w-full rounded-md bg-transparent px-1 py-0.5 -ml-1 text-[12.5px] text-hint outline-none hover:bg-row-hover focus:bg-sidebar focus:text-ink"
        />
      </div>
      <button
        type="button"
        aria-label={`Remove ${member.name}`}
        onClick={onRemove}
        className="flex size-7 shrink-0 items-center justify-center rounded-lg opacity-0 group-hover:opacity-100 hover:bg-bubble focus:opacity-100"
      >
        <SmallTrashIcon />
      </button>
    </div>
  );
}
