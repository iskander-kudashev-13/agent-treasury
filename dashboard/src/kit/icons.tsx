// Inline icons drawn on the lucide 24×24 grid (DESIGN_SYSTEM.md §4: lucide style, never emoji).
// Kept inline so the kit adds no dependency; swap for `lucide-react` later without changing call sites' props.
import type { ReactNode, SVGProps } from "react";

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number; strokeWidth?: number };

function make(name: string, paths: ReactNode, fill = false) {
  const Icon = ({ size = 16, strokeWidth = 2, ...rest }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {paths}
    </svg>
  );
  Icon.displayName = name;
  return Icon;
}

export const Check = make("Check", <path d="M20 6 9 17l-5-5" />);
export const X = make("X", <path d="M18 6 6 18M6 6l12 12" />);
export const Plus = make("Plus", <path d="M12 5v14M5 12h14" />);
export const ArrowDown = make("ArrowDown", <path d="M12 5v14M5 12l7 7 7-7" />);
export const ArrowUp = make("ArrowUp", <path d="M12 19V5M5 12l7-7 7 7" />);
export const ChevronRight = make("ChevronRight", <path d="m9 18 6-6-6-6" />);
export const ExternalLink = make("ExternalLink", <><path d="M15 3h6v6M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>);
export const Copy = make("Copy", <><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>);
export const ShieldCheck = make("ShieldCheck", <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></>);
export const KeyRound = make("KeyRound", <><path d="M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z" /><circle cx="16.5" cy="7.5" r=".5" fill="currentColor" /></>);
export const Lock = make("Lock", <><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>);
export const Calendar = make("Calendar", <><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>);
export const Zap = make("Zap", <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />);
export const Clock = make("Clock", <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const Sparkles = make("Sparkles", <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 17l.7 2.3L22 20l-2.3.7L19 23l-.7-2.3L16 20l2.3-.7z" />);
export const AlertTriangle = make("AlertTriangle", <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>);
export const Info = make("Info", <><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></>);
export const Send = make("Send", <path d="m22 2-7 20-4-9-9-4zM22 2 11 13" />);
export const Pause = make("Pause", <><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></>, true);
export const Play = make("Play", <path d="M7 5v14l12-7z" />, true);
export const Loader = make("Loader", <path d="M21 12a9 9 0 1 1-6.2-8.6" />);
