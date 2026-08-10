/** Generic presentational widgets shared across the Settings sections. */

import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useId,
} from "react";

import { Button, ChevronSelect, Toggle } from "../../components/primitives";
import { useClaudeModels, useSetSetting, useSetting } from "../../lib/queries";

/** A section heading: a bold title over a muted one-line subtitle. */
export function Heading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <>
      <div className="mb-1 text-[17px] font-semibold text-fg-bright">{title}</div>
      <div className="mb-[22px] text-[12.5px] text-muted-3">{subtitle}</div>
    </>
  );
}

/** A labelled field inside a settings card, divided from the previous one.
 *  The caption is wired to the control(s) below via `aria-labelledby` (cloned
 *  onto every element child) so the visible text doubles as the control's
 *  programmatic name — {@link ChevronSelect}, {@link ComboBox}, and
 *  {@link OverrideSelect} all forward it down to their native element. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const labelId = useId();
  return (
    <div className="border-t border-line py-3.5 first:border-t-0">
      <div id={labelId} className="mb-[3px] text-[12.5px] font-medium text-fg-3">
        {label}
      </div>
      {hint && <div className="mb-2.5 text-[11.5px] text-muted-3">{hint}</div>}
      {Children.map(children, (child) =>
        isValidElement(child)
          ? cloneElement(child as ReactElement<{ "aria-labelledby"?: string }>, {
              "aria-labelledby": labelId,
            })
          : child,
      )}
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
  const labelId = useId();
  return (
    <div className="flex items-center gap-[13px] border-t border-line py-3.5 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div id={labelId} className="text-[12.5px] font-medium text-fg-3">
          {label}
        </div>
        {hint && <div className="mt-[3px] text-[11.5px] leading-[1.5] text-muted-3">{hint}</div>}
      </div>
      <Toggle on={on} onClick={() => onChange(!on)} disabled={disabled} ariaLabelledBy={labelId} />
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

/**
 * The model picker for a **headless** AI helper — one `claude -p` call with no
 * effort or start mode (the commit message, the PR body, the review brief).
 *
 * Its own widget rather than an {@link Field} each caller rebuilds, because all
 * three share the same shape: a per-scope value where empty means "inherit", and
 * a default that has to be *shown* (never an empty select, which reads as "no
 * model"). Interactive agent actions use `ActionConfig` instead — they have
 * effort and permission mode to configure too.
 */
export function HeadlessModelField({
  label,
  hint,
  settingKey,
  defaultModel,
  forRepo,
}: {
  label: string;
  /** Shown at app scope only — a repo override doesn't re-explain the helper. */
  hint?: string;
  settingKey: string;
  /** Mirrors the backend's default, so the picker shows what will actually run. */
  defaultModel: string;
  forRepo?: string;
}) {
  const inherits = forRepo !== undefined;
  const scope = inherits ? `repo:${forRepo}` : "app";
  const models = useClaudeModels().data ?? [];
  const appModel = useSetting("app", settingKey).data;
  const scopeModel = useSetting(scope, settingKey).data;
  const { mutate: setSetting } = useSetSetting();
  const value = inherits ? (scopeModel ?? "") : (scopeModel ?? defaultModel);
  // A model the CLI no longer lists (renamed, or set on another machine) must
  // still appear, or opening this picker would silently rewrite the setting.
  const options = value && !models.includes(value) ? [value, ...models] : models;

  return (
    <Field label={label} hint={inherits ? undefined : hint}>
      <ChevronSelect
        value={value}
        onChange={(v) => setSetting({ scope, key: settingKey, value: v || null })}
        className={SELECT_CLASS}
      >
        {inherits && <option value="">{`Use app default (${appModel || defaultModel})`}</option>}
        {options.map((m) => (
          <option key={m} value={m} className="bg-input">
            {m}
          </option>
        ))}
      </ChevronSelect>
    </Field>
  );
}

/** A `<select>` whose empty option inherits the app default, with a Reset. */
export function OverrideSelect({
  value,
  onChange,
  defaultLabel,
  children,
  "aria-labelledby": ariaLabelledBy,
}: {
  value: string;
  onChange: (v: string | null) => void;
  defaultLabel: string;
  children: ReactNode;
  "aria-labelledby"?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <ChevronSelect
        value={value}
        onChange={(v) => onChange(v || null)}
        className={SELECT_CLASS}
        wrapperClassName="flex-1"
        aria-labelledby={ariaLabelledBy}
      >
        <option value="">{defaultLabel}</option>
        {children}
      </ChevronSelect>
      <Button onClick={() => onChange(null)} disabled={!value}>
        Reset
      </Button>
    </div>
  );
}
