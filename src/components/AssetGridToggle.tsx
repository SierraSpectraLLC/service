"use client";

import { useState } from "react";
import AssetGrid, { type GridModel } from "./AssetGrid";

/**
 * The grid, behind a toggle. Adding one unit is a form; adding a rack of them is
 * a spreadsheet, and forcing either shape on the other job is what made this
 * slow. Both live side by side and neither is the "advanced" one.
 */
export default function AssetGridToggle({ instrumentId, kinds, models, owners }: {
  instrumentId: number | null;
  kinds: string[];
  models: Record<string, GridModel[]>;
  owners: string[];
}) {
  const [open, setOpen] = useState(false);
  // A fragment rather than a wrapping div, so the trigger can share a flex row
  // with the "+ New asset" button; the opened grid takes the full row below.
  return (
    <>
      <button className="btn sm" onClick={() => setOpen((v) => !v)}>
        {open ? "Close the grid" : "＋ Several at once"}
      </button>
      {open && (
        <div style={{ marginTop: 4, flexBasis: "100%" }}>
          <AssetGrid instrumentId={instrumentId} kinds={kinds} models={models} owners={owners}
            onDone={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}
