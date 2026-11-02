// A team's chat: talking to its orchestrator (design/Kbot_agentteam_05_team_chat.html).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { backend, errorText } from "../../lib/api";
import { useMessages, useTags } from "../../lib/hooks";
import type { Bot, Message, Team } from "../../lib/types";
import { BotAvatar } from "../avatars/BotAvatar";
import { MessageItem } from "../ChatView";
import { Composer, type Mention } from "../Composer";
import { ConfirmDialog } from "../ConfirmDialog";
import { secondaryButton } from "../fields";
import { TagPills, tagsOf } from "../tags";
import { CheckNote, LeadAvatar, Speaker, TeamAvatar } from "./parts";
import { PlanCard } from "./PlanCard";
import type { TeamSettingsTab } from "./TeamSettingsDialog";

/** The member a message starts with, as "@Name"; the longest name wins. */
export function mentionOf(text: string, members: Bot[]): Bot | undefined {
  const t = text.trimStart().toLowerCase();
  return [...members]
    .sort((a, b) => b.name.length - a.name.length)
    .find((m) => t.startsWith(`@${m.name.toLowerCase()}`));
}

export function TeamChatView({
  team,
  bots,
  running,
  onOpen,
  onSettings,
}: {
  team: Team;
  bots: Bot[];
  running: Set<string>;
  /** Opens a member's chat. */
  onOpen: (botId: string) => void;
  onSettings: (tab?: TeamSettingsTab) => void;
}) {
  const messages = useMessages(team.id);
  const tags = useTags();
  const scroller = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  const [clearing, setClearing] = useState(false);
  const lead = bots.find((b) => b.id === team.leadId);
  const leadName = lead?.name ?? "Orchestrator";
  const members = team.members.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => !!b);
  const busy = running.has(team.id) || !!team.activity;
  const lastPlan = [...messages].reverse().find((m) => m.type === "plan");
  // The plan card shows progress; the dots are for the orchestrator thinking.
  const planLive = lastPlan?.type === "plan" && (lastPlan.state === "running" || lastPlan.state === "paused");

  useEffect(() => {
    setError(undefined);
    setClearing(false);
  }, [team.id]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const send = async (text: string) => {
    setError(undefined);
    try {
      await backend.sendTeamMessage(team.id, text, mentionOf(text, members)?.id);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  };

  const mentions: Mention[] = members.map((m) => ({
    id: m.id,
    name: m.name,
    hint: m.teamRole || m.config.description,
    avatar: <BotAvatar avatar={m.avatar} size={26} />,
  }));

  const item = (m: Message) => {
    switch (m.type) {
      case "agent":
        return (
          <div key={m.id} className="flex flex-col items-start gap-1.5">
            <Speaker avatar={<LeadAvatar color={team.color} size={16} />} name={leadName} />
            <Bubble text={m.text} />
          </div>
        );
      case "member": {
        const bot = bots.find((b) => b.id === m.botId);
        return (
          <div key={m.id} className="flex flex-col items-start gap-1.5">
            <button type="button" onClick={() => bot && onOpen(bot.id)} className="rounded-md hover:bg-row-hover">
              <Speaker avatar={bot ? <BotAvatar avatar={bot.avatar} size={16} /> : null} name={m.name} />
            </button>
            <Bubble text={m.text} />
          </div>
        );
      }
      case "system":
        return <CheckNote key={m.id} text={m.text} />;
      case "plan":
        return (
          <PlanCard
            key={m.id}
            team={team}
            plan={m}
            bots={bots}
            latest={m.id === lastPlan?.id}
            onOpen={onOpen}
            onViewFlow={() => onSettings("flow")}
          />
        );
      default:
        return <MessageItem key={m.id} botId={team.id} message={m} team={team} />;
    }
  };

  return (
    <div className="flex min-w-0 flex-1">
      <main className="flex min-w-0 flex-1 flex-col bg-main">
        <header data-tauri-drag-region className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-main px-4">
          <TeamAvatar color={team.color} size={18} />
          <p className="truncate text-[13.5px] font-semibold text-ink">{team.name}</p>
          <span className="text-[13px] text-hint">·</span>
          <p className="shrink-0 text-[13px] text-hint">
            {leadName}
            {members.length > 0 && ` + ${members.length} agent${members.length === 1 ? "" : "s"}`}
          </p>
          {lead && <TagPills tags={tagsOf(lead.tags, tags)} max={4} />}
          <div data-tauri-drag-region className="flex-1 self-stretch" />
          <button type="button" onClick={() => onSettings()} className={secondaryButton}>
            Team settings
          </button>
        </header>

        <div ref={scroller} className="flex min-h-0 flex-1 flex-col items-start gap-3 overflow-y-auto px-6 pt-5 pb-4">
          {messages.length === 0 && !busy ? <EmptyState team={team} leadName={leadName} members={members} /> : messages.map(item)}
          {running.has(team.id) && !planLive && <Typing />}
        </div>

        {error && (
          <div className="flex items-center gap-3 px-6">
            <p className="min-w-0 flex-1 text-[12.5px] text-danger">{error}</p>
          </div>
        )}

        <Composer
          key={team.id}
          botName={team.name}
          placeholder={`Message ${team.name} · type @ to ask one member`}
          commands={["clear-history"]}
          mentions={mentions}
          running={busy}
          sendWhileRunning
          onSend={send}
          onStop={() => void backend.cancelRun(team.id)}
          onCommand={(name) => (name === "clear-history" ? setClearing(true) : undefined)}
        />
      </main>
      {clearing && (
        <ConfirmDialog
          title="Clear History"
          message={`Delete all messages in ${team.name}'s chat? Members keep their own chats. This can't be undone.`}
          confirmLabel="Clear History"
          onConfirm={() => backend.clearChat(team.id)}
          onClose={() => setClearing(false)}
        />
      )}
    </div>
  );
}

function Bubble({ text }: { text: string }) {
  return (
    <div className="rounded-2xl bg-bubble px-3.5 py-[11px]">
      <p className="selectable max-w-[530px] text-[14px] leading-[21px] break-words whitespace-pre-wrap text-ink">{text}</p>
    </div>
  );
}

function Typing() {
  return (
    <div aria-label="Working" className="flex gap-1 rounded-2xl bg-bubble px-3.5 py-[15px]">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="size-[6px] animate-bounce rounded-full bg-hint"
          style={{ animationDelay: `${delay}ms`, animationDuration: "1s" }}
        />
      ))}
    </div>
  );
}

function EmptyState({ team, leadName, members }: { team: Team; leadName: string; members: Bot[] }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 self-stretch pb-10 text-center">
      <TeamAvatar color={team.color} size={52} />
      <p className="text-[14px] text-hint">
        Ask {leadName} for something. It splits the work across {members.length > 0 ? members.map((m) => m.name).join(", ") : "the team"}.
      </p>
    </div>
  );
}
