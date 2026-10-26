import type { BotIcon } from "../../lib/types";
import { BOT_ICON_GLYPHS } from "./botIcons";

/** An older bot's robot glyph, drawn in its color. */
export function IconAvatar({ icon, color, size }: { icon: BotIcon; color: string; size: number }) {
  const g = BOT_ICON_GLYPHS[icon];
  return (
    <svg
      width={size}
      height={size}
      viewBox={g.viewBox}
      aria-hidden
      className="shrink-0"
      style={{ color }}
      // Static, bundled glyph markup (botIcons.ts), never user input.
      dangerouslySetInnerHTML={{ __html: g.body }}
    />
  );
}
