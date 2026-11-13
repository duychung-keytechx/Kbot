// "Team settings" (design/Kbot_agentteam_06_team_settings.html), laid out like
// Edit bot: Team Info, Orchestrator, Members, Flow and Tags. Team Info,
// Orchestrator and Flow save when the dialog closes; Members and Tags act
// right away.

import { type ReactNode, useEffect, useRef, useState } from "react";
import { backend, errorText } from "../../lib/api";
import { type Bot, type Flow, MAX_NAME, MAX_TEAM_NAME, newFlowNode, type Team, type TeamInfo, type TeamMode } from "../../lib/types";
import { DeleteBotDialog } from "../ConfirmDialog";
import { Body, EditBotDialog, Field, Footer, NavItem, TagsTab } from "../EditBotDialog";
import { InfoIcon, TagIcon, TinyPlusIcon } from "../Icons";
import { DisbandDialog } from "../Sidebar";
import { FlowStepsList, type FlowMember } from "./FlowEditor";
import { Chip, ColorPicker, ModePicker } from "./NewTeamWizard";
import { field, LeadAvatar, MemberAvatar, okButton, smallButton, TeamAvatar } from "./parts";
import { AddBotsPicker, FlowCanvasModal, NewMemberDialog, pruneFlow } from "./teamDialogs";

export type TeamSettingsTab = "info" | "lead" | "members" | "flow" | "tags";

const infoOf = ({ name, purpose, color, mode, flow }: Team): TeamInfo => ({ name, purpose, color, mode, flow });

export function TeamSettingsDialog({
  team,
  bots,
  teams,
  initialTab,
  onOpenChat,
  onClose,
}: {
  team: Team;
  bots: Bot[];
  teams: Team[];
  initialTab?: TeamSettingsTab;
  onOpenChat: (botId: string) => void;
  onClose: () => void;
}) {
  const lead = bots.find((b) => b.id === team.leadId);
  const members = team.members.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => !!b);
  const [tab, setTab] = useState<TeamSettingsTab>(initialTab ?? "info");
  const [info, setInfo] = useState<TeamInfo>(() => infoOf(team));
  const [leadName, setLeadName] = useState(lead?.name ?? "");
  const [instructions, setInstructions] = useState(lead?.config.instructions ?? "");
  // "Make orchestrator" swaps the lead: start its fields over from the new one.
  const leadId = lead?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the lead changes
  useEffect(() => {
    setLeadName(lead?.name ?? "");
    setInstructions(lead?.config.instructions ?? "");
  }, [leadId]);
  // A dialog on top of this one takes Escape.
  const [overlay, setOverlay] = useState<ReactNode>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const memberIds = team.members;
  const savedInfo = infoOf(team);
  const finalInfo: TeamInfo = { ...info, name: info.name.trim(), purpose: info.purpose.trim(), flow: pruneFlow(info.flow, memberIds) };
  const infoChanged = JSON.stringify(finalInfo) !== JSON.stringify({ ...savedInfo, flow: pruneFlow(savedInfo.flow, memberIds) });
  const renamed = !!lead && leadName.trim() !== lead.name;
  const rebriefed = !!lead && instructions !== lead.config.instructions;
  const dirty = infoChanged || renamed || rebriefed;
  const shownLead = leadName.trim() || lead?.name || "The orchestrator";

  const close = async () => {
    if (busy) return;
    if (!dirty) return onClose();
    if (!finalInfo.name) {
      setTab("info");
      return setError("The team needs a name.");
    }
    if (renamed && !leadName.trim()) {
      setTab("lead");
      return setError("The orchestrator needs a name.");
    }
    setBusy(true);
    setError(undefined);
    try {
      if (infoChanged) await backend.updateTeam(team.id, finalInfo);
      if (lead && renamed) await backend.renameBot(lead.id, leadName.trim());
      if (lead && rebriefed) await backend.updateBotConfig(lead.id, { ...lead.config, instructions });
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (overlay) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && void closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay]);

  const setMode = (mode: TeamMode) =>
    setInfo((i) => ({
      ...i,
      mode,
      // Start a first flow with every member in step 1.
      flow: mode === "flow" && i.flow.nodes.length === 0 ? { ...i.flow, nodes: memberIds.map((id) => newFlowNode(id, 0)) } : i.flow,
    }));

  const flowMembers: FlowMember[] = members.map((m) => ({ id: m.id, name: m.name, avatar: m.avatar }));
  const openCanvas = () =>
    setOverlay(
      <CanvasOverlay
        title={`${info.name.trim() || team.name} flow`}
        initial={info.flow}
        members={flowMembers}
        leadName={shownLead}
        leadColor={info.color}
        onDone={(flow) => {
          setInfo((i) => ({ ...i, flow }));
          setOverlay(undefined);
        }}
      />,
    );

  const footer = (
    <Footer
      status={
        dirty ? (
          <>
            <span className="size-1.5 rounded-full bg-unsaved" />
            Changes save when you close
          </>
        ) : (
          "Changes save when you close"
        )
      }
    >
      <button type="button" disabled={busy} onClick={() => void close()} className={okButton}>
        Done
      </button>
    </Footer>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-6" onMouseDown={() => !overlay && void close()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${team.name} settings`}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex h-[760px] max-h-full w-[800px] max-w-full overflow-hidden rounded-2xl border border-modal-line bg-surface shadow-[0_20px_50px_rgba(0,0,0,0.2),0_2px_6px_rgba(0,0,0,0.06)]"
      >
        <div role="tablist" aria-orientation="vertical" className="flex w-[200px] shrink-0 flex-col gap-0.5 bg-sidebar px-3 py-4">
          <div className="flex items-center gap-2.5 px-2 pt-0.5 pb-3.5">
            <TeamAvatar color={info.color} size={32} />
            <div className="flex min-w-0 flex-1 flex-col gap-px">
              <p className="truncate text-[14px] font-semibold text-ink">{team.name}</p>
              <p className="text-[12px] text-hint">Team settings</p>
            </div>
          </div>
          <NavItem active={tab === "info"} icon={<InfoIcon />} onClick={() => setTab("info")}>
            Team Info
          </NavItem>
          <NavItem active={tab === "lead"} icon={<LeadAvatar color={info.color} size={16} />} onClick={() => setTab("lead")}>
            Orchestrator
          </NavItem>
          <NavItem active={tab === "members"} icon={<TeamAvatar color="var(--color-icon)" size={16} />} onClick={() => setTab("members")}>
            Members
            <span className="ml-auto text-[12px] font-normal text-hint">{members.length + 1}</span>
          </NavItem>
          {info.mode === "flow" && (
            <NavItem active={tab === "flow"} icon={<FlowIcon />} onClick={() => setTab("flow")}>
              Flow
            </NavItem>
          )}
          {lead && (
            <NavItem active={tab === "tags"} icon={<TagIcon />} onClick={() => setTab("tags")}>
              Tags
              {lead.tags.length > 0 && <span className="ml-auto text-[12px] font-normal text-hint">{lead.tags.length}</span>}
            </NavItem>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {tab === "info" && (
            <>
              <Body title="Team Info" onClose={() => void close()}>
                <Field label="Team name" htmlFor="team-name">
                  <input
                    id="team-name"
                    autoFocus
                    value={info.name}
                    maxLength={MAX_TEAM_NAME}
                    spellCheck={false}
                    onChange={(e) => setInfo({ ...info, name: e.target.value })}
                    className={`${field} h-10`}
                  />
                </Field>
                <Field label="What does this team do?" htmlFor="team-purpose" hint="The orchestrator reads this to plan work and split it across members.">
                  <textarea
                    id="team-purpose"
                    rows={3}
                    value={info.purpose}
                    onChange={(e) => setInfo({ ...info, purpose: e.target.value })}
                    className={`${field} resize-none leading-[20px]`}
                  />
                </Field>
                <Field label="Color">
                  <ColorPicker value={info.color} onChange={(color) => setInfo({ ...info, color })} />
                </Field>
                {error && <p className="text-[12.5px] text-danger">{error}</p>}
              </Body>
              {footer}
            </>
          )}

          {tab === "lead" && (
            <>
              <Body title="Orchestrator" onClose={() => void close()}>
                <p className="-mt-2 text-[13px] leading-[19px] text-hint">
                  The orchestrator is who you talk to. It breaks your request into tasks, hands them to members, checks the results and replies with
                  one answer.
                </p>
                <Field label="Name" htmlFor="lead-name">
                  <input
                    id="lead-name"
                    value={leadName}
                    maxLength={MAX_NAME}
                    spellCheck={false}
                    onChange={(e) => setLeadName(e.target.value)}
                    className={`${field} h-10`}
                  />
                </Field>
                <Field label="Instructions" htmlFor="lead-instructions" hint="Members' own instructions still apply. Changing it starts a new conversation.">
                  <textarea
                    id="lead-instructions"
                    rows={5}
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    className={`${field} resize-none leading-[20px]`}
                  />
                </Field>
                <ModePicker leadName={shownLead} mode={info.mode} onChange={setMode} inSettings />
                {error && <p className="text-[12.5px] text-danger">{error}</p>}
              </Body>
              {footer}
            </>
          )}

          {tab === "members" && (
            <>
              <Body title="Members" onClose={() => void close()}>
                <MembersTab
                  team={team}
                  lead={lead}
                  members={members}
                  bots={bots}
                  teams={teams}
                  leadName={shownLead}
                  setOverlay={setOverlay}
                  onOpenChat={onOpenChat}
                  onDisbanded={onClose}
                />
              </Body>
              {footer}
            </>
          )}

          {tab === "flow" && (
            <>
              <Body title="Flow" onClose={() => void close()}>
                <div className="-mt-2 flex items-start justify-between gap-3">
                  <p className="text-[13px] leading-[19px] text-hint">
                    Who starts first, who runs together and who waits for whom. {shownLead} still writes each member's brief, but follows this
                    order.
                  </p>
                  <button type="button" disabled={members.length === 0} onClick={openCanvas} className={`${smallButton} shrink-0`}>
                    Open in editor
                  </button>
                </div>
                {members.length === 0 ? (
                  <p className="rounded-xl bg-sidebar px-4 py-6 text-center text-[13px] text-hint">Add members to lay out a flow.</p>
                ) : (
                  <FlowStepsList
                    flow={info.flow}
                    members={flowMembers}
                    leadName={shownLead}
                    leadColor={info.color}
                    onChange={(flow) => setInfo((i) => ({ ...i, flow }))}
                  />
                )}
                {error && <p className="text-[12.5px] text-danger">{error}</p>}
              </Body>
              {footer}
            </>
          )}

          {tab === "tags" && lead && <TagsTab bot={lead} onClose={() => void close()} />}
        </div>
      </div>
      {overlay}
    </div>
  );
}

/** The canvas edits a copy; "Done" hands it back. */
function CanvasOverlay({
  title,
  initial,
  members,
  leadName,
  leadColor,
  onDone,
}: {
  title: string;
  initial: Flow;
  members: FlowMember[];
  leadName: string;
  leadColor: string;
  onDone: (flow: Flow) => void;
}) {
  const [flow, setFlow] = useState(initial);
  return (
    <FlowCanvasModal
      title={title}
      flow={flow}
      members={members}
      leadName={leadName}
      leadColor={leadColor}
      onChange={setFlow}
      onClose={() => onDone(flow)}
    />
  );
}

function MembersTab({
  team,
  lead,
  members,
  bots,
  teams,
  leadName,
  setOverlay,
  onOpenChat,
  onDisbanded,
}: {
  team: Team;
  lead?: Bot;
  members: Bot[];
  bots: Bot[];
  teams: Team[];
  leadName: string;
  setOverlay: (node: ReactNode) => void;
  onOpenChat: (botId: string) => void;
  onDisbanded: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [menu, setMenu] = useState<string>();
  const [error, setError] = useState<string>();
  const dismiss = () => setOverlay(undefined);

  const run = async (call: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await call();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const items = (bot: Bot): { label: string; hint?: string; danger?: boolean; onClick: () => void }[] => [
    { label: "Open chat", onClick: () => onOpenChat(bot.id) },
    { label: "Edit agent", hint: "Name, instructions, folders, tools, AI model", onClick: () => setOverlay(<EditBotDialog bot={bot} onClose={dismiss} />) },
    { label: "Make orchestrator", hint: `${leadName} becomes a member`, onClick: () => void run(() => backend.makeLead(team.id, bot.id)) },
    { label: "Remove from team", hint: "Goes back to your bots, chats kept", onClick: () => void run(() => backend.removeTeamMember(team.id, bot.id)) },
    { label: "Delete agent", danger: true, onClick: () => setOverlay(<DeleteBotDialog bot={bot} onClose={dismiss} />) },
  ];

  return (
    <>
      <p className="-mt-2 text-[13px] leading-[19px] text-hint">
        {leadName} plans the work and hands tasks to these agents. Removing an agent turns it back into a normal bot.
      </p>
      <div className="flex flex-col divide-y divide-divider rounded-xl border border-modal-line">
        {lead && (
          <div className="flex items-center gap-3 px-3.5 py-2.5">
            <LeadAvatar color={team.color} size={28} />
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center gap-2">
                <p className="truncate text-[14px] font-medium text-ink">{lead.name}</p>
                <Chip>Orchestrator</Chip>
              </div>
              <p className="text-[12.5px] text-hint">Plans and delegates · talks to you</p>
            </div>
          </div>
        )}
        {members.map((bot) => (
          <div key={bot.id} className="relative flex items-center gap-3 px-3.5 py-2.5">
            <MemberAvatar bot={bot} team={team} size={28} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="truncate text-[14px] font-medium text-ink">{bot.name}</p>
              <RoleInput bot={bot} onError={setError} />
            </div>
            <button
              type="button"
              aria-label={`${bot.name} options`}
              aria-expanded={menu === bot.id}
              onClick={() => setMenu(menu === bot.id ? undefined : bot.id)}
              className="flex size-7 shrink-0 items-center justify-center rounded-lg text-[16px] leading-none text-icon hover:bg-bubble"
            >
              ⋯
            </button>
            {menu === bot.id && <RowMenu items={items(bot)} onClose={() => setMenu(undefined)} />}
          </div>
        ))}
      </div>
      {error && <p className="text-[12.5px] text-danger">{error}</p>}
      <div className="relative flex gap-2">
        <button
          type="button"
          onClick={() =>
            setOverlay(
              <NewMemberDialog
                teamName={team.name}
                leadName={leadName}
                onAdd={async (name, image, role) => {
                  await backend.createTeamMember(team.id, name, image, role);
                }}
                onClose={dismiss}
              />,
            )
          }
          className={smallButton}
        >
          <TinyPlusIcon /> Create new agent
        </button>
        <button type="button" onClick={() => setPicking((p) => !p)} className={smallButton}>
          <TinyPlusIcon /> Add existing bot
        </button>
        {picking && (
          <AddBotsPicker
            bots={bots}
            teams={teams}
            exclude={[team.leadId, ...team.members]}
            onAdd={(added) =>
              void run(async () => {
                for (const b of added) await backend.addTeamMember(team.id, b.id, b.teamRole || b.config.description);
              })
            }
            onClose={() => setPicking(false)}
          />
        )}
      </div>
      <div className="mt-2 flex items-center gap-3 rounded-xl border border-modal-line px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-[14px] font-medium text-ink">Disband team</p>
          <p className="text-[12.5px] text-hint">Members go back to your bots with their chats. The team chat is archived.</p>
        </div>
        <button
          type="button"
          onClick={() => setOverlay(<DisbandDialog team={team} onClose={dismiss} onDone={onDisbanded} />)}
          className="shrink-0 rounded-[15px] border border-button-line px-3.5 py-1.5 text-[13px] font-medium text-danger hover:bg-row-hover"
        >
          Disband
        </button>
      </div>
    </>
  );
}

/** A member's role, saved when the field loses focus. */
function RoleInput({ bot, onError }: { bot: Bot; onError: (error: string) => void }) {
  const [role, setRole] = useState(bot.teamRole);
  useEffect(() => setRole(bot.teamRole), [bot.teamRole]);
  return (
    <input
      value={role}
      placeholder="What does it do in the team?"
      aria-label={`${bot.name}'s role`}
      onChange={(e) => setRole(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      onBlur={() => {
        if (role.trim() !== bot.teamRole) backend.setMemberRole(bot.id, role.trim()).catch((e) => onError(errorText(e)));
      }}
      className="-ml-1 w-full rounded-md bg-transparent px-1 py-0.5 text-[12.5px] text-hint outline-none hover:bg-row-hover focus:bg-sidebar focus:text-ink"
    />
  );
}

function RowMenu({
  items,
  onClose,
}: {
  items: { label: string; hint?: string; danger?: boolean; onClick: () => void }[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
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
  return (
    <div
      ref={ref}
      role="menu"
      className="absolute top-full right-2 z-20 -mt-1 flex w-[250px] flex-col gap-0.5 rounded-xl border border-modal-line bg-surface p-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.12),0_1px_3px_rgba(0,0,0,0.06)]"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            item.onClick();
          }}
          className={`flex flex-col items-start gap-px rounded-lg px-2.5 py-1.5 text-left hover:bg-row-hover ${
            item.danger ? "mt-0.5 border-t border-divider pt-2 text-danger" : "text-ink"
          }`}
        >
          <span className="text-[13.5px]">{item.label}</span>
          {item.hint && <span className="text-[12px] text-hint">{item.hint}</span>}
        </button>
      ))}
    </div>
  );
}

function FlowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <rect x="1.5" y="2" width="5" height="4" rx="1.2" stroke="var(--color-icon)" strokeWidth="1.3" />
      <rect x="9.5" y="10" width="5" height="4" rx="1.2" stroke="var(--color-icon)" strokeWidth="1.3" />
      <path d="M6.5 4H9a1.5 1.5 0 0 1 1.5 1.5V10" stroke="var(--color-icon)" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
