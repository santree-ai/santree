/** A Web tab: a slim toolbar — back, forward, reload, the address, out to the
 *  default browser — over the page. The page is a native view the backend lays
 *  over the placeholder below the toolbar (`useBrowserPage`); what this renders
 *  in the placeholder only shows when the page doesn't: a blank tab waiting for
 *  an address, an address that didn't open, a crash, or the still the page
 *  leaves behind while a modal covers it. */
import { openUrl } from "@tauri-apps/plugin-opener";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import { type BrowserFailure, commands, type WorktreeTab } from "../../bindings";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  ExternalLinkIcon,
  GlobeIcon,
  RefreshIcon,
  WarningIcon,
} from "../../components/icons";
import { Button, EmptyState } from "../../components/primitives";
import { useBrowserSupported } from "../../lib/queries";
import { toast } from "../../state/toast";
import { pageState, setPageState, usePageState } from "./pageState";
import { FOCUS_ADDRESS_EVENT } from "./useBrowserEvents";
import { useBrowserPage } from "./useBrowserPage";

const TOOL =
  "flex h-[22px] w-[22px] flex-none cursor-pointer items-center justify-center rounded text-muted-2 hover:bg-hover hover:text-fg-2 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent";

export function WebTabPane({
  tab,
  focused,
}: {
  tab: WorktreeTab;
  /** The tab is the one picked in the focused split group: its page takes the
   *  keyboard (or, blank, its address bar does). */
  focused: boolean;
}) {
  const state = usePageState(tab.id);
  const supported = useBrowserSupported().data;
  // The address the page opens on: the tab's own (a link opened into it, the
  // page it was on at the last restart) or, for a blank tab, the first one typed.
  const [opening, setOpening] = useState<string | null>(tab.url);
  const anchor = useRef<HTMLDivElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);

  const hasPage = opening !== null || !!state?.url;
  const failure = state?.failure ?? null;
  const crashed = !!state?.crashed;
  // The page stands aside for an address that didn't open, or a crash; the pane
  // says why.
  const showPage = supported === true && hasPage && !failure && !crashed;
  const { still, stillShown } = useBrowserPage({
    id: tab.id,
    url: opening,
    anchor,
    show: showPage,
  });

  // A pane mounting after its page was made — the app's own webview reloaded —
  // asks where the page is rather than waiting for its next change.
  useEffect(() => {
    if (pageState(tab.id)) return;
    void commands.browserState(tab.id).then((res) => {
      if (res.status === "ok" && res.data) setPageState(res.data);
    });
  }, [tab.id]);

  // Picking the tab hands it the keyboard, the way picking a terminal tab does —
  // to the page when it is on screen, else to the address bar.
  useEffect(() => {
    if (!focused) return;
    if (showPage) void commands.browserFocus(tab.id);
    else if (!hasPage) address.current?.focus();
  }, [focused, showPage, hasPage, tab.id]);

  // ⌘L, pressed in the page.
  useEffect(() => {
    const onFocusAddress = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== tab.id) return;
      address.current?.focus();
      address.current?.select();
    };
    window.addEventListener(FOCUS_ADDRESS_EVENT, onFocusAddress);
    return () => window.removeEventListener(FOCUS_ADDRESS_EVENT, onFocusAddress);
  }, [tab.id]);

  // While a load runs the page's URL is where it is going; once one fails, the
  // page goes back to naming the page before it, so the failure says what failed.
  const current = (failure && !state?.loading ? failure.url : state?.url) || opening || "";

  const go = async (input: string) => {
    const resolved = await commands.browserResolve(input);
    if (resolved.status === "error") {
      toast.error(resolved.error);
      return;
    }
    setDraft(null);
    address.current?.blur();
    // A blank tab makes its page on the first address; after that it navigates.
    if (!hasPage) setOpening(resolved.data);
    else void commands.browserLoad(tab.id, resolved.data);
    void commands.browserFocus(tab.id);
  };

  const onAddressKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && draft?.trim()) {
      e.preventDefault();
      void go(draft);
    } else if (e.key === "Escape") {
      setDraft(null);
      e.currentTarget.blur();
      if (hasPage) void commands.browserFocus(tab.id);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative flex h-9 flex-none items-center gap-1 border-b border-line px-2">
        <button
          type="button"
          aria-label="Back"
          title="Back (⌘[)"
          disabled={!state?.canGoBack}
          onClick={() => void commands.browserNav(tab.id, "Back")}
          className={TOOL}
        >
          <ChevronLeftIcon size={12} />
        </button>
        <button
          type="button"
          aria-label="Forward"
          title="Forward (⌘])"
          disabled={!state?.canGoForward}
          onClick={() => void commands.browserNav(tab.id, "Forward")}
          className={TOOL}
        >
          <ChevronRightIcon size={12} />
        </button>
        {state?.loading ? (
          <button
            type="button"
            aria-label="Stop loading"
            title="Stop"
            onClick={() => void commands.browserNav(tab.id, "Stop")}
            className={TOOL}
          >
            <CloseIcon size={10} />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Reload"
            title="Reload (⌘R)"
            disabled={!hasPage}
            onClick={() => void commands.browserNav(tab.id, "Reload")}
            className={TOOL}
          >
            <RefreshIcon size={11} />
          </button>
        )}
        <input
          ref={address}
          aria-label="Address"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="Search or type an address"
          value={draft ?? current}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => setDraft(null)}
          onKeyDown={onAddressKey}
          className="selectable mx-1 h-[24px] min-w-0 flex-1 rounded-md border border-line bg-panel px-2 text-sm text-fg-2 outline-none placeholder:text-muted-4 focus-visible:border-accent"
        />
        <button
          type="button"
          aria-label="Open in your browser"
          title="Open in your default browser"
          disabled={!current}
          onClick={() => void openUrl(current)}
          className={TOOL}
        >
          <ExternalLinkIcon size={11} />
        </button>
        {state?.loading && (
          <div
            aria-hidden
            className="absolute bottom-[-1px] left-0 h-[2px] bg-accent transition-[width] duration-200"
            style={{ width: `${Math.max(8, (state.progress ?? 0) * 100)}%` }}
          />
        )}
      </div>
      <div ref={anchor} className="relative min-h-0 flex-1 bg-panel">
        {still && (
          <img
            src={still}
            alt=""
            draggable={false}
            onLoad={stillShown}
            className="pointer-events-none absolute inset-0 h-full w-full select-none"
          />
        )}
        {supported === false ? (
          <EmptyState
            icon={<GlobeIcon size={18} />}
            title="Web tabs need macOS 14"
            subtitle="This Mac's WebKit can't give a page its own cookie store. Links still open in your default browser."
          />
        ) : !hasPage ? (
          <EmptyState
            icon={<GlobeIcon size={18} />}
            title="Open a page"
            subtitle="Type an address or a search above. Links you click in this workspace's terminals open here too."
          />
        ) : crashed ? (
          <PageTrouble
            title="This page stopped working"
            detail="Its web process quit. Reloading starts it again."
            retrying={!!state?.loading}
            onRetry={() => void commands.browserNav(tab.id, "Reload")}
          />
        ) : failure ? (
          <PageTrouble
            {...troubleWith(failure)}
            retrying={!!state?.loading}
            // Reload tries the address that failed again, not the page behind it.
            onRetry={() => void commands.browserNav(tab.id, "Reload")}
          />
        ) : null}
      </div>
    </div>
  );
}

/** What the pane says about an address that didn't open. */
function troubleWith(failure: BrowserFailure): { title: string; detail: string } {
  const host = hostOf(failure.url);
  switch (failure.reason) {
    case "NotRunning":
      return {
        title: `Nothing is running at ${host}`,
        detail: "No server answered there. If it's one you run, start it and try again.",
      };
    case "NoSuchHost":
      return {
        title: `Can't find ${host}`,
        detail: "No site goes by that name. Check the address for a typo.",
      };
    case "Offline":
      return { title: "This Mac is offline", detail: "Connect to the internet, then try again." };
    case "TimedOut":
      return {
        title: `${host} took too long to answer`,
        detail: "The server may be busy or down.",
      };
    case "Other":
      return { title: `Couldn't open ${host}`, detail: failure.message };
  }
}

function PageTrouble({
  title,
  detail,
  retrying,
  onRetry,
}: {
  title: string;
  detail: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <span className="text-status-amber">
        <WarningIcon size={18} />
      </span>
      <div className="text-base font-semibold text-fg-bright">{title}</div>
      {detail && <div className="max-w-[420px] text-sm leading-[1.5] text-fg-3">{detail}</div>}
      <Button size="sm" className="mt-1" disabled={retrying} onClick={onRetry}>
        <RefreshIcon size={10} />
        {retrying ? "Trying again…" : "Try again"}
      </Button>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url || "the page";
  }
}
