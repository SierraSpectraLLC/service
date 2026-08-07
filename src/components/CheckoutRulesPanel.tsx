"use client";

import { useState, useTransition } from "react";
import { addCheckoutRule, updateCheckoutRule, deleteCheckoutRule } from "@/app/actions";
import { MODULE_KINDS } from "@/lib/stages";

type Rule = { id: number; kind: string; modelMatch: string; title: string; criteria: string; sortOrder: number };

const KINDS = [...MODULE_KINDS, "Full system"];

export default function CheckoutRulesPanel({ rules }: { rules: Rule[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const setInput = (k: string, v: string) => setInputs((s) => ({ ...s, [k]: v }));

  const addRule = (kind: string) => {
    const title = (inputs["title-" + kind] || "").trim();
    if (!title) return;
    setError("");
    startTransition(async () => {
      const res = await addCheckoutRule({
        kind,
        modelMatch: (inputs["model-" + kind] || "").trim(),
        title,
        criteria: (inputs["crit-" + kind] || "").trim(),
      });
      if (res?.error) setError(res.error);
      else {
        setInput("title-" + kind, "");
        setInput("model-" + kind, "");
        setInput("crit-" + kind, "");
      }
    });
  };

  const startEdit = (r: Rule) => {
    setEditing(r.id);
    setInput("e-title-" + r.id, r.title);
    setInput("e-model-" + r.id, r.modelMatch);
    setInput("e-crit-" + r.id, r.criteria);
  };

  const saveEdit = (r: Rule) => {
    setError("");
    startTransition(async () => {
      const res = await updateCheckoutRule(r.id, {
        title: (inputs["e-title-" + r.id] || "").trim(),
        modelMatch: (inputs["e-model-" + r.id] || "").trim(),
        criteria: (inputs["e-crit-" + r.id] || "").trim(),
      });
      if (res?.error) setError(res.error);
      else setEditing(null);
    });
  };

  return (
    <div className="card">
      <div className="card-title" style={{ marginBottom: 4 }}>Checkout tests</div>
      <div className="mut" style={{ fontSize: 12, marginBottom: 12 }}>
        These tests are created automatically - under a Checkout header in the Tasks panel - when an
        asset of the matching type is added or installed on a system. Full system tests are created
        with each new system. A model filter (e.g. &quot;LC-40&quot;) narrows a test to matching models;
        when any filtered tests match an asset, they replace the general tests for that type.
      </div>
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginBottom: 8 }}>{error}</div>}

      {KINDS.map((kind) => {
        const group = rules.filter((r) => r.kind === kind);
        const open = expanded === kind;
        return (
          <div key={kind} style={{ border: "1px solid var(--line)", borderRadius: 10, marginBottom: 8, overflow: "hidden" }}>
            <div className="row-hover" onClick={() => setExpanded(open ? null : kind)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px" }}>
              <span style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>{kind}</span>
              <span className="mut" style={{ fontSize: 12 }}>
                {group.length ? `${group.length} test${group.length === 1 ? "" : "s"}` : "no tests"}
              </span>
              <span className="mut" style={{ fontSize: 12 }}>{open ? "▾" : "▸"}</span>
            </div>

            {open && (
              <div style={{ borderTop: "1px solid var(--line)", padding: 12, background: "#FAFBFD" }}>
                {group.map((r) => (
                  <div key={r.id} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "8px 10px", marginBottom: 8, background: "#fff" }}>
                    {editing === r.id ? (
                      <div className="dash-form">
                        <label>Test name</label>
                        <input value={inputs["e-title-" + r.id] || ""} onChange={(e) => setInput("e-title-" + r.id, e.target.value)} style={{ marginBottom: 6 }} />
                        <label>Pass criteria (optional)</label>
                        <input value={inputs["e-crit-" + r.id] || ""} onChange={(e) => setInput("e-crit-" + r.id, e.target.value)} style={{ marginBottom: 6 }} />
                        <label>Model filter (optional)</label>
                        <input value={inputs["e-model-" + r.id] || ""} onChange={(e) => setInput("e-model-" + r.id, e.target.value)}
                          placeholder="e.g. LC-40" style={{ marginBottom: 8 }} />
                        <div style={{ display: "flex", gap: 8 }}>
                          <button className="btn sm accent" onClick={() => saveEdit(r)} disabled={pending || !(inputs["e-title-" + r.id] || "").trim()}>Save</button>
                          <button className="btn sm" onClick={() => setEditing(null)} disabled={pending}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 700 }}>{r.title}</span>
                          {r.modelMatch && (
                            <span style={{ fontSize: 11, fontWeight: 700, color: "#6B4FA0", background: "#F0EBFA", borderRadius: 999, padding: "1px 8px" }}>
                              {r.modelMatch} only
                            </span>
                          )}
                          <span style={{ flex: 1 }} />
                          <button className="btn link" style={{ fontSize: 11 }} disabled={pending} onClick={() => startEdit(r)}>edit</button>
                          <button className="btn link" style={{ color: "#A32D2D", fontSize: 11 }} disabled={pending}
                            onClick={() => { if (window.confirm(`Remove "${r.title}"? Tests already generated on systems stay.`)) startTransition(() => deleteCheckoutRule(r.id)); }}>
                            remove
                          </button>
                        </div>
                        {r.criteria && <div className="mut" style={{ fontSize: 12, marginTop: 2 }}>{r.criteria}</div>}
                      </>
                    )}
                  </div>
                ))}

                <div className="dash-form">
                  <label>New test name</label>
                  <input value={inputs["title-" + kind] || ""} onChange={(e) => setInput("title-" + kind, e.target.value)}
                    placeholder="e.g. Flow Check" style={{ marginBottom: 6 }} />
                  <label>Pass criteria (optional)</label>
                  <input value={inputs["crit-" + kind] || ""} onChange={(e) => setInput("crit-" + kind, e.target.value)}
                    placeholder="e.g. Pass/Fail +/- 10%" style={{ marginBottom: 6 }} />
                  <label>Model filter (optional)</label>
                  <input value={inputs["model-" + kind] || ""} onChange={(e) => setInput("model-" + kind, e.target.value)}
                    placeholder="Leave blank to apply to all models" style={{ marginBottom: 8 }} />
                  <button className="btn sm accent" onClick={() => addRule(kind)} disabled={pending || !(inputs["title-" + kind] || "").trim()}>
                    Add test
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
