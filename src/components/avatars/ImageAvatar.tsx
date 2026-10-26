import type { BotImage } from "../../lib/types";

// The "Create New Bot" pictures: free Flaticon icons (credits in
// THIRD_PARTY_NOTICES.md), 256px so they stay sharp at the 112px preview.
const SOURCES = import.meta.glob<string>("../../assets/bots/*.png", { eager: true, import: "default" });
const src = (image: BotImage) => SOURCES[`../../assets/bots/${image}.png`];

export function ImageAvatar({ image, size }: { image: BotImage; size: number }) {
  return <img src={src(image)} width={size} height={size} alt="" draggable={false} className="shrink-0" />;
}
