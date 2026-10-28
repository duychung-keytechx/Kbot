import type { CSSProperties } from "react";
import type { Tag } from "../lib/types";

/** A tag's color. The ring keeps dark colors visible in dark mode. */
export function TagDot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <span
      className="shrink-0 rounded-full shadow-[inset_0_0_0_1px_var(--color-tag-ring)]"
      style={{ width: size, height: size, background: color }}
    />
  );
}

/** Sets the color a `tag-tint` element is tinted with. */
export const tagStyle = (color: string) => ({ "--tag": color }) as CSSProperties;

/** The bot's tags as small chips tinted with their colors, up to `max`, then "+N" with the rest on hover. */
export function TagLabels({ tags, max = 3 }: { tags: Tag[]; max?: number }) {
  if (tags.length === 0) return null;
  const rest = tags.slice(max);
  return (
    <ul aria-label="Tags" className="flex min-w-0 items-center gap-1 overflow-hidden">
      {tags.slice(0, max).map((tag) => (
        <li
          key={tag.id}
          style={tagStyle(tag.color)}
          className="tag-tint min-w-0 truncate rounded-[4px] px-1.5 text-[11px] leading-4 font-medium"
        >
          {tag.name}
        </li>
      ))}
      {rest.length > 0 && (
        <li title={rest.map((t) => t.name).join(", ")} className="shrink-0 text-[11px] leading-[14px] text-hint">
          +{rest.length}
        </li>
      )}
    </ul>
  );
}

/** The bot's tags as tinted pills; past `max`, "+N" with the rest on hover. */
export function TagPills({ tags, max = 3 }: { tags: Tag[]; max?: number }) {
  if (tags.length === 0) return null;
  const rest = tags.slice(max);
  return (
    <ul aria-label="Tags" className="flex min-w-0 shrink items-center gap-1 overflow-hidden">
      {tags.slice(0, max).map((tag) => (
        <li
          key={tag.id}
          style={tagStyle(tag.color)}
          className="tag-tint min-w-0 truncate rounded-full px-2 py-[2px] text-[12px] leading-4 font-medium"
        >
          {tag.name}
        </li>
      ))}
      {rest.length > 0 && (
        <li title={rest.map((t) => t.name).join(", ")} className="shrink-0 px-1 text-[12px] text-hint">
          +{rest.length}
        </li>
      )}
    </ul>
  );
}

/** `ids` as tags, in the bot's order, skipping any that were deleted. */
export const tagsOf = (ids: string[], tags: Tag[]) =>
  ids.map((id) => tags.find((t) => t.id === id)).filter((t): t is Tag => !!t);
