import { useAppStore } from "@/store/app-store";

const MAXIMIZED_BOUNDS_CLASS = "inset-0 rounded-none";
const WINDOWED_BOUNDS_CLASS = "inset-0 [clip-path:inset(1px_round_15px)]";

export function useWindowOverlayBoundsClassName(): string {
  const isWindowMaximized = useAppStore((state) => state.isWindowMaximized);
  return isWindowMaximized ? MAXIMIZED_BOUNDS_CLASS : WINDOWED_BOUNDS_CLASS;
}
