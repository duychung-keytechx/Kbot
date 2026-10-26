import type { BotIcon } from "../../lib/types";
import { BOT_ICON_GLYPHS } from "./botIcons";

/**
 * Inset per frame, as a fraction of `size`, so a glyph reads about as large
 * as a shape does in the same spot (see ShapeAvatar's FRAMES).
 */
const INSETS = { cell: 0.1, preview: 0, avatar: 0 } as const;

export function IconAvatar({
  icon,
  color,
  size,
  frame = "avatar",
}: {
  icon: BotIcon;
  color: string;
  size: number;
  frame?: keyof typeof INSETS;
}) {
  const g = BOT_ICON_GLYPHS[icon];
  const inset = Math.round(size * INSETS[frame]);
  return (
    <svg
      width={size - inset * 2}
      height={size - inset * 2}
      viewBox={g.viewBox}
      aria-hidden
      className="shrink-0"
      style={{ color, margin: inset }}
      // Static, bundled glyph markup (botIcons.ts), never user input.
      dangerouslySetInnerHTML={{ __html: g.body }}
    />
  );
}
