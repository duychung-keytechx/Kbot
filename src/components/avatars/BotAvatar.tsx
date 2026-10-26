import type { Avatar } from "../../lib/types";
import { IconAvatar } from "./IconAvatar";
import { ShapeAvatar } from "./ShapeAvatar";

export function BotAvatar({ avatar, size = 30 }: { avatar: Avatar; size?: number }) {
  return avatar.kind === "icon" ? (
    <IconAvatar icon={avatar.icon} color={avatar.color} size={size} />
  ) : (
    <ShapeAvatar shape={avatar.shape} color={avatar.color} size={size} />
  );
}
