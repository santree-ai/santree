/** The Triage tab: untriaged queue · AI investigation thread · composer. */
import { useNavigate } from "@tanstack/react-router";
import type { CSSProperties, KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";

import type { TriageMessage } from "../../bindings";
import { ViewChrome } from "../../components/chrome/ViewChrome";
import { Spinner } from "../../components/primitives";
import { SidebarFooter } from "../../components/SidebarFooter";
import { useTriageAsk, useTriageThread, useTriageTickets } from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { priorityColor } from "../../theme/colors";

const SUGGESTIONS = [
  "Find related code",
  "Estimate complexity",
  "Draft a fix plan",
  "Suggest an owner",
];
const THINKING_MS = 800;

export function TriageView() {
  const { triageEnabled } = useApp();
  const navigate = useNavigate();
  const { data: tickets = [] } = useTriageTickets();

  const [activeId, setActiveId] = useState("AK-211");
  const [extras, setExtras] = useState<Record<string, TriageMessage[]>>({});
  const [thinking, setThinking] = useState(false);
  const ask = useTriageAsk();

  const { data: seed = [] } = useTriageThread(activeId);
  const messages = [...seed, ...(extras[activeId] ?? [])];

  const threadEnd = useRef<HTMLDivElement>(null);
  // Redirect away if triage gets disabled while open.
  useEffect(() => {
    if (!triageEnabled) navigate({ to: "/" });
  }, [triageEnabled, navigate]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run to scroll when the thread grows or thinking toggles.
  useEffect(() => {
    threadEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, thinking]);

  const ticket = tickets.find((t) => t.id === activeId) ?? tickets[0];

  function submit(question: string) {
    const q = question.trim();
    if (!q || thinking) return;
    const ticketId = activeId;
    setExtras((prev) => ({
      ...prev,
      [ticketId]: [...(prev[ticketId] ?? []), { role: "User", text: q, refs: [] }],
    }));
    setThinking(true);
    ask.mutate(q, {
      onSuccess: (answer) => {
        // Brief delay so the "searching codebase…" state is visible.
        window.setTimeout(() => {
          setExtras((prev) => ({ ...prev, [ticketId]: [...(prev[ticketId] ?? []), answer] }));
          setThinking(false);
        }, THINKING_MS);
      },
      onError: () => setThinking(false),
    });
  }

  function onComposerKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      submit(e.currentTarget.value);
      e.currentTarget.value = "";
    }
  }

  if (!ticket) return null;

  return (
    <ViewChrome
      sidebarWidth={312}
      sidebar={
        <div className="flex w-[312px] flex-none flex-col border-r border-line bg-panel">
          <div className="flex h-10 flex-none items-center gap-2 border-b border-hairline px-[15px]">
            <span className="text-[12px] font-semibold text-fg-2">Triage queue</span>
            <span className="rounded-[5px] border border-status-red/30 bg-status-red/10 px-1.5 py-px font-mono text-[10.5px] text-status-red">
              {tickets.length}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {tickets.map((t) => {
              const active = t.id === activeId;
              const style: CSSProperties = active
                ? {
                    border: "1px solid color-mix(in srgb, var(--accent) 33%, transparent)",
                    background: "color-mix(in srgb, var(--accent) 5%, transparent)",
                  }
                : { border: "1px solid transparent", background: "transparent" };
              return (
                <button
                  type="button"
                  key={t.id}
                  onClick={() => setActiveId(t.id)}
                  className="mb-[5px] w-full cursor-pointer rounded-[9px] px-[11px] py-[11px] text-left transition-colors hover:bg-[#15161a]"
                  style={style}
                >
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="font-mono text-[10.5px] text-muted-2">{t.id}</span>
                    <span
                      className="rounded px-1.5 py-px font-mono text-[9px] font-semibold tracking-[.04em] uppercase"
                      style={{
                        color: priorityColor[t.priority],
                        background: `${priorityColor[t.priority]}15`,
                        border: `1px solid ${priorityColor[t.priority]}40`,
                      }}
                    >
                      {t.priority}
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-muted-4">{t.age}</span>
                  </div>
                  <div className="text-[12.5px] leading-[1.35] text-fg-3">{t.title}</div>
                  <div className="mt-1.5 text-[10.5px] text-muted-4">{t.meta}</div>
                </button>
              );
            })}
          </div>
          <SidebarFooter />
        </div>
      }
    >
      <div className="flex min-w-0 flex-1 flex-col bg-app">
        <div className="flex-none border-b border-hairline px-5 pt-4 pb-3.5">
          <div className="mb-2 flex items-center gap-2.5">
            <span className="font-mono text-[11.5px] text-muted-2">{ticket.id}</span>
            <span
              className="rounded px-[7px] py-[1.5px] font-mono text-[9px] font-semibold tracking-[.04em] uppercase"
              style={{
                color: priorityColor[ticket.priority],
                background: `${priorityColor[ticket.priority]}15`,
                border: `1px solid ${priorityColor[ticket.priority]}40`,
              }}
            >
              {ticket.priority}
            </span>
            <button
              type="button"
              onClick={() => navigate({ to: "/" })}
              className="ml-auto cursor-pointer rounded-md border-none px-3 py-1.5 text-[11.5px] font-medium text-[#06231a] hover:brightness-110"
              style={{ background: "var(--accent)" }}
            >
              Promote to Issues →
            </button>
          </div>
          <div className="mb-1.5 text-[17px] leading-[1.3] font-semibold text-fg-bright">
            {ticket.title}
          </div>
          <div className="text-[11.5px] text-muted-3">{ticket.meta}</div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-[18px]">
          {messages.map((m, i) => (
            <TriageBubble key={`${m.role}-${i}`} message={m} />
          ))}
          {thinking && (
            <div className="mb-[18px] flex items-center gap-2.5">
              <div
                className="flex h-6 w-6 flex-none items-center justify-center rounded-[7px]"
                style={{
                  background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--accent) 33%, transparent)",
                }}
              >
                <Spinner size={11} />
              </div>
              <span className="font-mono text-[11.5px] text-muted-2">searching codebase…</span>
            </div>
          )}
          <div ref={threadEnd} />
        </div>

        <div className="flex-none border-t border-hairline bg-panel px-5 pt-3 pb-4">
          <div className="mb-[11px] flex flex-wrap gap-[7px]">
            {SUGGESTIONS.map((s) => (
              <button
                type="button"
                key={s}
                onClick={() => submit(s)}
                className="cursor-pointer rounded-2xl border border-line-3 bg-input px-[11px] py-1.5 text-[11.5px] text-muted hover:border-line-strong hover:text-fg"
              >
                {s}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2.5 rounded-[10px] border border-line-3 bg-input px-3.5 py-2.5">
            <span className="text-[13px]" style={{ color: "var(--accent)" }}>
              ✦
            </span>
            <input
              type="text"
              onKeyDown={onComposerKey}
              placeholder="Ask anything about this ticket — santree investigates the codebase…"
              className="flex-1 border-none bg-transparent text-[12.5px] text-fg-3"
            />
            <span className="font-mono text-[10px] text-muted-5">↵</span>
          </div>
        </div>
      </div>
    </ViewChrome>
  );
}

function TriageBubble({ message }: { message: TriageMessage }) {
  if (message.role === "User") {
    return (
      <div className="mb-4 flex justify-end">
        <div className="max-w-[78%] rounded-[12px_12px_3px_12px] border border-[#28384d] bg-[#1d2735] px-3.5 py-2.5 text-[12.5px] leading-[1.5] text-[#dbe6f2]">
          {message.text}
        </div>
      </div>
    );
  }
  return (
    <div className="mb-[18px] flex gap-2.5">
      <div
        className="mt-px flex h-6 w-6 flex-none items-center justify-center rounded-[7px]"
        style={{
          background: "color-mix(in srgb, var(--accent) 12%, transparent)",
          border: "1px solid color-mix(in srgb, var(--accent) 33%, transparent)",
        }}
      >
        <span className="text-[11px]" style={{ color: "var(--accent)" }}>
          ✦
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] leading-[1.6] text-fg-2">{message.text}</div>
        {message.refs.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {message.refs.map((ref) => (
              <span
                key={ref.path}
                className="flex cursor-pointer items-center gap-1.5 rounded-md border border-[#1e3329] bg-[#101714] px-2 py-[3px] font-mono text-[10.5px] text-[#9ee6c9] hover:border-[#2f6f4f]"
              >
                <span className="text-[#5b8d7a]">⎘</span>
                {ref.path}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
