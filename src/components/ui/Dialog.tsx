"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * The one modal. Built on the .sheet rule (centred at every width), with the
 * three things every hand-rolled sheet in the app kept getting differently:
 * a head that stays put, a body that scrolls, and a foot that stays put.
 *
 * Keyboard contract (the Phase 2 gate, tested in tests/dialog.test.tsx):
 * focus moves into the dialog on open, Tab cycles inside it and nowhere
 * else, Escape closes it, and focus returns to whatever opened it. The page
 * behind stops scrolling while it is up.
 *
 * Steps: pass `steps` and the dialog grows a left step rail (desktop) or a
 * progress bar (phone). The body content is still the caller's - on a phone
 * the caller renders one step's fields at a time, keyed off `activeStep`,
 * with Back / Next living in `footer`.
 */
export type DialogStep = { key: string; label: string; done?: boolean; warn?: boolean };

/**
 * The live footer status every form dialog shares: a failed save's message
 * when there is one (loudest - the user just acted), otherwise the first
 * reason the form can't save yet, otherwise a muted line saying what Save
 * will do. Pair it with a Save button whose `disabled` mirrors `problem`,
 * so the sentence and the disabled state can never drift apart.
 */
export function DialogStatus({ error, problem, ok }: {
  error?: string;
  /** The first unmet requirement, e.g. "name the vendor". */
  problem?: string | null;
  /** What a valid save covers or does, e.g. "Covers 4 models". */
  ok?: React.ReactNode;
}) {
  if (error) return <span className="dialog-status err">{error}</span>;
  if (problem) return <span className="dialog-status err">Can&apos;t save yet - {problem}</span>;
  return <span className="dialog-status">{ok}</span>;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Dialog({ open, onClose, title, context, size = "md", steps, activeStep, onStepSelect, footer, children }: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  /** The muted line under the title: what this acts on ("Lab Zen · #58"). */
  context?: React.ReactNode;
  size?: "sm" | "md" | "lg";
  steps?: DialogStep[];
  activeStep?: string;
  onStepSelect?: (key: string) => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // Focus in on open, back out on close - and the body stops scrolling
  // underneath. All keyed on `open` so a dialog left mounted but closed
  // costs nothing.
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>("[autofocus]") ?? panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      // The trap: Tab wraps inside the panel in both directions. Visibility
      // by computed style, not offsetParent: the panel is position: fixed
      // (offsetParent semantics differ there), and jsdom has no layout at
      // all - computed style answers the same question in both worlds.
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
        const cs = getComputedStyle(el);
        return cs.display !== "none" && cs.visibility !== "hidden" && !el.closest("[hidden]");
      });
      if (items.length === 0) { e.preventDefault(); panel.focus(); return; }
      const current = document.activeElement as HTMLElement | null;
      const at = current ? items.indexOf(current) : -1;
      if (e.shiftKey && (at <= 0)) {
        e.preventDefault();
        items[items.length - 1].focus();
      } else if (!e.shiftKey && (at === items.length - 1 || at === -1)) {
        e.preventDefault();
        items[0].focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const stepIdx = steps?.findIndex((s) => s.key === activeStep) ?? -1;

  const body = steps ? (
    <div className="dialog-body steps">
      <nav className="dialog-stepnav" aria-label="Steps">
        {steps.map((s) => (
          <button key={s.key} type="button"
            className={[s.key === activeStep ? "active" : "", s.done ? "done" : "", s.warn ? "warn" : ""].filter(Boolean).join(" ")}
            aria-current={s.key === activeStep ? "step" : undefined}
            onClick={() => onStepSelect?.(s.key)}>
            <i aria-hidden="true">{s.done ? "✓" : s.warn ? "!" : ""}</i>
            {s.label}
          </button>
        ))}
      </nav>
      <div className="dialog-progress" aria-hidden="true">
        {steps.map((s, i) => (
          <span key={s.key} className={i < stepIdx || s.done ? "done" : s.key === activeStep ? "on" : ""} />
        ))}
      </div>
      <div className="dialog-stepbody">{children}</div>
    </div>
  ) : (
    <div className="dialog-body">{children}</div>
  );

  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <div ref={panelRef} className={`sheet dialog ${size}`} role="dialog" aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined} tabIndex={-1}>
        <div className="dialog-head">
          <div>
            <h2 className="dialog-title">{title}</h2>
            {context != null && <div className="dialog-context">{context}</div>}
          </div>
          <button type="button" className="dialog-x" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        {body}
        {footer != null && <div className="dialog-foot">{footer}</div>}
      </div>
    </>,
    document.body,
  );
}
