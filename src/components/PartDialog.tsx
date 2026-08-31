"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import {
  addCatalogPart, addPartPhotos, addPartPrices, deletePartPrice,
  makePartPhotoCover, removePartPhoto, setKitLines, setPartPhotoCaption, updateCatalogPart,
} from "@/app/actions";
import Dialog from "@/components/ui/Dialog";
import { TokenPicker } from "@/components/ui";
import { toast } from "@/components/ui/Toast";
import { formatCents } from "@/lib/money";
import { isStalePrice } from "@/lib/sourcing";
import {
  ALIAS_KIND_LABEL, ALIAS_KINDS, catalogLabel, isSuperseded, MAX_PART_PHOTOS,
  PART_KINDS, PART_KIND_LABEL, type PartAlias,
} from "@/lib/partCatalog";
import PartNumberField, { forgetCatalog } from "./PartNumberField";

export type PartDraft = {
  partNumber: string; name: string; manufacturer: string; mfrPartNumber: string;
  kind: string; assetTypes: string[]; models: string[]; note: string; aliases: PartAlias[];
};

export type KitLine = { partNumber: string; name: string; qty: number };

export const emptyPartDraft: PartDraft = {
  partNumber: "", name: "", manufacturer: "", mfrPartNumber: "",
  kind: "part", assetTypes: [], models: [], note: "", aliases: [],
};

export type VendorPrice = {
  id: number; partNumber: string; vendor: string; priceCents: number; isOem: boolean;
  url: string; leadDays: number | null; dropShips: boolean; expediteOk: boolean;
  updatedOn: string;
};

export type PartPhoto = { id: number; url: string; caption: string };

/**
 * What a part number IS, as one form - wherever somebody is standing when they
 * need to write it down.
 *
 * Lifted out of PartCatalogPanel so the equipment catalog's model page can open
 * the SAME dialog with its model already filled in, rather than growing a
 * second, smaller add-part form beside it. Two forms for one thing drift: one
 * of them gets the alias field, the other gets the photo, and which you got
 * depended on which page you happened to be on.
 *
 * It owns its own draft. The parent says what to open it with (`seed`) and what
 * to do afterwards; everything between is this component's business.
 */
export default function PartDialog({
  id, seed, seedLines = [], assetTypes, modelsByType, prices = [], photos = [],
  makers = [], today = "", onClose, onSaved,
}: {
  /** The part being edited. Absent = a new one. */
  id?: number;
  seed?: Partial<PartDraft>;
  seedLines?: KitLine[];
  assetTypes: string[];
  modelsByType: Record<string, string[]>;
  prices?: VendorPrice[];
  /** The photos already on this part. Empty for a new one, which has none. */
  photos?: PartPhoto[];
  makers?: string[];
  today?: string;
  onClose: () => void;
  /** Called after a successful save, with the number that was written. */
  onSaved?: (partNumber: string) => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<PartDraft>({ ...emptyPartDraft, ...seed });
  const [lines, setLines] = useState<KitLine[]>(seedLines);
  const [vendorDraft, setVendorDraft] = useState({ vendor: "", price: "", isOem: false, url: "", leadDays: "", dropShips: false, expediteOk: false });
  const [busy, setBusy] = useState("");
  const photoInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const save = () => {
    if (!draft.partNumber.trim()) { setError("A part number is the one thing this needs"); return; }
    setError("");
    startTransition(async () => {
      let saved = id;
      if (saved === undefined) {
        const res = await addCatalogPart(draft);
        if (res.error) { setError(res.error); return; }
        saved = res.id;
      } else {
        const res = await updateCatalogPart(saved, draft);
        if (res.error) { setError(res.error); return; }
      }
      // Contents are a second write, and only for a kit - the parts that are
      // not kits have none and saving an empty list every time would churn.
      if (saved !== undefined && draft.kind === "kit") {
        const r2 = await setKitLines(saved, lines);
        if (r2?.error) { setError(r2.error); return; }
      }
      // The book just changed; the next field to open must see it.
      forgetCatalog();
      onClose();
      toast({ message: `Saved ${draft.partNumber.trim()}` });
      onSaved?.(draft.partNumber.trim());
      router.refresh();
    });
  };

  return (
    <>
    {/* One spelling of "Shimadzu", wherever it's typed - see Settings →
        Catalog. It travels with the fields that read it, the way every other
        panel with a maker input does, so the dialog works on any page. */}
    <datalist id="maker-book">{makers.map((m) => <option key={m} value={m} />)}</datalist>
    <Dialog open onClose={() => onClose()} title={id ? "Edit part number" : "New part number"}
      footer={
        <>
          <span className={`dialog-status${error ? " err" : ""}`}>
            {error || (draft.partNumber.trim()
              ? catalogLabel({ partNumber: draft.partNumber, name: draft.name, manufacturer: draft.manufacturer })
              : "A part number is the one thing this needs.")}
          </span>
          <button className="btn" onClick={() => onClose()} disabled={pending}>Cancel</button>
          <button className="btn accent" onClick={save} disabled={pending || !draft.partNumber.trim()}>
            {pending ? "Saving..." : "Save part"}
          </button>
        </>
      }>
        {/* Tied to its input. A bare <label> beside a bare <input> is two
            unrelated things to a screen reader, and this is the field the form
            refuses to save without. */}
        <label htmlFor="pd-number">Your number *</label>
        <input id="pd-number" className="mono" value={draft.partNumber} autoFocus
          onChange={(e) => setDraft({ ...draft, partNumber: e.target.value })}
          placeholder="AGI-7167-PMK" style={{ marginBottom: 8 }} />

        <label>What it is</label>
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="Agilent 7176 PM Kit" style={{ marginBottom: 8 }} />

        <div className="pf2" style={{ marginBottom: 8 }}>
          <div>
            <label>Manufacturer</label>
            <input value={draft.manufacturer} list="maker-book" onChange={(e) => setDraft({ ...draft, manufacturer: e.target.value })}
              placeholder="Agilent" />
          </div>
          <div>
            <label>Their number</label>
            <input className="mono" value={draft.mfrPartNumber}
              onChange={(e) => setDraft({ ...draft, mfrPartNumber: e.target.value })}
              placeholder="G4521-67001" />
          </div>
        </div>

        {/* Every OTHER number the same part answers to. The pair above is
            the display identity - what the row is called and what every
            other table stores as a bare string - and these make all of
            them resolve to this one entry. Without it, buying the seal
            under a third party's number puts a second undescribed part in
            the book for the same thing. */}
        <label>Its other numbers <span className="mut" style={{ fontWeight: 400 }}>(optional)</span></label>
        <div style={{ marginBottom: 10 }}>
          {draft.aliases.map((a, idx) => {
            const setAlias = (patch: Partial<PartAlias>) =>
              setDraft({ ...draft, aliases: draft.aliases.map((x, i) => (i === idx ? { ...x, ...patch } : x)) });
            return (
              <div key={idx} style={{ display: "flex", gap: 6, marginBottom: 4, alignItems: "center", flexWrap: "wrap" }}>
                <select value={a.kind} onChange={(e) => setAlias({ kind: e.target.value })}
                  aria-label="Whose number this is" className="t-small" style={{ width: "auto" }}>
                  {ALIAS_KINDS.map((k) => <option key={k} value={k}>{ALIAS_KIND_LABEL[k]}</option>)}
                </select>
                <input className="mono t-small" value={a.partNumber} placeholder="PN"
                  aria-label="Part number"
                  onChange={(e) => setAlias({ partNumber: e.target.value })}
                  style={{ flex: "1 1 130px" }} />
                <input value={a.manufacturer ?? ""} list="maker-book" placeholder={a.kind === "shop" ? "-" : "Who makes it"}
                  aria-label="Manufacturer" disabled={a.kind === "shop"}
                  onChange={(e) => setAlias({ manufacturer: e.target.value })}
                  className="t-small" style={{ flex: "1 1 110px" }} />
                <input value={a.note ?? ""} placeholder={isSuperseded(a) ? "when it changed" : "e.g. pack of 10"}
                  aria-label="Note"
                  onChange={(e) => setAlias({ note: e.target.value })}
                  className="t-small" style={{ flex: "1 1 120px" }} />
                <button className="btn link" aria-label={`Remove ${a.partNumber || "number"}`}
                  style={{ color: "var(--t-bad-fg)", fontSize: 13 }}
                  onClick={() => setDraft({ ...draft, aliases: draft.aliases.filter((_, i) => i !== idx) })}>×</button>
              </div>
            );
          })}
          <button className="btn sm" onClick={() => setDraft({ ...draft, aliases: [...draft.aliases, { kind: "oem", partNumber: "", manufacturer: "", note: "" }] })}>
            ＋ Number
          </button>
          <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>
            Anything typed here finds this part - in a picker, on a purchase order, and in
            the list of numbers nobody has described. <b style={{ fontWeight: 700 }}>Superseded</b> keeps
            an old number look-up-able for the records that still quote it, and orders
            {" "}<span className="mono">{draft.partNumber || "this part"}</span> in its place.
          </div>
        </div>

        {/* What it looks like. Only once the entry exists, because a photo
            has to hang off a row - and an upload is immediate rather than
            held to Save, so it is never lost by a validation error on some
            other field. */}
        {id !== undefined && (() => {
          const upl = async (list: FileList | null) => {
            const files = Array.from(list ?? []);
            if (!files.length || id === undefined) return;
            setError("");
            try {
              const done: { url: string }[] = [];
              for (const f of files) {
                setBusy(`Uploading ${f.name}...`);
                const blob = await upload(f.name, f, { access: "public", handleUploadUrl: "/api/upload" });
                done.push({ url: blob.url });
              }
              const res = await addPartPhotos(id, done);
              if (res?.error) setError(res.error);
              else router.refresh();
            } catch (e) {
              setError((e as Error).message);
            } finally { setBusy(""); }
          };
          return (
            <div style={{ marginBottom: 10 }}>
              <label>Photos <span className="mut" style={{ fontWeight: 400 }}>({photos.length}/{MAX_PART_PHOTOS})</span></label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                {photos.map((ph, i) => (
                  <div key={ph.id} style={{ width: 104 }}>
                    <div style={{ position: "relative" }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={ph.url} alt={ph.caption} width={104} height={78}
                        style={{ width: 104, height: 78, objectFit: "cover", borderRadius: 6, border: i === 0 ? "2px solid var(--navy)" : "1px solid var(--line)" }} />
                      <button className="btn link" aria-label="Remove photo" disabled={pending}
                        title="Remove this photo"
                        onClick={() => startTransition(async () => {
                          const res = await removePartPhoto(ph.id);
                          if (res?.error) setError(res.error); else router.refresh();
                        })}
                        style={{ position: "absolute", top: 2, right: 2, background: "#fff", borderRadius: 4, color: "var(--t-bad-fg)", fontSize: 12, lineHeight: 1, padding: "1px 4px" }}>×</button>
                    </div>
                    <input defaultValue={ph.caption} placeholder={i === 0 ? "cover" : "what this shows"}
                      aria-label="Caption"
                      onBlur={(e) => {
                        if (e.target.value === ph.caption) return;
                        startTransition(async () => { await setPartPhotoCaption(ph.id, e.target.value); router.refresh(); });
                      }}
                      className="t-meta" style={{ width: "100%", padding: "3px 5px", marginTop: 2 }} />
                    {i > 0 && (
                      <button className="btn link" style={{ fontSize: 11 }} disabled={pending}
                        onClick={() => startTransition(async () => { await makePartPhotoCover(ph.id); router.refresh(); })}>
                        make cover
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <button className="btn sm" disabled={!!busy || photos.length >= MAX_PART_PHOTOS}
                onClick={() => photoInput.current?.click()}>
                {busy || "＋ Photo"}
              </button>
              <input ref={photoInput} type="file" accept="image/*" multiple style={{ display: "none" }}
                onChange={(e) => { void upl(e.target.files); e.target.value = ""; }} />
              <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>
                One photo of this number is a photo of every one of them, so it belongs here rather
                than on a record - it shows wherever the number does, on nobody&apos;s storage bill.
              </div>
            </div>
          );
        })()}

        <label>Kind</label>
        <div className="seg" role="group" aria-label="Kind" style={{ marginBottom: 8 }}>
          {PART_KINDS.map((k) => (
            <button key={k} type="button" aria-pressed={draft.kind === k}
              onClick={() => setDraft({ ...draft, kind: k })}>{PART_KIND_LABEL[k]}</button>
          ))}
        </div>

        {draft.kind === "kit" && (
          <div style={{ marginBottom: 8 }}>
            <label>What is in it</label>
            <div className="mut t-meta" style={{ marginBottom: 6 }}>
              For reading, not for counting. A kit is stocked and issued as one sealed bag -
              exploding it would have the shelf claim ten septa are loose when they are not.
            </div>
            {lines.map((l, i) => (
              <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                <input type="number" min={1} value={l.qty} aria-label="Quantity" className="t-small" style={{ width: 64 }}
                  onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, qty: parseInt(e.target.value) || 1 } : x))} />
                {/* A kit's contents are the fastest way to put undescribed
                    numbers in the book; resolving here means the ones that
                    ARE described arrive with their real number and name. */}
                <PartNumberField value={l.partNumber} style={{ flex: "0 1 140px", fontSize: 12 }}
                  onChange={(partNumber) => setLines(lines.map((x, j) => j === i ? { ...x, partNumber } : x))}
                  onPick={(part) => setLines(lines.map((x, j) => j === i
                    ? { ...x, partNumber: part.partNumber, name: x.name.trim() || part.name } : x))} />
                <input value={l.name} placeholder="What it is" className="t-small" style={{ flex: 1 }}
                  onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                <button className="btn link"
                  onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            <button className="btn sm" onClick={() => setLines([...lines, { partNumber: "", name: "", qty: 1 }])}>
              ＋ Line
            </button>
          </div>
        )}

        {/* Typed, not browsed. Both of these drew a button per option, which
            on a book of 1,100 models put 1,100 of them in a dialog. See
            components/ui/TokenPicker. */}
        <TokenPicker id="pc-suits" label="Suits" name="Suits" tone="accent"
          options={assetTypes} chosen={draft.assetTypes}
          onChange={(assetTypes) => setDraft({ ...draft, assetTypes })}
          placeholder="Pump, Autosampler, Mass spec..."
          emptyNote="No module types in the catalog yet." />

        {/* The models within those types, when the number is model-specific:
            an LC-20 seal kit is not an LC-30 seal kit. No types picked =
            offer every model. None selected = suits any model. */}
        {(() => {
          const pool = (draft.assetTypes.length ? draft.assetTypes : Object.keys(modelsByType))
            .flatMap((t) => modelsByType[t] ?? []);
          const options = [...new Set(pool)];
          if (options.length === 0) return null;
          return (
            <TokenPicker id="pc-models" name="Specific models"
              label={<>Specific models <span className="mut" style={{ fontWeight: 400 }}>(none = any model)</span></>}
              options={options} chosen={draft.models}
              onChange={(models) => setDraft({ ...draft, models })}
              placeholder="Prep 150 LC, LCMS-8060..." />
          );
        })()}

        {/* Who sells it and for how much: the OEM and the secondary vendors,
            each with a link. Same rows the price book shows; "Request part"
            on a maintenance job pulls the cheapest offer from here. */}
        <label>Vendors &amp; prices</label>
        <div style={{ marginBottom: 8 }}>
          {prices.filter((p) => p.partNumber.toLowerCase() === draft.partNumber.trim().toLowerCase()).map((p) => (
            <div key={p.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", borderBottom: "1px solid var(--line)", fontSize: 13 }}>
              <span style={{ fontWeight: 600 }}>{p.vendor}</span>
              {p.isOem && <span className="pill info">OEM</span>}
              <span className="mono">{formatCents(p.priceCents)}</span>
              <span className="mut t-meta">
                {[p.leadDays !== null ? `${p.leadDays}d` : "lead ?",
                  p.dropShips ? "blind-ships" : "via the shop",
                  p.expediteOk ? "overnight ok" : ""].filter(Boolean).join(" · ")}
              </span>
              {isStalePrice(`${p.updatedOn}T00:00:00Z`, today) && (
                <span className="pill warn" title={`Last confirmed ${p.updatedOn}`}>stale</span>
              )}
              {p.url && <a href={p.url} target="_blank" rel="noreferrer" className="t-meta">link ↗</a>}
              <button className="btn link" aria-label={`Remove ${p.vendor}'s price`} disabled={pending}
                style={{ marginLeft: "auto", color: "var(--t-bad-fg)", fontSize: 12 }}
                onClick={() => startTransition(async () => { await deletePartPrice(p.id); router.refresh(); })}>×</button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 6 }}>
            <input value={vendorDraft.vendor} list="maker-book" placeholder="Vendor"
              onChange={(e) => setVendorDraft({ ...vendorDraft, vendor: e.target.value })}
              className="t-small" style={{ flex: "1 1 110px" }} />
            <input value={vendorDraft.price} placeholder="$" inputMode="decimal"
              onChange={(e) => setVendorDraft({ ...vendorDraft, price: e.target.value })}
              className="t-small" style={{ flex: "0 1 80px" }} />
            <input className="mono t-small" value={vendorDraft.url} placeholder="https://... (optional)"
              onChange={(e) => setVendorDraft({ ...vendorDraft, url: e.target.value })}
              style={{ flex: "2 1 160px" }} />
            <input value={vendorDraft.leadDays} placeholder="Lead d" inputMode="numeric" title="Business days to ship"
              onChange={(e) => setVendorDraft({ ...vendorDraft, leadDays: e.target.value })}
              className="t-small" style={{ flex: "0 1 64px" }} aria-label="Lead time, business days" />
            <label className="t-meta" style={{ display: "flex", alignItems: "center", gap: 4, margin: 0, fontWeight: 400, color: "var(--ink)" }}>
              <input type="checkbox" checked={vendorDraft.isOem} style={{ width: 14, height: 14 }}
                onChange={(e) => setVendorDraft({ ...vendorDraft, isOem: e.target.checked })} />
              OEM
            </label>
            <label className="t-meta" style={{ display: "flex", alignItems: "center", gap: 4, margin: 0, fontWeight: 400, color: "var(--ink)" }}
              title="Verified: ships to a client site under OUR paperwork, none of theirs in the box">
              <input type="checkbox" checked={vendorDraft.dropShips} style={{ width: 14, height: 14 }}
                onChange={(e) => setVendorDraft({ ...vendorDraft, dropShips: e.target.checked })} />
              Blind-ships
            </label>
            <label className="t-meta" style={{ display: "flex", alignItems: "center", gap: 4, margin: 0, fontWeight: 400, color: "var(--ink)" }}
              title="Will overnight on request">
              <input type="checkbox" checked={vendorDraft.expediteOk} style={{ width: 14, height: 14 }}
                onChange={(e) => setVendorDraft({ ...vendorDraft, expediteOk: e.target.checked })} />
              Overnight
            </label>
            <button type="button" className="btn sm" disabled={pending || !draft.partNumber.trim() || !vendorDraft.vendor.trim() || !vendorDraft.price.trim()}
              onClick={() => {
                setError("");
                startTransition(async () => {
                  const res = await addPartPrices([{
                    partNumber: draft.partNumber, vendor: vendorDraft.vendor,
                    price: vendorDraft.price, isOem: vendorDraft.isOem, url: vendorDraft.url,
                    leadDays: vendorDraft.leadDays, dropShips: vendorDraft.dropShips,
                    expediteOk: vendorDraft.expediteOk,
                  }]);
                  if (res?.error) { setError(res.error); return; }
                  if (res.failures?.length) { setError(res.failures[0].error); return; }
                  setVendorDraft({ vendor: "", price: "", isOem: false, url: "", leadDays: "", dropShips: false, expediteOk: false });
                  router.refresh();
                });
              }}>＋ Vendor</button>
          </div>
          {!draft.partNumber.trim() && (
            <div className="mut" style={{ fontSize: 11, marginTop: 3 }}>Type the part number first - prices hang off it.</div>
          )}
        </div>

        <label>Note</label>
        <textarea value={draft.note} rows={2} style={{ width: "100%", marginBottom: 8 }}
          onChange={(e) => setDraft({ ...draft, note: e.target.value })} />

    </Dialog>
    </>
  );
}
