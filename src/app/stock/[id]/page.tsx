import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  appSettings,
  assets, instruments, orgs, partCatalog, partNumbers, partPrices, stockItems, stockMoves,
  stockrooms, stockroomShares,
} from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { forTenant, isHouse, scopeFor, visibleAssetIds, visibleOrgs } from "@/lib/tenancy";
import { canSeeCosts } from "@/lib/redact";
import { shopTime } from "@/lib/shopday";
import { KIND_LABEL, MOVE_LABEL, reorderLines, stockAccess, stockTotals } from "@/lib/stock";
import { suggestOrders } from "@/lib/po";
import StockShelf, { type IssueTarget } from "@/components/StockShelf";
import StockGrid from "@/components/StockGrid";
import StockroomAdmin from "@/components/StockroomAdmin";
import StockAddCard from "@/components/StockAddCard";
import ReorderCard from "@/components/ReorderCard";
import { RecordHero, type HeroStat } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function StockroomPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ buy?: string; rush?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { id } = await params;
  const { buy = "", rush = "" } = await searchParams;
  const buyMode = buy === "fastest" ? "fastest" as const : "cheapest" as const;
  const buyUrgent = rush === "1";
  const roomId = parseInt(id);
  if (isNaN(roomId)) notFound();

  const [[room], orgRows] = await Promise.all([
    db.select().from(stockrooms).where(eq(stockrooms.id, roomId)),
    visibleOrgs(user),
  ]);
  if (!room) notFound();

  const [myShare] = user.orgId === null ? [] : await db.select({ access: stockroomShares.access })
    .from(stockroomShares).where(and(eq(stockroomShares.stockroomId, roomId), eq(stockroomShares.orgId, user.orgId)));
  const acc = stockAccess(user, room, myShare);
  // A room nobody shared with you doesn't exist as far as you're concerned.
  if (!acc.see) notFound();

  const [items, moves, shareRows, priceRows] = await Promise.all([
    db.select().from(stockItems).where(eq(stockItems.stockroomId, roomId))
      .orderBy(asc(stockItems.partNumber)),
    db.select().from(stockMoves).where(eq(stockMoves.stockroomId, roomId))
      .orderBy(desc(stockMoves.at), desc(stockMoves.id)).limit(60),
    db.select({ orgId: stockroomShares.orgId, access: stockroomShares.access, name: orgs.name, kind: orgs.kind })
      .from(stockroomShares).innerJoin(orgs, eq(orgs.id, stockroomShares.orgId))
      .where(eq(stockroomShares.stockroomId, roomId)).orderBy(asc(orgs.name)),
    // The price book behind the reorder card - scoped to the ROOM's workspace,
    // not the reader's. That is the same rule the vocabulary follows: a client
    // reading a shelf shared with them reads the price book of whoever keeps
    // it. Unscoped this was every vendor quote on the instance, which is one
    // service company's negotiated pricing read straight off another's page.
    db.select({
      partNumber: partPrices.partNumber, vendor: partPrices.vendor,
      isOem: partPrices.isOem, priceCents: partPrices.priceCents,
      leadDays: partPrices.leadDays, dropShips: partPrices.dropShips, expediteOk: partPrices.expediteOk,
    }).from(partPrices).where(forTenant(partPrices.tenantOrgId, room.tenantOrgId ?? null)),
  ]);
  const [buySettings] = await db.select({ crossDockDays: appSettings.crossDockDays })
    .from(appSettings).where(eq(appSettings.id, 1));
  const crossDockDays = buySettings?.crossDockDays ?? 1;
  // The parts catalog: what each number IS. A shelf line whose number the book
  // knows borrows its name, and the add-grid offers the book's numbers.
  const bookRows = await db.select({ id: partCatalog.id, partNumber: partCatalog.partNumber, name: partCatalog.name })
    .from(partCatalog).where(and(forTenant(partCatalog.tenantOrgId, room.tenantOrgId ?? null), eq(partCatalog.archived, false)))
    .orderBy(asc(partCatalog.partNumber)).catch(() => []);
  const bookName = new Map(bookRows.map((b) => [b.partNumber.trim().toLowerCase(), b.name]));

  // Where stock from this room may go: systems the viewer can work, plus their
  // own shelf units. Same scope the work pages use, so a picker can never
  // offer a system the viewer couldn't write to anyway.
  const scope = await scopeFor(user);
  const systemRows = await db
    .select({ id: instruments.id, externalId: instruments.externalId, client: instruments.client })
    .from(instruments)
    .where(and(
      eq(instruments.archived, false),
      scope.all ? undefined : scope.ids.length ? inArray(instruments.id, scope.ids) : sql`false`,
    ))
    .orderBy(asc(instruments.externalId));
  const editableSystems = systemRows.filter((s) => scope.all || scope.editable.has(s.id));
  const seeAssets = await visibleAssetIds(user);
  const shelfAssets = await db
    .select({ id: assets.id, kind: assets.kind, model: assets.model, serial: assets.serial })
    .from(assets)
    .where(and(
      isNull(assets.instrumentId),
      // Issuing a part to a retired unit is never the intent.
      ne(assets.status, "Decommissioned"),
      seeAssets === null ? undefined : seeAssets.length ? inArray(assets.id, seeAssets) : sql`false`,
    ))
    .orderBy(asc(assets.kind))
    .then((rows) => (user.role === "client_viewer" ? [] : rows));

  const targets: IssueTarget[] = [
    ...editableSystems.map((s) => ({
      key: `i${s.id}`, label: `${s.externalId}${s.client ? ` · ${s.client}` : ""}`,
      instrumentId: s.id, assetId: null,
    })),
    ...shelfAssets.map((a) => ({
      key: `a${a.id}`, label: `${a.kind}${a.model ? ` ${a.model}` : ""}${a.serial ? ` SN ${a.serial}` : ""} (shelf unit)`,
      instrumentId: null, assetId: a.id,
    })),
  ];

  // Rooms this viewer may also put stock into - the transfer destinations.
  const otherRooms = acc.issue
    ? await (async () => {
        const rows = await db.select().from(stockrooms)
          .where(and(eq(stockrooms.archived, false)))
          .orderBy(asc(stockrooms.name));
        const mine = user.orgId === null ? [] : await db.select({ stockroomId: stockroomShares.stockroomId, access: stockroomShares.access })
          .from(stockroomShares).where(eq(stockroomShares.orgId, user.orgId));
        return rows
          .filter((r) => r.id !== roomId)
          .filter((r) => stockAccess(user, r, mine.find((s) => s.stockroomId === r.id)).issue)
          .map((r) => ({ id: r.id, name: r.name }));
      })()
    : [];

  const ownerName = room.orgId === null ? "us" : orgRows.find((o) => o.id === room.orgId)?.name ?? "an unknown organization";
  // What stock cost is the room owner's business, redacted by the same rule as
  // part costs on a shared system.
  const showCosts = canSeeCosts(user, room.orgId, room.tenantOrgId);
  const totals = stockTotals(items);
  const short = reorderLines(items);
  // Every other spelling of a book part, pointing at what the book calls it -
  // so counting a shelf under the maker's number, or under a number the book
  // has superseded, still lands on one line.
  const bookIds = bookRows.map((b) => b.id);
  const aliasRows = bookIds.length
    ? await db.select().from(partNumbers).where(inArray(partNumbers.catalogId, bookIds)).catch(() => [])
    : [];
  const knownParts = [...new Map([
    ...priceRows.map((p) => [p.partNumber, { pn: p.partNumber, name: "" }] as const),
    ...items.map((i) => [i.partNumber, { pn: i.partNumber, name: i.name }] as const),
    ...bookRows.map((b) => [b.partNumber, { pn: b.partNumber, name: b.name }] as const),
    ...aliasRows.flatMap((a) => {
      const book = bookRows.find((b) => b.id === a.catalogId);
      return book ? [[a.partNumber, {
        pn: a.partNumber, name: book.name, resolvesTo: book.partNumber,
      }] as const] : [];
    }),
  ]).values()].sort((a, b) => a.pn.localeCompare(b.pn));
  const instLabel = new Map(systemRows.map((s) => [s.id, s.externalId]));
  const roomName = new Map(otherRooms.map((r) => [r.id, r.name]));

  const heroStats: HeroStat[] = [
    { value: totals.lines, label: `line${totals.lines === 1 ? "" : "s"}` },
    { value: totals.units, label: `unit${totals.units === 1 ? "" : "s"}` },
    ...(short.length ? [{ value: short.length, label: "at reorder point", tone: "warn" as const }] : []),
    ...(!acc.issue ? [{ value: "read-only", label: "for you", tone: "faint" as const }] : []),
  ];

  return (
    <div className="container wide">
      <div className="crumb">
        <Link href="/stock" style={{ textDecoration: "none", color: "inherit" }}>Inventory</Link> › <b>{room.name}</b>
      </div>

      <RecordHero
        eyebrow={KIND_LABEL[room.kind] ?? room.kind}
        title={room.name}
        meta={[room.keeper, room.location, room.note].filter(Boolean).join(" · ")}
        stats={heroStats}
        actions={acc.issue ? (
          <Link href="/money/purchasing" className="btn sm" style={{ textDecoration: "none" }}>
            Purchase orders
          </Link>
        ) : undefined}
      />

      <div className="card">

        {short.length > 0 && (
          <div className="t-small" style={{ color: "var(--t-warn-fg)", background: "#FAF0DC", border: "1px solid #F0C9A0", borderRadius: 8, padding: "8px 12px", margin: "6px 0 10px" }}>
            <b>{short.length} line{short.length === 1 ? "" : "s"} at or below the reorder point:</b>{" "}
            {short.slice(0, 6).map((s) => s.partNumber).join(", ")}
            {short.length > 6 ? `, +${short.length - 6} more` : ""}
          </div>
        )}

        <StockShelf
          items={items.map((i) => ({
            id: i.id, partNumber: i.partNumber,
            // The book's name backfills a nameless line, so the shelf and the
            // catalog agree about what a number is.
            name: i.name || bookName.get(i.partNumber.trim().toLowerCase()) || "",
            qty: i.qty, minQty: i.minQty,
            bin: i.bin, note: i.note, unitCostCents: showCosts ? i.unitCostCents : null,
          }))}
          targets={targets} rooms={otherRooms}
          canIssue={acc.issue} canManage={acc.manage} showCosts={showCosts}
        />
      </div>

      {/* Ordering follows the same standing as stocking the shelf. */}
      {acc.issue && short.length > 0 && (
        <ReorderCard stockroomId={room.id}
          groups={suggestOrders(short, priceRows, { mode: buyMode, urgent: buyUrgent, crossDockDays })}
          mode={buyMode} urgent={buyUrgent} baseHref={`/stock/${room.id}`} />
      )}

      {acc.manage && (
        <StockAddCard>
          <StockGrid stockroomId={room.id} knownParts={knownParts} />
        </StockAddCard>
      )}

      {acc.manage && (
        <StockroomAdmin
          room={{ id: room.id, name: room.name, kind: room.kind, keeper: room.keeper, location: room.location, note: room.note }}
          shares={shareRows}
          orgOptions={orgRows.filter((o) => o.id !== room.orgId)}
          ownerName={ownerName}
        />
      )}

      <div className="card">
        <div className="card-title" style={{ marginBottom: 4 }}>Ledger</div>
        <div className="mut t-small" style={{ marginBottom: 10 }}>
          Every count change, newest first. A recount posts the difference rather than
          overwriting the number, so a shelf that keeps drifting shows up as a pattern.
        </div>
        {moves.length === 0 && <div className="mut t-body">Nothing has moved yet.</div>}
        {moves.map((m) => (
          <div key={m.id} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "5px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
            <span className="t-body" style={{
              fontWeight: 700, width: 40,
              color: m.delta > 0 ? "#2E6B2E" : "#A32D2D",
            }}>{m.delta > 0 ? `+${m.delta}` : m.delta}</span>
            <span className="mono t-small">{m.partNumber}</span>
            <span className="mut t-small">{MOVE_LABEL[m.kind] ?? m.kind}</span>
            {m.instrumentId !== null && instLabel.get(m.instrumentId) && (
              <Link href={`/instruments/${m.instrumentId}`} className="t-small" style={{ textDecoration: "none" }}>
                {instLabel.get(m.instrumentId)}
              </Link>
            )}
            {m.assetId !== null && (
              <Link href={`/assets/${m.assetId}`} className="t-small" style={{ textDecoration: "none" }}>unit #{m.assetId}</Link>
            )}
            {m.counterpartyId !== null && roomName.get(m.counterpartyId) && (
              <span className="mut t-small">{roomName.get(m.counterpartyId)}</span>
            )}
            {m.reason && <span className="mut t-small">- {m.reason}</span>}
            <span className="mut t-meta" style={{ marginLeft: "auto" }}>
              {m.actor.split("@")[0]} · {shopTime(m.at)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
