"use client";

import { useTransition } from "react";
import { promptReason } from "@/lib/reason";
import { deleteAttachment } from "@/app/actions";

type FileRow = { id: number; fileName: string; size: number; description: string; uploadedBy: string; when: string };

const fmtSize = (b: number) =>
  !b ? "-" : b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`;

export default function LibraryList({ files }: { files: FileRow[] }) {
  const [pending, startTransition] = useTransition();
  if (!files.length) {
    return <div className="mut" style={{ fontSize: 13 }}>Nothing filed yet. The PDF studio can save packets here.</div>;
  }
  return (
    <>
      {files.map((f) => (
        <div key={f.id} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "7px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
          <a href={`/api/files/${f.id}`} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 600, textDecoration: "none" }}>
            {f.fileName}
          </a>
          <span className="mut" style={{ fontSize: 12 }}>{fmtSize(f.size)}</span>
          {f.description && <span className="mut" style={{ fontSize: 12 }}>{f.description}</span>}
          <span className="mut" style={{ fontSize: 11, marginLeft: "auto" }}>{f.uploadedBy} · {f.when}</span>
          <button className="btn link" style={{ color: "#A32D2D", fontSize: 11 }} disabled={pending}
            onClick={() => {
              const why = promptReason(`Remove "${f.fileName}" from the library? The file is permanently deleted.`);
              if (!why) return;
              startTransition(async () => { await deleteAttachment(f.id, why); });
            }}>remove</button>
        </div>
      ))}
    </>
  );
}
