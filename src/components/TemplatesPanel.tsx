"use client";

import { useState, useTransition } from "react";
import {
  createTemplate, renameTemplate, deleteTemplate,
  addTemplateTask, deleteTemplateTask, addTemplateItem, deleteTemplateItem,
} from "@/app/actions";

type Item = { id: number; text: string };
type TTask = { id: number; title: string; body: string; items: Item[] };
type Template = { id: number; name: string; tasks: TTask[] };

export default function TemplatesPanel({ templates }: { templates: Template[] }) {
  const [expanded, setExpanded] = useState<number | null>(templates.length === 1 ? templates[0].id : null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const setInput = (k: string, v: string) => setInputs((s) => ({ ...s, [k]: v }));

  const submitNew = () => {
    if (!newName.trim()) return;
    setError("");
    startTransition(async () => {
      const res = await createTemplate(newName);
      if (res?.error) setError(res.error);
      else { setNewName(""); if (res.id) setExpanded(res.id); }
    });
  };

  const doRename = (t: Template) => {
    const next = window.prompt(`Rename template "${t.name}" to:`, t.name);
    if (!next || next.trim() === t.name) return;
    startTransition(async () => {
      const res = await renameTemplate(t.id, next);
      if (res?.error) setError(res.error);
    });
  };

  const addTask = (t: Template) => {
    const title = (inputs["task-" + t.id] || "").trim();
    if (!title) return;
    startTransition(() => addTemplateTask(t.id, { title, body: (inputs["body-" + t.id] || "").trim() }));
    setInput("task-" + t.id, "");
    setInput("body-" + t.id, "");
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
        <div className="card-title">SOP templates</div>
      </div>
      <div className="mut" style={{ fontSize: 12, marginBottom: 12 }}>
        A template bundles tasks and checklists you apply to a system in one tap - from the Tasks panel on
        any instrument, or when creating a new instrument. Applying copies the tasks; editing a template
        never touches systems it was already applied to.
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        <input value={newName} onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submitNew(); }}
          placeholder='New template name, e.g. "GC/MS refurb SOP"' style={{ flex: 1, fontSize: 13 }} />
        <button className="btn sm accent" onClick={submitNew} disabled={pending || !newName.trim()}>Create</button>
      </div>
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginBottom: 8 }}>{error}</div>}

      {templates.length === 0 && <div className="mut" style={{ fontSize: 13 }}>No templates yet.</div>}
      {templates.map((t) => {
        const open = expanded === t.id;
        return (
          <div key={t.id} style={{ border: "1px solid var(--line)", borderRadius: 10, marginBottom: 8, overflow: "hidden" }}>
            <div className="row-hover" onClick={() => setExpanded(open ? null : t.id)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px" }}>
              <span style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>{t.name}</span>
              <span className="mut" style={{ fontSize: 12 }}>
                {t.tasks.length} task{t.tasks.length === 1 ? "" : "s"} · {t.tasks.reduce((n, x) => n + x.items.length, 0)} items
              </span>
              <span className="mut" style={{ fontSize: 12 }}>{open ? "▾" : "▸"}</span>
            </div>

            {open && (
              <div style={{ borderTop: "1px solid var(--line)", padding: 12, background: "#FAFBFD" }}>
                {t.tasks.map((tt) => (
                  <div key={tt.id} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "8px 10px", marginBottom: 8, background: "#fff" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>{tt.title}</span>
                      <button className="btn link" style={{ color: "#A32D2D", fontSize: 11 }} disabled={pending}
                        onClick={() => { if (window.confirm(`Remove task "${tt.title}" from this template?`)) startTransition(() => deleteTemplateTask(tt.id)); }}>
                        remove
                      </button>
                    </div>
                    {tt.body && <div className="mut" style={{ fontSize: 12, marginTop: 2 }}>{tt.body}</div>}
                    <div style={{ marginTop: 6 }}>
                      {tt.items.map((i) => (
                        <div key={i.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: "2px 0" }}>
                          <span className="mut">☐</span>
                          <span style={{ flex: 1 }}>{i.text}</span>
                          <button className="btn link" style={{ color: "#A32D2D", padding: "0 4px" }} disabled={pending}
                            onClick={() => startTransition(() => deleteTemplateItem(i.id))}>×</button>
                        </div>
                      ))}
                      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                        <input value={inputs["item-" + tt.id] || ""}
                          onChange={(e) => setInput("item-" + tt.id, e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") { startTransition(() => addTemplateItem(tt.id, inputs["item-" + tt.id] || "")); setInput("item-" + tt.id, ""); } }}
                          placeholder="Add checklist item..." style={{ flex: 1, fontSize: 12, padding: "5px 9px" }} />
                        <button className="btn sm" disabled={pending}
                          onClick={() => { startTransition(() => addTemplateItem(tt.id, inputs["item-" + tt.id] || "")); setInput("item-" + tt.id, ""); }}>Add</button>
                      </div>
                    </div>
                  </div>
                ))}

                <div className="dash-form" style={{ marginBottom: 8 }}>
                  <label>New task title</label>
                  <input value={inputs["task-" + t.id] || ""} onChange={(e) => setInput("task-" + t.id, e.target.value)}
                    placeholder="e.g. Source cleaning" style={{ marginBottom: 6 }} />
                  <label>Body (optional)</label>
                  <input value={inputs["body-" + t.id] || ""} onChange={(e) => setInput("body-" + t.id, e.target.value)}
                    placeholder="What done means" style={{ marginBottom: 8 }} />
                  <button className="btn sm accent" onClick={() => addTask(t)} disabled={pending || !(inputs["task-" + t.id] || "").trim()}>
                    Add task
                  </button>
                </div>

                <div style={{ display: "flex", gap: 10 }}>
                  <button className="btn link" onClick={() => doRename(t)} disabled={pending}>rename template</button>
                  <button className="btn link" style={{ marginLeft: "auto", color: "#A32D2D", fontWeight: 700, fontSize: 12 }} disabled={pending}
                    onClick={() => { if (window.confirm(`Delete template "${t.name}"? Systems it was applied to keep their tasks.`)) startTransition(() => deleteTemplate(t.id)); }}>
                    Delete template
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
