/** Generic presentational widgets shared across the Settings sections. */

import type { ReactNode } from "react";

import type { ClaudeCommand } from "../../bindings";
import { ChevronSelect, Toggle } from "../../components/primitives";

/** A section heading: a bold title over a muted one-line subtitle. */
export function Heading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <>
      <div className="mb-1 text-[17px] font-semibold text-fg-bright">{title}</div>
      <div className="mb-[22px] text-[12.5px] text-muted-3">{subtitle}</div>
    </>
  );
}

/** A labelled field inside a settings card, divided from the previous one. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="border-t border-line py-3.5 first:border-t-0">
      <div className="mb-[3px] text-[12.5px] font-medium text-fg-3">{label}</div>
      {hint && <div className="mb-2.5 text-[11.5px] text-muted-3">{hint}</div>}
      {children}
    </div>
  );
}

/** A label + hint + iOS switch row inside a settings card. */
export function ToggleRow({
  label,
  hint,
  on,
  onChange,
  disabled,
}: {
  label: string;
  hint?: ReactNode;
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-[13px] border-t border-line py-3.5 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-fg-3">{label}</div>
        {hint && <div className="mt-[3px] text-[11.5px] leading-[1.5] text-muted-3">{hint}</div>}
      </div>
      <Toggle on={on} onClick={() => !disabled && onChange(!on)} />
    </div>
  );
}

/** Heading + body for one block inside a harness panel. */
export function Block({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="border-t border-line pt-5 first:border-t-0 first:pt-0">
      <div className="text-[13px] font-medium text-fg-2">{title}</div>
      {subtitle && <div className="mt-[3px] mb-3 text-[11.5px] text-muted-3">{subtitle}</div>}
      {!subtitle && <div className="mb-3" />}
      {children}
    </div>
  );
}

/** A single key/value row in the subscription table. */
export function KvRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex border-t border-line first:border-t-0">
      <div className="w-[110px] flex-none px-3 py-2 text-[11.5px] text-muted-3">{label}</div>
      <div className="break-all px-3 py-2 text-[11.5px] text-fg-3">{value}</div>
    </div>
  );
}

/** Shared classes for the settings dropdowns — used as the `<select>` className
 *  inside {@link ChevronSelect} (which adds the chevron + `appearance-none`). */
export const SELECT_CLASS =
  "w-full rounded-lg border border-line-3 bg-input py-2 pr-8 pl-[11px] font-mono text-[12px] text-fg-3";

/** A `<select>` whose empty option inherits the app default, with a Reset. */
export function OverrideSelect({
  value,
  onChange,
  defaultLabel,
  children,
}: {
  value: string;
  onChange: (v: string | null) => void;
  defaultLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <ChevronSelect
        value={value}
        onChange={(v) => onChange(v || null)}
        className={SELECT_CLASS}
        wrapperClassName="flex-1"
      >
        <option value="">{defaultLabel}</option>
        {children}
      </ChevronSelect>
      <button
        type="button"
        onClick={() => onChange(null)}
        disabled={!value}
        className="cursor-pointer rounded-md border border-line-3 bg-input px-3 py-2 text-[11.5px] text-muted hover:border-line-strong hover:text-fg-2 disabled:cursor-default disabled:opacity-50"
      >
        Reset
      </button>
    </div>
  );
}

/** `<option>`s for a Claude command picker, grouped by source. For the app
 * scope `repoCmds` is empty, so a single flat list is rendered. */
export function CommandOptions({
  globalCmds,
  repoCmds,
}: {
  globalCmds: ClaudeCommand[];
  repoCmds: ClaudeCommand[];
}) {
  const opt = (c: ClaudeCommand, k: string) => (
    <option key={k} value={c.name} className="bg-input">
      /{c.name}
    </option>
  );
  if (repoCmds.length === 0) return <>{globalCmds.map((c) => opt(c, c.name))}</>;
  return (
    <>
      <optgroup label="Repo commands">{repoCmds.map((c) => opt(c, `repo:${c.name}`))}</optgroup>
      <optgroup label="Global commands">
        {globalCmds.map((c) => opt(c, `global:${c.name}`))}
      </optgroup>
    </>
  );
}
