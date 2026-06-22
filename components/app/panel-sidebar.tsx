"use client";

import * as React from "react";
import { PanelRightIcon } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { shouldIgnoreShortcut } from "@/lib/keyboard-shortcuts";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

const PANEL_WIDTH_STORAGE_KEY = "grader-good:panel-sidebar-width";
const PANEL_OPEN_STORAGE_KEY = "grader-good:panel-sidebar-open";
export const PANEL_DEFAULT_WIDTH = 384; // 24rem
export const PANEL_MIN_WIDTH = 288; // 18rem
export const PANEL_MAX_WIDTH = 640; // 40rem
export const PANEL_ICON_WIDTH = 48; // 3rem

type PanelSidebarContextProps = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  togglePanel: () => void;
  width: number;
  setWidth: (width: number) => void;
};

const PanelSidebarContext =
  React.createContext<PanelSidebarContextProps | null>(null);

export function usePanelSidebar() {
  const context = React.useContext(PanelSidebarContext);
  if (!context) {
    throw new Error("usePanelSidebar must be used within PanelSidebarProvider.");
  }
  return context;
}

export function usePanelSidebarOptional() {
  return React.useContext(PanelSidebarContext);
}

function readStoredWidth(): number {
  if (typeof window === "undefined") return PANEL_DEFAULT_WIDTH;
  try {
    const raw = localStorage.getItem(PANEL_WIDTH_STORAGE_KEY);
    if (!raw) return PANEL_DEFAULT_WIDTH;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) return PANEL_DEFAULT_WIDTH;
    return Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, parsed));
  } catch {
    return PANEL_DEFAULT_WIDTH;
  }
}

function readStoredOpen(
  defaultOpen: boolean,
  storageKey: string | null
): boolean {
  if (storageKey === null || typeof window === "undefined") return defaultOpen;
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return defaultOpen;
    return raw === "true";
  } catch {
    return defaultOpen;
  }
}

export function PanelSidebarProvider({
  defaultOpen = true,
  persistOpen = true,
  openStorageKey = PANEL_OPEN_STORAGE_KEY,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean;
  /** When false, open state is not read from or written to localStorage. */
  persistOpen?: boolean;
  /** localStorage key for open state; pass null to skip persistence entirely. */
  openStorageKey?: string | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = React.useState(false);
  const [width, setWidthState] = React.useState(PANEL_DEFAULT_WIDTH);
  const [hydrated, setHydrated] = React.useState(false);

  const [_open, _setOpen] = React.useState(defaultOpen);
  const open = openProp ?? _open;

  const resolvedOpenStorageKey = persistOpen ? openStorageKey : null;

  React.useEffect(() => {
    setWidthState(readStoredWidth());
    _setOpen(readStoredOpen(defaultOpen, resolvedOpenStorageKey));
    setHydrated(true);
  }, [defaultOpen, resolvedOpenStorageKey]);

  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === "function" ? value(open) : value;
      if (setOpenProp) {
        setOpenProp(openState);
      } else {
        _setOpen(openState);
      }
      if (resolvedOpenStorageKey === null) return;
      try {
        localStorage.setItem(resolvedOpenStorageKey, String(openState));
      } catch {
        /* ignore */
      }
    },
    [setOpenProp, open, resolvedOpenStorageKey]
  );

  const setWidth = React.useCallback((next: number) => {
    const clamped = Math.min(
      PANEL_MAX_WIDTH,
      Math.max(PANEL_MIN_WIDTH, Math.round(next))
    );
    setWidthState(clamped);
    try {
      localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(clamped));
    } catch {
      /* ignore */
    }
  }, []);

  const togglePanel = React.useCallback(() => {
    return isMobile ? setOpenMobile((v) => !v) : setOpen((v) => !v);
  }, [isMobile, setOpen]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "]" || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (shouldIgnoreShortcut(event.target)) return;
      event.preventDefault();
      togglePanel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [togglePanel]);

  const state = open ? "expanded" : "collapsed";

  const contextValue = React.useMemo<PanelSidebarContextProps>(
    () => ({
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      togglePanel,
      width: hydrated ? width : PANEL_DEFAULT_WIDTH,
      setWidth,
    }),
    [
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      togglePanel,
      width,
      setWidth,
      hydrated,
    ]
  );

  return (
    <PanelSidebarContext.Provider value={contextValue}>
      <div
        data-slot="panel-sidebar-wrapper"
        className={cn("flex min-h-0 w-full flex-1", className)}
        {...props}
      >
        {children}
      </div>
    </PanelSidebarContext.Provider>
  );
}

export function PanelSidebarInset({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const { open, width, isMobile, state } = usePanelSidebar();
  const paddingRight =
    !isMobile && open ? width : !isMobile && state === "collapsed" ? PANEL_ICON_WIDTH : 0;

  return (
    <div
      data-slot="panel-sidebar-inset"
      className={cn("min-w-0 flex-1 transition-[padding] duration-200 ease-linear", className)}
      style={{ paddingRight: isMobile ? 0 : paddingRight }}
      {...props}
    >
      {children}
    </div>
  );
}

export function PanelSidebarTrigger({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { togglePanel } = usePanelSidebar();

  return (
    <Button
      data-slot="panel-sidebar-trigger"
      variant="ghost"
      size="icon"
      className={cn("size-7", className)}
      onClick={(event) => {
        onClick?.(event);
        togglePanel();
      }}
      {...props}
    >
      <PanelRightIcon />
      <span className="sr-only">Toggle panel</span>
    </Button>
  );
}

export function PanelSidebar({
  className,
  children,
  collapsible = "icon",
}: {
  className?: string;
  children: React.ReactNode;
  collapsible?: "icon" | "offcanvas";
}) {
  const { isMobile, open, openMobile, setOpenMobile, width, setWidth, state, setOpen } =
    usePanelSidebar();
  const resizeRef = React.useRef<{ startX: number; startWidth: number } | null>(
    null
  );

  const onResizePointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!open) return;
      e.preventDefault();
      resizeRef.current = { startX: e.clientX, startWidth: width };
      const onMove = (ev: PointerEvent) => {
        if (!resizeRef.current) return;
        const delta = resizeRef.current.startX - ev.clientX;
        setWidth(resizeRef.current.startWidth + delta);
      };
      const onUp = () => {
        resizeRef.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [open, setWidth, width]
  );

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent
          side="right"
          className="w-[min(24rem,100vw)] bg-sidebar p-0 text-sidebar-foreground [&>button]:hidden"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Controls panel</SheetTitle>
            <SheetDescription>Image editing controls.</SheetDescription>
          </SheetHeader>
          <div className="flex h-full w-full flex-col overflow-hidden">
            {children}
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  const panelWidth = open ? width : PANEL_ICON_WIDTH;

  return (
    <div
      data-slot="panel-sidebar"
      data-state={state}
      data-collapsible={state === "collapsed" ? collapsible : ""}
      className="pointer-events-none fixed inset-y-0 right-0 z-20 hidden md:block"
      style={{ width: panelWidth }}
    >
      {open && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          onPointerDown={onResizePointerDown}
          className="pointer-events-auto absolute inset-y-0 left-0 z-30 w-1 -translate-x-1/2 cursor-ew-resize after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-sidebar-border"
        />
      )}
      <div
        className={cn(
          "pointer-events-auto flex h-full flex-col border-l bg-sidebar text-sidebar-foreground shadow-sm transition-[width] duration-200 ease-linear",
          collapsible === "offcanvas" && !open && "translate-x-full",
          className
        )}
        style={{ width: panelWidth }}
      >
        {children}
      </div>
      {!open && collapsible === "icon" && (
        <button
          type="button"
          aria-label="Expand panel"
          onClick={() => setOpen(true)}
          className="pointer-events-auto absolute inset-y-0 left-0 flex w-full items-center justify-center hover:bg-sidebar-accent"
        >
          <PanelRightIcon className="size-4" />
        </button>
      )}
    </div>
  );
}

export function PanelSidebarContent({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const { open } = usePanelSidebar();
  if (!open) return null;
  return (
    <div
      data-slot="panel-sidebar-content"
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-hidden",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function PanelSidebarRail({
  className,
  ...props
}: React.ComponentProps<"button">) {
  const { togglePanel } = usePanelSidebar();

  return (
    <button
      data-slot="panel-sidebar-rail"
      aria-label="Toggle panel"
      tabIndex={-1}
      onClick={togglePanel}
      title="Toggle panel (])"
      className={cn(
        "absolute inset-y-0 left-0 z-20 hidden w-4 -translate-x-1/2 transition-all ease-linear after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-sidebar-border sm:flex cursor-w-resize",
        className
      )}
      {...props}
    />
  );
}
