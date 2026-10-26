import { useEffect, useState } from "react";
import { ChatView } from "./components/ChatView";
import { NewBotModal } from "./components/NewBotModal";
import { Sidebar } from "./components/Sidebar";
import { useBots } from "./lib/hooks";

export default function App() {
  const bots = useBots();
  const [selectedId, setSelectedId] = useState<string>();
  const [creating, setCreating] = useState(false);

  // Open on the most recently active bot.
  useEffect(() => {
    if (selectedId || bots.length === 0) return;
    setSelectedId(bots.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)).id);
  }, [bots, selectedId]);

  // ⌘N / Ctrl+N: new bot
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setCreating(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selected = bots.find((b) => b.id === selectedId);

  return (
    <div className="relative flex h-full overflow-hidden">
      <Sidebar bots={bots} selectedId={selectedId} onSelect={setSelectedId} onNewBot={() => setCreating(true)} />
      {selected ? (
        <ChatView bot={selected} />
      ) : (
        <main data-tauri-drag-region className="flex flex-1 flex-col items-center justify-center gap-3 bg-main">
          {bots.length === 0 && (
            <>
              <p className="text-[14px] text-hint">No bots yet</p>
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="rounded-[17px] bg-ink-strong px-4 py-2 text-[14px] font-medium text-white"
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
    </div>
  );
}
