import { useEffect, useState } from "react";
import { AppSettingsDialog } from "./components/AppSettingsDialog";
import { ChatView } from "./components/ChatView";
import { ConnectClaude } from "./components/ConnectClaude";
import { ConnectCodex } from "./components/ConnectCodex";
import { NewBotModal } from "./components/NewBotModal";
import { Sidebar } from "./components/Sidebar";
import { NewTeamWizard } from "./components/teams/NewTeamWizard";
import { TeamChatView } from "./components/teams/TeamChatView";
import { TeamSettingsDialog, type TeamSettingsTab } from "./components/teams/TeamSettingsDialog";
import { backend } from "./lib/api";
import {
  useAppSettings,
  useBots,
  useClaudeStatus,
  useCodexStatus,
  useRunning,
  useTeams,
  useWindowFocused,
} from "./lib/hooks";
import { applyTheme } from "./lib/theme";

export default function App() {
  const bots = useBots();
  const teams = useTeams();
  const running = useRunning();
  const settings = useAppSettings();
  const claude = useClaudeStatus(settings?.provider === "claude");
  const codex = useCodexStatus(settings?.provider === "codex");
  const focused = useWindowFocused();
  const [selectedId, setSelectedId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // "New team", with the bot it starts from ("New team with this bot…").
  const [newTeam, setNewTeam] = useState<{ botId?: string }>();
  const [teamSettings, setTeamSettings] = useState<{ teamId: string; tab?: TeamSettingsTab }>();

  // A team's orchestrator is talked to in the team chat.
  const select = (id: string) => setSelectedId(teams.find((t) => t.leadId === id)?.id ?? id);

  // Open on the most recently active bot or team, also when the open one is deleted.
  useEffect(() => {
    const lead = teams.find((t) => t.leadId === selectedId);
    if (lead) return setSelectedId(lead.id);
    if (selectedId && (bots.some((b) => b.id === selectedId) || teams.some((t) => t.id === selectedId))) return;
    const candidates = [
      ...bots.filter((b) => !b.teamId || !teams.some((t) => t.id === b.teamId)),
      ...teams,
    ];
    if (candidates.length === 0) return setSelectedId(undefined);
    setSelectedId(candidates.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)).id);
  }, [bots, teams, selectedId]);

  // ⌘N / Ctrl+N: new bot. ⌘, / Ctrl+,: settings (on macOS the menu bar's
  // Kbot > Settings… catches ⌘, first and sends `kbot://open-settings`).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        setCreating(true);
      } else if (e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    const offSettings = backend.onOpenSettings(() => setSettingsOpen(true));
    return () => {
      window.removeEventListener("keydown", onKey);
      offSettings();
    };
  }, []);

  const theme = settings?.theme;
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);

  const selected = bots.find((b) => b.id === selectedId);
  const selectedTeam = teams.find((t) => t.id === selectedId);
  const teamOf = (bot: { teamId: string | null }) => teams.find((t) => t.id === bot.teamId);
  // The active provider's CLI isn't ready: its Connect screen replaces the chat.
  const connect =
    claude.status && claude.status.state !== "ready" ? (
      <ConnectClaude status={claude.status} checking={claude.checking} onCheck={claude.check} onSettings={() => setSettingsOpen(true)} />
    ) : codex.status && codex.status.state !== "ready" ? (
      <ConnectCodex status={codex.status} checking={codex.checking} onCheck={codex.check} onSettings={() => setSettingsOpen(true)} />
    ) : null;
  const chatShown = !!(selected || selectedTeam) && !connect;

  // The chat being looked at is read; its job results don't count as unread.
  const viewing = focused && chatShown ? (selectedTeam?.id ?? selected?.id ?? null) : null;
  useEffect(() => {
    backend.setViewing(viewing).catch((e) => console.error(e));
  }, [viewing]);

  return (
    <div className="relative flex h-full overflow-hidden">
      <Sidebar
        bots={bots}
        teams={teams}
        running={running}
        selectedId={selectedId}
        onSelect={select}
        onNewBot={() => setCreating(true)}
        onNewTeam={(botId) => setNewTeam({ botId })}
        onTeamSettings={(teamId) => setTeamSettings({ teamId })}
      />
      {connect ? (
        connect
      ) : selectedTeam ? (
        <TeamChatView
          team={selectedTeam}
          bots={bots}
          running={running}
          onOpen={select}
          onSettings={(tab) => setTeamSettings({ teamId: selectedTeam.id, tab })}
        />
      ) : selected ? (
        <ChatView
          bot={selected}
          running={running.has(selected.id)}
          team={teamOf(selected)}
          lead={bots.find((b) => b.id === teamOf(selected)?.leadId)}
          onOpenTeam={() => selected.teamId && setSelectedId(selected.teamId)}
        />
      ) : (
        <main data-tauri-drag-region className="flex flex-1 flex-col items-center justify-center gap-3 bg-main">
          {bots.length === 0 && (
            <>
              <p className="text-[14px] text-hint">No bots yet</p>
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="rounded-[17px] bg-ink-strong px-4 py-2 text-[14px] font-medium text-ink-inverse"
              >
                Create New Bot
              </button>
            </>
          )}
        </main>
      )}
      {creating && (
        <NewBotModal
          onClose={() => setCreating(false)}
          onCreated={(bot) => {
            setCreating(false);
            setSelectedId(bot.id);
          }}
        />
      )}
      {settingsOpen && <AppSettingsDialog onClose={() => setSettingsOpen(false)} />}
      {newTeam && (
        <NewTeamWizard
          bots={bots}
          teams={teams}
          startWith={newTeam.botId}
          onClose={() => setNewTeam(undefined)}
          onCreated={(team) => {
            setNewTeam(undefined);
            setSelectedId(team.id);
          }}
        />
      )}
      {teamSettings && teams.some((t) => t.id === teamSettings.teamId) && (
        <TeamSettingsDialog
          team={teams.find((t) => t.id === teamSettings.teamId)!}
          bots={bots}
          teams={teams}
          initialTab={teamSettings.tab}
          onOpenChat={(id) => {
            setTeamSettings(undefined);
            select(id);
          }}
          onClose={() => setTeamSettings(undefined)}
        />
      )}
    </div>
  );
}
