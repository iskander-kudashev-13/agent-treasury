import { AI_ENABLED } from "@/lib/config";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

const STORAGE_KEY = "at.assistant.open";
const read = (): boolean => {
  if (!AI_ENABLED) return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};
const write = (open: boolean) => {
  try {
    localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
  } catch {
    /* storage unavailable: state is session-only */
  }
};

interface AssistantCtx {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** The chat input; the panel attaches it, `/` focuses it while the panel is open. */
  inputRef: RefObject<HTMLInputElement | null>;
  /** Open the panel with the input pre-filled (e.g. "Add a scheduled payment: "). */
  openWith: (text: string) => void;
  /** Pending prefill text, consumed by the panel. */
  prefill: string | null;
  clearPrefill: () => void;
}

const Ctx = createContext<AssistantCtx | null>(null);

/** Open/closed state of the assistant panel (remembered per browser) and the `/` shortcut. */
export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(read);
  const [prefill, setPrefill] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const setOpen = useCallback((v: boolean) => {
    setOpenState(v);
    write(v);
  }, []);
  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);
  const openWith = useCallback(
    (text: string) => {
      setPrefill(text);
      setOpen(true);
    },
    [setOpen],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const value = useMemo(
    () => ({ open, setOpen, toggle, inputRef, openWith, prefill, clearPrefill: () => setPrefill(null) }),
    [open, setOpen, toggle, openWith, prefill],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAssistantPanel(): AssistantCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAssistantPanel must be used inside <AssistantProvider>");
  return c;
}
