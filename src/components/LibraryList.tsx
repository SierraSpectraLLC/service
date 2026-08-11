"use client";

import { useState, useTransition } from "react";
import { promptReason } from "@/lib/reason";
import { deleteAttachment } from "@/app/actions";
import { fmtBytes } from "@/lib/storage";

type FileRow = { id: number; fileName: string; size: number; description: string; uploadedBy: string; when: string };

export default function LibraryList({ files, canEdit = true }: { files: FileRow[]; canEdit?: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  if (!files.length) {
    return <div className="mut" style={{ fontSize: 13 }}>Nothing filed yet. Add a file above, or save a packet here from the PDF studio.</div>;
  }
  return (
    <>
      {files.map((f) => (
        <div key={f.id} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "7px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
          <a href={`/api/files/${f.id}`} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 600, textDecoration: "none" }}>
            {f.fileName}
          </a>
          <span className="mut" style={{ fontSize: 12 }}>{fmtBytes(f.size)}</span>
          {f.description && <span className="mut" style={{ fontSize: 12 }}>{f.description}</span>}
          <span className="mut" style={{ fontSize: 11, marginLeft: "auto" }}>{f.uploadedBy} · {f.when}</span>
          {canEdit && (
            <button className="btn link" style={{ color: "#A32D2D", fontSize: 11 }} disabled={pending}
              onClick={() => {
                const why = promptReason(`Remove "${f.fileName}" from the library? The file is permanently deleted.`);
                if (!why) return;
                startTransition(async () => {
                  const res = await deleteAttachment(f.id, why);
                  setError(res?.error ?? "");
                });
              }}>remove</button>
          )}
        </div>
      ))}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{error}</div>}
    </>
  );
}
