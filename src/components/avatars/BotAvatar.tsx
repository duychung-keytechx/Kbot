import type { Avatar } from "../../lib/types";
import { IconAvatar } from "./IconAvatar";
import { ImageAvatar } from "./ImageAvatar";
import { ShapeAvatar } from "./ShapeAvatar";

export function BotAvatar({ avatar, size = 30 }: { avatar: Avatar; size?: number }) {
  switch (avatar.kind) {
    case "image":
      return <ImageAvatar image={avatar.image} size={size} />;
    case "icon":
      return <IconAvatar icon={avatar.icon} color={avatar.color} size={size} />;
    case "shape":
      return <ShapeAvatar shape={avatar.shape} color={avatar.color} size={size} />;
  }
}
