"use client";

import { useEffect, useState } from "react";
import Dialog from "@/components/ui/Dialog";

/**
 * window.confirm(), minus the ways window.confirm() fails. The decisive one
 * (learned in CustodyPanel, which shipped an armed two-click button instead):
 * browsers offer to suppress repeat dialogs from a page, and once that box is
 * ticked every native confirm() returns false - so a native dialog makes the
 * button silently do nothing. This is our own dialog, immune to that; it can
 * also say what is about to happen, and its action button names the act.
 *
 *   if (!(await confirmDialog({ title: "Decommission #33?", body: "...",
 *     action: "Decommission", tone: "bad" }))) return;
 *
 * One-line change per call site. The promise resolves false on Cancel,
 * Escape, or the scrim. ConfirmHost is mounted once in layout.tsx; the
 * module-level function talks to it directly, so call sites need no hook
 * and no provider threading.
 */
export type ConfirmOptions = {
  title: string;
  /** The muted line under the title: what this acts on ("LC-12 · LabZen"). */
  context?: React.ReactNode;
  /** What happens - a sentence, or a node with a consequence list. */
  body?: React.ReactNode;
  /** The verb on the button: "Remove", "Decommission", "Delete 3 files". */
  action: string;
  tone?: "bad" | "primary";
  cancel?: string;
};

export type InputOptions = ConfirmOptions & {
  /** The field's label. Defaults to "Name". */
  label?: string;
  initial?: string;
  placeholder?: string;
  hint?: string;
  /** Resolve "" as a valid answer - for genuinely optional input. */
  allowEmpty?: boolean;
};

export type ChoiceOptions = InputOptions & {
  /** The picker's label, e.g. "Blocked with". */
  choiceLabel: string;
  choices: { value: string; label: string; note?: string }[];
  /** Which one starts selected. Falls back to the first. */
  choiceInitial?: string;
  choiceHint?: string;
};

/** What the dialog's text field looks like and when its answer counts. */
type InputSpec = {
  label: string;
  placeholder?: string;
  hint?: string;
  initial: string;
  minLen: number;
};

/** The optional picker beside the field. See choiceDialog. */
type ChoiceSpec = {
  label: string;
  hint?: string;
  initial: string;
  options: { value: string; label: string; note?: string }[];
};

/** What choiceDialog resolves: the field, and which option was picked. */
export type ChoiceAnswer = { value: string; choice: string };

type Pending = {
  opts: ConfirmOptions;
  /** Set when the dialog also collects a string: confirmReason or inputDialog. */
  input?: InputSpec;
  /** Set when it collects a choice alongside the string. */
  choice?: ChoiceSpec;
  resolve: (answer: boolean | string | ChoiceAnswer | null) => void;
};

let current: Pending | null = null;
let notify: (() => void) | null = null;

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  // A second ask while one is up would stack invisibly; answer the first
  // with false and show the newer one, which is what the user last did.
  current?.resolve(false);
  return new Promise<boolean>((resolve) => {
    current = { opts, resolve: resolve as Pending["resolve"] };
    notify?.();
  });
}

/**
 * The 21 CFR Part 11 flavour: confirm AND collect the reason in one dialog,
 * for actions the audit trail records. Resolves the trimmed reason, or null
 * on Cancel/Escape/scrim. The server enforces the reason too - this is the
 * front door, not the lock.
 */
export function confirmReason(opts: ConfirmOptions): Promise<string | null> {
  current?.resolve(null);
  return new Promise<string | null>((resolve) => {
    current = {
      opts,
      input: {
        label: "Reason", placeholder: "Recorded in the audit trail",
        hint: "A few words, kept with the record of this action.",
        initial: "", minLen: 3,
      },
      resolve: resolve as Pending["resolve"],
    };
    notify?.();
  });
}

/**
 * window.prompt's successor for plain input - a rename, a label, a
 * type-to-confirm. Resolves the trimmed value, or null on Cancel, Escape,
 * or the scrim. Unlike native prompt it survives the browser's "suppress
 * dialogs" checkbox, and its action button names the act.
 */
export function inputDialog(opts: InputOptions): Promise<string | null> {
  current?.resolve(null);
  return new Promise<string | null>((resolve) => {
    current = {
      opts,
      input: {
        label: opts.label ?? "Name", placeholder: opts.placeholder,
        hint: opts.hint, initial: opts.initial ?? "",
        minLen: opts.allowEmpty ? 0 : 1,
      },
      resolve: resolve as Pending["resolve"],
    };
    notify?.();
  });
}

/**
 * One field and one picker, answered together.
 *
 * For the case where a fact and its attribution are the same act - blocking a
 * system says both why and whose it is, and asking those in two dialogs would
 * let somebody answer the first and abandon the second, leaving a block with a
 * reason and no owner. Resolves { value, choice }, or null on Cancel, Escape
 * or the scrim.
 */
export function choiceDialog(opts: ChoiceOptions): Promise<ChoiceAnswer | null> {
  current?.resolve(null);
  return new Promise<ChoiceAnswer | null>((resolve) => {
    current = {
      opts,
      input: {
        label: opts.label ?? "Name", placeholder: opts.placeholder,
        hint: opts.hint, initial: opts.initial ?? "",
        minLen: opts.allowEmpty ? 0 : 1,
      },
      choice: {
        label: opts.choiceLabel, hint: opts.choiceHint,
        initial: opts.choiceInitial ?? opts.choices[0]?.value ?? "",
        options: opts.choices,
      },
      resolve: resolve as Pending["resolve"],
    };
    notify?.();
  });
}

export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState("");
  const [pick, setPick] = useState("");

  useEffect(() => {
    const load = () => {
      setPending(current);
      setValue(current?.input?.initial ?? "");
      setPick(current?.choice?.initial ?? "");
    };
    notify = load;
    // A call made before hydration finished still shows.
    if (current) load();
    return () => { notify = null; };
  }, []);

  if (!pending) return null;
  const { opts, input, choice } = pending;
  const settle = (answer: boolean | string | ChoiceAnswer | null) => {
    pending.resolve(answer);
    if (current === pending) current = null;
    setPending(null);
    setValue("");
    setPick("");
  };
  const cancelValue = input ? null : false;
  const ready = !input || value.trim().length >= input.minLen;
  const confirm = () => {
    if (!ready) return;
    settle(choice ? { value: value.trim(), choice: pick } : input ? value.trim() : true);
  };

  return (
    <Dialog open size="sm" title={opts.title} context={opts.context} onClose={() => settle(cancelValue)}
      footer={
        <>
          <span className="dialog-status" />
          <button type="button" className="btn" onClick={() => settle(cancelValue)}>
            {opts.cancel ?? "Cancel"}
          </button>
          <button type="button" autoFocus={!input} disabled={!ready}
            className={`btn ${opts.tone === "bad" ? "danger" : "primary"}`}
            onClick={confirm}>
            {opts.action}
          </button>
        </>
      }>
      {opts.body != null && <div className="t-body">{opts.body}</div>}
      {input && (
        <div className="field" style={{ marginTop: opts.body != null ? 10 : 0 }}>
          <label htmlFor="confirm-input">{input.label}</label>
          <input id="confirm-input" value={value} autoFocus maxLength={300}
            placeholder={input.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") confirm(); }} />
          {input.hint && <div className="field-hint">{input.hint}</div>}
        </div>
      )}
      {/* Under the field, not above it: the fact comes first and the
          attribution follows from it. It is a select rather than a row of
          radios because the default is nearly always right and the list can
          run to several parties on a shared bench. */}
      {choice && (
        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor="confirm-choice">{choice.label}</label>
          <select id="confirm-choice" value={pick} onChange={(e) => setPick(e.target.value)}>
            {choice.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}{o.note ? ` - ${o.note}` : ""}
              </option>
            ))}
          </select>
          {choice.hint && <div className="field-hint">{choice.hint}</div>}
        </div>
      )}
    </Dialog>
  );
}
