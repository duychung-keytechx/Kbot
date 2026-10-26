// Line icons from the mocks. Paths and stroke widths are copied verbatim;
// the SVG box is the icon's own size so it lays out like the mock's div.

type IconProps = { className?: string; color?: string };

function Stroke({ w, h, d, color, width, round, className }: {
  w: number;
  h: number;
  d: string;
  color: string;
  width: number;
  round?: boolean;
  className?: string;
}) {
  // Same construction as the mock's export (SVG padded by 4× the stroke and
  // pulled back with a negative margin) so strokes snap to the same pixels.
  const pad = width * 4;
  return (
    <span className={`block shrink-0 ${className ?? ""}`} style={{ width: w, height: h }}>
      <svg
        width={w + pad * 2}
        height={h + pad * 2}
        viewBox={`0 0 ${w + pad * 2} ${h + pad * 2}`}
        fill="none"
        overflow="visible"
        aria-hidden
        style={{ display: "block", margin: `${-pad}px 0 0 ${-pad}px` }}
      >
        <path
          transform={`translate(${pad} ${pad})`}
          d={d}
          stroke={color}
          strokeWidth={width}
          strokeLinecap={round ? "round" : undefined}
          strokeLinejoin={round ? "round" : undefined}
        />
      </svg>
    </span>
  );
}

/** Sidebar "new bot" (14px). */
export const PlusIcon = ({ color = "#6B6B6B", className }: IconProps) => (
  <Stroke w={14} h={14} d="M7 0L7 14M0 7L14 7" color={color} width={1.4} className={className} />
);

/** Composer "add" (12px). */
export const SmallPlusIcon = ({ color = "#6B6B6B", className }: IconProps) => (
  <Stroke w={12} h={12} d="M6 0L6 12M0 6L12 6" color={color} width={1.4} className={className} />
);

export const SearchIcon = ({ color = "#8A8A88", className }: IconProps) => (
  <Stroke
    w={14}
    h={14}
    d="M9.927 9.927L14 14M5.727 0C8.909 0 11.455 2.545 11.455 5.727C11.455 8.909 8.909 11.455 5.727 11.455C2.545 11.455 0 8.909 0 5.727C0 2.545 2.545 0 5.727 0Z"
    color={color}
    width={1.4}
    className={className}
  />
);

export const MicIcon = ({ color = "#FFFFFF", className }: IconProps) => (
  <Stroke
    w={13}
    h={14}
    d="M0 6.462C0 9.369 2.86 11.308 6.5 11.308C10.14 11.308 13 9.369 13 6.462M6.5 11.308L6.5 14M3.9 2.154C3.9 0.969 4.94 0 6.5 0C8.06 0 9.1 0.969 9.1 2.154L9.1 6.462C9.1 7.646 8.06 8.615 6.5 8.615C4.94 8.615 3.9 7.646 3.9 6.462L3.9 2.154Z"
    color={color}
    width={1.3}
    className={className}
  />
);

/** Not in the mock: replaces the mic once there is text to send. */
export const SendIcon = ({ color = "#FFFFFF", className }: IconProps) => (
  <Stroke w={12} h={14} d="M6 13L6 1M1 6L6 1L11 6" color={color} width={1.6} round className={className} />
);

/** Dialog close (12px). */
export const CloseIcon = ({ color = "#6B6B6B", className }: IconProps) => (
  <Stroke w={12} h={12} d="M0 0L12 12M12 0L0 12" color={color} width={1.5} round className={className} />
);

/** Composer "stop" while the bot is replying (10px filled square). */
export const StopIcon = ({ color = "#FFFFFF", className }: IconProps) => (
  <span className={`block size-[10px] shrink-0 rounded-[2px] ${className ?? ""}`} style={{ background: color }} />
);

/** Sidebar context menu: "Clear History" (14px circled ×). */
export const ClearIcon = ({ color = "#1F1F1F", className }: IconProps) => (
  <Stroke
    w={14}
    h={14}
    d="M7 0.5C10.59 0.5 13.5 3.41 13.5 7C13.5 10.59 10.59 13.5 7 13.5C3.41 13.5 0.5 10.59 0.5 7C0.5 3.41 3.41 0.5 7 0.5ZM4.75 4.75L9.25 9.25M9.25 4.75L4.75 9.25"
    color={color}
    width={1.2}
    round
    className={className}
  />
);

/** Sidebar context menu: "Delete Chat" (13×14 trash can). */
export const TrashIcon = ({ color = "#E5322D", className }: IconProps) => (
  <Stroke
    w={13}
    h={14}
    d="M0.5 3H12.5M4.5 3V1.5C4.5 0.95 4.95 0.5 5.5 0.5H7.5C8.05 0.5 8.5 0.95 8.5 1.5V3M1.75 3L2.6 12.6C2.65 13.1 3.07 13.5 3.6 13.5H9.4C9.93 13.5 10.35 13.1 10.4 12.6L11.25 3M5.25 6V10.5M7.75 6V10.5"
    color={color}
    width={1.2}
    round
    className={className}
  />
);

/** Sidebar: the bot has a daily job (11px). */
export const ClockIcon = ({ color = "#8F8F8C", className }: IconProps) => (
  <Stroke
    w={11}
    h={11}
    d="M5.5 2.5L5.5 5.5L7.5 6.75M5.5 0C8.538 0 11 2.462 11 5.5C11 8.538 8.538 11 5.5 11C2.462 11 0 8.538 0 5.5C0 2.462 2.462 0 5.5 0Z"
    color={color}
    width={1.1}
    round
    className={className}
  />
);
