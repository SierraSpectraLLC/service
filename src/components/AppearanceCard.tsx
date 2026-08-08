"use client";

import { useRef, useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import { setOrgAppearance } from "@/app/actions";
import { isValidHex, readableTextOn } from "@/lib/theme";

const MAX_LOGO_BYTES = 1024 * 1024; // a header logo, not a tune file

/**
 * An organization's editors paint their own workspace: header color and logo.
 * The preview mirrors the real header math (lib/theme) so what they see is
 * what everyone in their org gets.
 */
export default function AppearanceCard({ orgName, themeColor, logoUrl, platformName }: {
  orgName: string; themeColor: string; logoUrl: string; platformName: string;
}) {
  const [color, setColor] = useState(themeColor || "#172A4A");
  const [useDefault, setUseDefault] = useState(!themeColor);
  const [logo, setLogo] = useState(logoUrl);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const effective = useDefault ? "#172A4A" : color;
  const fg = isValidHex(effective) ? readableTextOn(effective) : "#fff";

  const pickLogo = async (file: File) => {
    setError(""); setSaved(false);
    if (!/^image\/(png|jpeg|svg\+xml|webp)$/.test(file.type)) { setError("Logo must be a PNG, JPEG, SVG or WebP image"); return; }
    if (file.size > MAX_LOGO_BYTES) { setError("Logo must be under 1 MB"); return; }
    setUploading(true);
    try {
      const blob = await upload(`logos/${orgName}-${file.name}`, file, { access: "public", handleUploadUrl: "/api/upload" });
      setLogo(blob.url);
    } catch (e) {
      setError((e as Error).message || "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const save = () => {
    setError(""); setSaved(false);
    startTransition(async () => {
      const res = await setOrgAppearance({ themeColor: useDefault ? "" : color, logoUrl: logo });
      if (res?.error) setError(res.error);
      else setSaved(true);
    });
  };

  return (
    <div className="card">
      <div className="card-title">Workspace appearance</div>
      <div className="mut" style={{ fontSize: 11, marginBottom: 10 }}>
        Applies to everyone signing in as {orgName}.
      </div>

      {/* Live preview using the same color math as the real header. */}
      <div style={{ borderRadius: 8, overflow: "hidden", border: "1px solid var(--line)", marginBottom: 10 }}>
        <div style={{ background: effective, color: fg, display: "flex", alignItems: "center", gap: 10, padding: "10px 14px" }}>
          {logo && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt={`${orgName} logo`} style={{ height: 22, maxWidth: 100, objectFit: "contain" }} />
          )}
          <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: 0.3 }}>{platformName.toUpperCase()}</span>
          <span style={{ fontSize: 11, opacity: 0.75 }}>{platformName} × {orgName}</span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, margin: 0, fontSize: 12, fontWeight: 400, color: "var(--ink)" }}>
          <input type="checkbox" checked={useDefault} style={{ width: "auto" }}
            onChange={(e) => { setUseDefault(e.target.checked); setSaved(false); }} />
          Default look
        </label>
        {!useDefault && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, margin: 0, fontSize: 12, fontWeight: 400, color: "var(--ink)" }}>
            Header color
            <input type="color" value={isValidHex(color) ? color : "#172A4A"}
              onChange={(e) => { setColor(e.target.value); setSaved(false); }}
              style={{ width: 34, height: 28, padding: 2, border: "1px solid var(--line)", borderRadius: 6, background: "#fff", cursor: "pointer" }} />
          </label>
        )}
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) pickLogo(f); }} />
        <button className="btn sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? "Uploading..." : logo ? "Replace logo" : "Add logo"}
        </button>
        {logo && <button className="btn link" onClick={() => { setLogo(""); setSaved(false); }}>remove logo</button>}
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {saved && <span className="mut" style={{ fontSize: 12 }}>Saved.</span>}
          <button className="btn sm accent" onClick={save} disabled={pending || uploading}>
            {pending ? "Saving..." : "Save appearance"}
          </button>
        </span>
      </div>
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
