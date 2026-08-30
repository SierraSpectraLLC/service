// Tools on the shelf, and whose kit a shelf is.
//
// The shop's ask, in their words: "I have a certain number of tools and parts
// on my person"; Bill has his own; and there is a cubicle at a client where
// both live. The locations were already expressible - a stockroom is a shop
// shelf, a client cage or a van/field kit - but nothing could go into one
// without a manufacturer part number, so a torque wrench could not be stocked
// at all.
//
// The interesting assertions are therefore about IDENTITY, because that is
// what had to change:
//
//   * a tool is identified by its NAME, and a part by its number. Two tools in
//     one van used to collide on lower('') - the old unique index - so a kit
//     could hold exactly one numberless thing.
//   * a tool may still carry an OEM number, and when it does the number wins.
//     That is the hybrid asked for: how many 4 mm keys have we got, AND what
//     is the number of the alignment tool so another can be ordered.
//   * moving a tool between rooms has to find the destination line by that
//     same rule, or a van restock refuses with "Not found".
//   * a kit belongs to somebody on the ROSTER, by address rather than by name,
//     because a shop can employ two Steve Joneses.
//
// Real Postgres, in-process, from the same DDL every deploy applies - so the
// unique index is the one under test and not a mock of it.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });
vi.mock("@/db", () => ({ db: testDb }));

type Who = {
  email: string; name: string; role: string;
  orgId: number | null; operatorOrgId: number | null; rootOperatorOrgId: number | null;
};
let who: Who;
vi.mock("@/auth", () => ({ auth: async () => ({ user: who }) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Map(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const ROOT = 1, SIERRA = 2, LABZEN = 3;

const OWNER: Who = {
  email: "owner@sierra.test", name: "Dana Reyes", role: "owner",
  orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: ROOT,
};
const TECH: Who = {
  email: "tech@sierra.test", name: "Steve Jones", role: "staff",
  orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: ROOT,
};

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (name, kind, is_operator, parent_org_id) VALUES
      ('Ridgeline', 'provider', true, NULL),
      ('Sierra Spectra', 'provider', true, NULL),
      ('Lab Zen', 'client', false, 2);
    INSERT INTO app_settings (id, operator_org_id) VALUES (1, ${ROOT});

    INSERT INTO house_members (email, org_id, role, name, can_admin_people) VALUES
      ('owner@sierra.test', ${SIERRA}, 'owner', 'Dana Reyes',  false),
      ('tech@sierra.test',  ${SIERRA}, 'staff', 'Steve Jones', false),
      ('bill@sierra.test',  ${SIERRA}, 'staff', 'Bill Alvarez', false),
      -- Off the roster: role 'none' is somebody who used to be here.
      ('gone@sierra.test',  ${SIERRA}, 'none',  'Ray Ng',      false);
  `);
});

beforeEach(async () => {
  who = OWNER;
  await client.exec(`DELETE FROM stock_moves; DELETE FROM stock_items; DELETE FROM stockrooms;`);
});

const rooms = async () => {
  const { stockrooms } = schema;
  const { asc } = await import("drizzle-orm");
  return testDb.select().from(stockrooms).orderBy(asc(stockrooms.id));
};
const linesIn = async (roomId: number) => {
  const { stockItems } = schema;
  const { asc, eq } = await import("drizzle-orm");
  return testDb.select().from(stockItems).where(eq(stockItems.stockroomId, roomId)).orderBy(asc(stockItems.id));
};

/** A room of whichever kind, defaulting to the house's own shop shelf. */
const openRoom = async (over: Partial<{
  name: string; kind: string; orgId: number | null; keeperEmail: string; keeper: string;
}> = {}) => {
  const { createStockroom } = await import("@/app/actions");
  const res = await createStockroom({
    name: over.name ?? "Main shelf", kind: over.kind ?? "shop",
    orgId: over.orgId === undefined ? null : over.orgId,
    keeperEmail: over.keeperEmail, keeper: over.keeper,
  });
  if (res.error) throw new Error(res.error);
  return res.id!;
};

const stock = async (roomId: number, rows: Record<string, string>[]) => {
  const { addStockItems } = await import("@/app/actions");
  return addStockItems(roomId, rows as never);
};

const TOOL = { kind: "tool", partNumber: "", name: "4 mm hex key", qty: "3", minQty: "2" };
const PART = { kind: "part", partNumber: "228-35145-91", name: "Plunger seal kit", qty: "4", minQty: "2" };

describe("putting a tool on a shelf", () => {
  it("takes a tool on its name, with no part number at all", async () => {
    const id = await openRoom();
    const res = await stock(id, [TOOL]);
    expect(res.error).toBeUndefined();
    expect(res.failures).toEqual([]);
    const [row] = await linesIn(id);
    expect(row.kind).toBe("tool");
    expect(row.name).toBe("4 mm hex key");
    expect(row.partNumber).toBe("");
    expect(row.qty).toBe(3);
  });

  it("posts the opening count to the ledger, the same as a part's", async () => {
    // Otherwise "why does it say three" has no answer for a tool.
    const { stockMoves } = schema;
    const id = await openRoom();
    await stock(id, [TOOL]);
    const [move] = await testDb.select().from(stockMoves);
    expect(move.delta).toBe(3);
    expect(move.kind).toBe("receive");
    expect(move.reason).toBe("opening count");
  });

  it("holds two different numberless tools in one room", async () => {
    /*
     * The bug the old index guaranteed: it was UNIQUE on lower(part_number),
     * so every numberless tool in a room collided on lower('') and a van could
     * hold exactly one of them.
     */
    const id = await openRoom({ name: "Steve's kit", kind: "mobile" });
    const res = await stock(id, [
      TOOL,
      { kind: "tool", partNumber: "", name: "Torque wrench, 1/4in", qty: "1" },
      { kind: "tool", partNumber: "", name: "Leak detector", qty: "1" },
    ]);
    expect(res.created).toBe(3);
    expect(await linesIn(id)).toHaveLength(3);
  });

  it("counts one tool on one line however it was capitalized", async () => {
    // A shelf counted under two spellings is two lines that never add up.
    const id = await openRoom();
    await stock(id, [TOOL]);
    const res = await stock(id, [{ ...TOOL, name: "4 MM HEX KEY", minQty: "5" }]);
    expect(res.created).toBe(0);
    expect(res.updated).toBe(1);
    const rows = await linesIn(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].minQty).toBe(5);
    // The opening count is not posted twice - it was not a new line.
    expect(rows[0].qty).toBe(3);
  });

  it("keeps a tool's name when a re-pasted sheet leaves the column empty", async () => {
    // A tool IS its name. Blanking it would leave a count of nothing.
    const id = await openRoom();
    await stock(id, [TOOL]);
    const [line] = await linesIn(id);
    await stock(id, [{ kind: "tool", partNumber: "", name: "4 mm hex key", bin: "Drawer 2" }]);
    const [after] = await linesIn(id);
    expect(after.id).toBe(line.id);
    expect(after.name).toBe("4 mm hex key");
    expect(after.bin).toBe("Drawer 2");
  });

  it("takes an OEM tool by its number, and the number identifies it", async () => {
    /*
     * The hybrid the shop asked for. A tool with a number is orderable exactly
     * like a part, so the number wins as identity - which means renaming it
     * later lands on the line already there rather than forking a second one.
     */
    const id = await openRoom();
    await stock(id, [{ kind: "tool", partNumber: "G1946-80006", name: "CDS alignment tool", qty: "1" }]);
    const res = await stock(id, [{ kind: "tool", partNumber: "g1946-80006", name: "Alignment tool (CDS)", qty: "1" }]);
    expect(res.created).toBe(0);
    expect(res.updated).toBe(1);
    const rows = await linesIn(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Alignment tool (CDS)");
  });

  it("still refuses a PART with no number", async () => {
    // Nothing about tools loosens the rule for parts: a part with no number
    // can be neither priced nor ordered.
    const id = await openRoom();
    const res = await stock(id, [{ kind: "part", partNumber: "", name: "Some seal", qty: "1" }]);
    expect(res.created ?? 0).toBe(0);
    expect(res.failures?.[0].error).toContain("part number");
    expect(await linesIn(id)).toEqual([]);
  });

  it("refuses a tool somebody started but never named, and says which row", async () => {
    // Started: there is a number in it. So this is a row that meant something,
    // and saying nothing about it would lose it.
    const id = await openRoom();
    const res = await stock(id, [
      PART,
      { kind: "tool", partNumber: "G1946-80006", name: "", qty: "1" },
    ]);
    expect(res.created).toBe(1);
    expect(res.failures).toHaveLength(1);
    // The row NUMBER, so somebody can find it in a 40-row paste.
    expect(res.failures?.[0].row).toBe(2);
    expect(res.failures?.[0].error).toContain("name");
  });

  it("passes over a row with nothing in it at all, without complaining", async () => {
    /*
     * The other half of the same rule. The grid ships three blank rows and a
     * pasted sheet has trailing ones; "row 3 is empty" on every save is noise,
     * and a row with only spaces in it is an empty row by any honest reading.
     */
    const id = await openRoom();
    const res = await stock(id, [PART, { kind: "tool", partNumber: "  ", name: "   ", qty: "1" }]);
    expect(res.created).toBe(1);
    expect(res.failures).toEqual([]);
  });

  it("keeps parts and tools on the same shelf and the same ledger", async () => {
    const id = await openRoom();
    const res = await stock(id, [PART, TOOL]);
    expect(res.created).toBe(2);
    const rows = await linesIn(id);
    expect(rows.map((r) => r.kind).sort()).toEqual(["part", "tool"]);
  });
});

describe("moving a tool between rooms", () => {
  it("restocks a van with a tool, landing it on the van's line of that name", async () => {
    /*
     * Keyed on the part number alone the destination lookup returned null for
     * every tool, and the transfer refused with "Not found" - which is the
     * whole van-restock gesture, for exactly the things a van is full of.
     */
    const { transferStock } = await import("@/app/actions");
    const shop = await openRoom({ name: "Main shelf" });
    const van = await openRoom({ name: "Steve's kit", kind: "mobile", keeperEmail: "tech@sierra.test" });
    await stock(shop, [TOOL]);
    const [line] = await linesIn(shop);
    expect((await transferStock(line.id, van, 2)).error).toBeUndefined();
    expect((await linesIn(shop))[0].qty).toBe(1);
    const [landed] = await linesIn(van);
    expect(landed.name).toBe("4 mm hex key");
    expect(landed.kind).toBe("tool");
    expect(landed.qty).toBe(2);
  });

  it("adds to the van's existing line rather than opening a second", async () => {
    const { transferStock } = await import("@/app/actions");
    const shop = await openRoom({ name: "Main shelf" });
    const van = await openRoom({ name: "Steve's kit", kind: "mobile" });
    await stock(shop, [TOOL]);
    await stock(van, [{ ...TOOL, qty: "1" }]);
    const [line] = await linesIn(shop);
    await transferStock(line.id, van, 1);
    const vanLines = await linesIn(van);
    expect(vanLines).toHaveLength(1);
    expect(vanLines[0].qty).toBe(2);
  });

  it("counts a tool down and up like anything else on the shelf", async () => {
    const { receiveStock, recountStock } = await import("@/app/actions");
    const id = await openRoom();
    await stock(id, [TOOL]);
    const [line] = await linesIn(id);
    expect((await receiveStock(line.id, 2, "bought two more")).error).toBeUndefined();
    expect((await linesIn(id))[0].qty).toBe(5);
    expect((await recountStock(line.id, 4, "one walked")).error).toBeUndefined();
    expect((await linesIn(id))[0].qty).toBe(4);
  });

  it("names a tool by its name in the ledger, not as a bare PN", async () => {
    // "received 2 × PN " is how an audit trail stops being readable.
    const { auditLog } = schema;
    const { receiveStock } = await import("@/app/actions");
    const id = await openRoom();
    await stock(id, [TOOL]);
    const [line] = await linesIn(id);
    await receiveStock(line.id, 2);
    const rows = await testDb.select().from(auditLog);
    const said = rows.map((r) => r.action).join("\n");
    expect(said).toContain("4 mm hex key");
    expect(said).not.toContain("PN  ");
  });
});

describe("whose kit it is", () => {
  it("hands a van to somebody on the roster, and takes the name from the roster", async () => {
    /*
     * The address is what is stored, because a name is not an identity - this
     * shop can employ two Steve Joneses, which is the lesson lib/hr already
     * learned. The displayed name comes off the roster row rather than off the
     * form, so the two cannot disagree.
     */
    const id = await openRoom({
      name: "Bill's van", kind: "mobile",
      keeperEmail: "bill@sierra.test", keeper: "whatever the form said",
    });
    const [room] = (await rooms()).filter((r) => r.id === id);
    expect(room.keeperEmail).toBe("bill@sierra.test");
    expect(room.keeper).toBe("Bill Alvarez");
  });

  it("refuses an address that is not on this workspace's roster", async () => {
    // It came off the wire; a picker is not a rule.
    const { createStockroom } = await import("@/app/actions");
    expect((await createStockroom({
      name: "Nice try", kind: "mobile", orgId: null, keeperEmail: "stranger@elsewhere.test",
    })).error).toBeTruthy();
    // ...and somebody who has left is not on it either.
    expect((await createStockroom({
      name: "Nice try", kind: "mobile", orgId: null, keeperEmail: "gone@sierra.test",
    })).error).toBeTruthy();
    expect(await rooms()).toEqual([]);
  });

  it("keeps a typed name for a keeper who is on no roster", async () => {
    // A subcontractor's van is still somebody's, and dropping the only record
    // of who has it would be worse than storing a name.
    const id = await openRoom({ name: "Sub's van", kind: "mobile", keeper: "Ray the sub" });
    const [room] = (await rooms()).filter((r) => r.id === id);
    expect(room.keeper).toBe("Ray the sub");
    expect(room.keeperEmail).toBe("");
  });

  it("hands the van over, and says so in its own audit line", async () => {
    // "who had it in March" is the question people come back with.
    const { auditLog } = schema;
    const { updateStockroom } = await import("@/app/actions");
    const id = await openRoom({ name: "The van", kind: "mobile", keeperEmail: "tech@sierra.test" });
    expect((await updateStockroom(id, { name: "The van", keeperEmail: "bill@sierra.test" })).error)
      .toBeUndefined();
    const [room] = (await rooms()).filter((r) => r.id === id);
    expect(room.keeper).toBe("Bill Alvarez");
    const said = (await testDb.select().from(auditLog)).map((r) => r.action);
    expect(said.some((a) => a.includes("now kept by Bill Alvarez"))).toBe(true);
  });

  it("takes the van back off somebody", async () => {
    const { updateStockroom } = await import("@/app/actions");
    const id = await openRoom({ name: "The van", kind: "mobile", keeperEmail: "tech@sierra.test" });
    await updateStockroom(id, { name: "The van", keeperEmail: "", keeper: "" });
    const [room] = (await rooms()).filter((r) => r.id === id);
    expect(room.keeperEmail).toBe("");
    expect(room.keeper).toBe("");
  });

  it("lets an engineer keep a cage at a client, which is the third place stock lives", async () => {
    // The cubicle at the client's site: a room of its own, belonging to them,
    // stocked with the same grid as everything else.
    who = TECH;
    const id = await openRoom({ name: "Lab Zen cubicle", kind: "client", orgId: LABZEN });
    const res = await stock(id, [TOOL, PART]);
    expect(res.created).toBe(2);
    const [room] = (await rooms()).filter((r) => r.id === id);
    expect(room.kind).toBe("client");
    expect(room.orgId).toBe(LABZEN);
  });
});
