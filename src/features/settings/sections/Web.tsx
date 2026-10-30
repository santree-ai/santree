/** Settings → Web: bring your sign-ins over from another browser.
 *
 *  Web tabs keep their own cookies, so a page opens signed out until you sign in
 *  there once — or import the cookies you already have in Chrome, Arc, Firefox and
 *  the rest. You pick the browser and the sites; santree copies only those, into
 *  the Web tabs' own store. A Chromium browser locks its cookies with a key in the
 *  login Keychain, so the first import from one makes macOS ask you to allow it. */
import { useEffect, useMemo, useState } from "react";

import type { CookieSource } from "../../../bindings";
import { GlobeIcon } from "../../../components/icons";
import { Button, ChevronSelect, EmptyState, Spinner } from "../../../components/primitives";
import {
  useBrowserSupported,
  useCookieSites,
  useCookieSources,
  useImportCookies,
} from "../../../lib/queries";
import { toast } from "../../../state/toast";
import { Heading, SELECT_CLASS } from "../widgets";

function sourceLabel(source: CookieSource): string {
  return source.profile ? `${source.browser} — ${source.profile}` : source.browser;
}

export function WebSection() {
  const supported = useBrowserSupported().data;
  const { data: sources } = useCookieSources();
  const [source, setSource] = useState<string | null>(null);
  // Default to the first browser found, and never leave a removed one selected.
  useEffect(() => {
    if (!sources) return;
    setSource((s) => (s && sources.some((x) => x.id === s) ? s : (sources[0]?.id ?? null)));
  }, [sources]);

  const picked = sources?.find((s) => s.id === source) ?? null;
  const { data: sites, isFetching } = useCookieSites(source);
  // A different browser is a different set of sites, so picking one starts its
  // selection empty (`pick`, the one place the source changes by hand).
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const pick = (id: string) => {
    setSource(id);
    setChosen(new Set());
  };

  const importing = useImportCookies();
  const allSites = useMemo(() => sites?.map((s) => s.site) ?? [], [sites]);
  const allChosen = allSites.length > 0 && chosen.size === allSites.length;

  if (supported === false) {
    return (
      <>
        <Heading
          title="Web"
          subtitle="Bring your sign-ins over from another browser on this Mac."
        />
        <EmptyState
          icon={<GlobeIcon size={18} />}
          title="Web tabs need macOS 14"
          subtitle="This Mac's WebKit can't give a page its own cookie store, so there's nowhere to import into."
        />
      </>
    );
  }

  const toggle = (site: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(site)) next.delete(site);
      else next.add(site);
      return next;
    });

  const runImport = () => {
    if (!source || chosen.size === 0) return;
    importing.mutate(
      { source, sites: [...chosen] },
      {
        onSuccess: ({ cookies, skipped }) => {
          const skip = skipped > 0 ? `, ${skipped} skipped` : "";
          toast.success(`Imported ${cookies} cookie${cookies === 1 ? "" : "s"}${skip}`);
          setChosen(new Set());
        },
      },
    );
  };

  return (
    <>
      <Heading
        title="Web"
        subtitle="Bring your sign-ins over from another browser on this Mac. Pick a browser and the sites, and santree copies those cookies into the Web tabs' own store."
      />

      {sources && sources.length === 0 ? (
        <EmptyState
          icon={<GlobeIcon size={18} />}
          title="No other browser found"
          subtitle="santree looks for Chrome, Arc, Brave, Edge, Vivaldi, Opera, Chromium and Firefox. Sign in on a site in a Web tab instead."
        />
      ) : (
        <div className="rounded-xl border border-line-2 bg-raised">
          <div className="flex items-center gap-4 border-b border-line px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="mb-[3px] text-base font-medium text-fg-3">Import from</div>
              <div className="text-sm text-muted-3">
                {picked?.keychain
                  ? "macOS will ask to let santree read this browser's cookie key."
                  : "Its cookies are stored in plain text — no password needed."}
              </div>
            </div>
            <ChevronSelect
              value={source ?? ""}
              onChange={pick}
              className={SELECT_CLASS}
              wrapperClassName="w-[220px] flex-none"
              aria-label="Browser to import from"
            >
              {sources?.map((s) => (
                <option key={s.id} value={s.id}>
                  {sourceLabel(s)}
                </option>
              ))}
            </ChevronSelect>
          </div>

          <div className="flex items-center justify-between px-4 py-2.5">
            <div className="text-sm text-muted-3">
              {isFetching
                ? "Reading sites…"
                : `${allSites.length} site${allSites.length === 1 ? "" : "s"}`}
            </div>
            {allSites.length > 0 && (
              <button
                type="button"
                className="text-sm text-accent hover:underline"
                onClick={() => setChosen(allChosen ? new Set() : new Set(allSites))}
              >
                {allChosen ? "Clear all" : "Select all"}
              </button>
            )}
          </div>

          <div className="max-h-[320px] overflow-y-auto border-t border-line px-2 py-1.5">
            {isFetching && allSites.length === 0 ? (
              <div className="flex items-center justify-center py-6">
                <Spinner size={14} />
              </div>
            ) : allSites.length === 0 ? (
              <div className="px-2 py-6 text-center text-sm text-muted-3">
                This browser has no cookies to import.
              </div>
            ) : (
              sites?.map((s) => (
                <label
                  key={s.site}
                  className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-fg-3 hover:bg-hover"
                >
                  <input
                    type="checkbox"
                    checked={chosen.has(s.site)}
                    onChange={() => toggle(s.site)}
                    className="h-3.5 w-3.5 cursor-pointer accent-[var(--accent)]"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{s.site}</span>
                  <span className="flex-none text-xs text-muted-4">{s.cookies}</span>
                </label>
              ))
            )}
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-line px-4 py-3">
            {chosen.size > 0 && (
              <span className="text-sm text-muted-3">
                {chosen.size} site{chosen.size === 1 ? "" : "s"} selected
              </span>
            )}
            <Button
              variant="primary"
              disabled={chosen.size === 0 || importing.isPending}
              onClick={runImport}
            >
              {importing.isPending ? (
                <Spinner size={12} color="var(--on-accent)" />
              ) : (
                "Import cookies"
              )}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
