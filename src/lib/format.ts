/** Sidebar timestamp: "8:27 AM" today, "Yesterday", weekday this week, else "Oct 3". */
export function formatListTime(ms: number, now = new Date()): string {
  const d = new Date(ms);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const isMac = /Mac/.test(navigator.platform) || /Macintosh/.test(navigator.userAgent);
