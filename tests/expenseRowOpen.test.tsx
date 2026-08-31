// @vitest-environment jsdom
//
// Clicking an expense on a report opens it.
//
// The bug in the shop's words: "I can highlight but I cannot click." The rows
// carried .row-hover - this app's tell for "there is a record behind this",
// pointer cursor and all - and nothing was wired to it, so the highlight was a
// promise the page did not keep. A receipt taken after the claim was filed had
// nowhere to go, and a mistyped amount could only be removed and retyped,
// which threw away the receipt that WAS right.
//
// What is checked here is the gesture rather than the arithmetic: that the row
// opens on a click and on a keypress, that it opens holding what the row
// actually says, that the controls living inside it still do their own jobs
// instead of opening the row, and that the save goes to the edit action rather
// than filing a second copy of the same receipt.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const editReportExpense = vi.fn(async () => ({}));
const logMyExpense = vi.fn(async () => ({}));
const removeReportExpense = vi.fn(async () => ({}));
vi.mock("@/app/actions", () => ({
  approveExpenseAllowance: vi.fn(async () => ({})),
  attachPoolExpenses: vi.fn(async () => ({})),
  deleteExpenseReport: vi.fn(async () => ({})),
  editReportExpense: (...a: unknown[]) => editReportExpense(...(a as [])),
  logMyExpense: (...a: unknown[]) => logMyExpense(...(a as [])),
  nameExpenseReport: vi.fn(async () => ({})),
  payExpenseReport: vi.fn(async () => ({})),
  removeReportExpense: (...a: unknown[]) => removeReportExpense(...(a as [])),
  returnExpenseReport: vi.fn(async () => ({})),
  setReportWorkOrder: vi.fn(async () => ({})),
  submitDraftReport: vi.fn(async () => ({})),
  withdrawExpenseReport: vi.fn(async () => ({})),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@vercel/blob/client", () => ({ upload: vi.fn(async () => ({ url: "https://blob/new.jpg" })) }));
// The scanner drags corners on a canvas, which jsdom has no opinion about.
vi.mock("@/components/ReceiptScanner", () => ({ default: () => null }));

afterEach(cleanup);
beforeEach(() => {
  editReportExpense.mockClear();
  logMyExpense.mockClear();
  removeReportExpense.mockClear();
});

const ROW = {
  id: 77, kind: "Small tools", description: "Various Tools", amountCents: 8867,
  incurredOn: "2026-07-27", workOrderId: 5, workOrderNumber: "WO-1001",
  receiptUrl: "", receiptName: "", siteId: null, nights: 0,
  allowanceState: "", allowanceNote: "", allowanceByName: "",
};

const REPORT = {
  id: 3, person: "Steve Jones", status: "draft", submittedAt: "2026-08-01",
  paidOn: "", paidRef: "", returnedReason: "",
  title: "Reno install", purpose: "Commissioning the LC-MS",
  workOrderId: 5, workOrderNumber: "WO-1001", openedByName: "", amends: null, amendedBy: [],
};

const POLICY = {
  radiusMiles: 0, dayPerDiemCents: 0, overnightPerDiemCents: 0,
  extendedAfterNights: 0, overnightExtendedCents: 0, hotelNightCapCents: 0,
};

const draw = async (over: { report?: Partial<typeof REPORT>; row?: Partial<typeof ROW> } = {}) => {
  const Detail = (await import("@/components/ExpenseReportDetail")).default;
  render(
    <Detail
      report={{ ...REPORT, ...over.report }}
      rows={[{ ...ROW, ...over.row }]}
      mayWork mine isOwner={false} adminsPeople={false} today="2026-08-30"
      categories={["Small tools", "Meals", "Per diem"]}
      workOrders={[{ id: 5, label: "WO-1001 - Reno install" }]}
      pool={[]}
      policy={POLICY} tripSites={[]} defaultSiteId={null}
    />,
  );
};

/** The dialog, once something has opened it. */
const sheet = () => screen.getByRole("dialog");
const shut = () => screen.queryByRole("dialog") === null;

describe("the row opens", () => {
  it("opens on a click, holding what the row says", async () => {
    // The reported bug, in one assertion: before this the click did nothing.
    await draw();
    expect(shut()).toBe(true);
    fireEvent.click(screen.getByText("Various Tools"));
    const d = sheet();
    expect((within(d).getByLabelText("Amount") as HTMLInputElement).value).toBe("88.67");
    expect((within(d).getByLabelText("Description") as HTMLInputElement).value).toBe("Various Tools");
    expect((within(d).getByLabelText("Date incurred") as HTMLInputElement).value).toBe("2026-07-27");
    expect((within(d).getByLabelText("Category") as HTMLSelectElement).value).toBe("Small tools");
    expect((within(d).getByLabelText("Work order") as HTMLSelectElement).value).toBe("5");
  });

  it("opens from the keyboard, which is where a row-as-a-button earns its role", async () => {
    await draw();
    const row = screen.getByRole("button", { name: /Edit Various Tools/ });
    fireEvent.keyDown(row, { key: "Enter" });
    expect(within(sheet()).getByLabelText("Amount")).toBeTruthy();
  });

  it("says the receipt is missing, and offers to take one", async () => {
    // The reason most people will open a row at all.
    await draw();
    fireEvent.click(screen.getByText("Various Tools"));
    expect(within(sheet()).getByText(/None yet/)).toBeTruthy();
    expect(within(sheet()).getByText("Scan receipt")).toBeTruthy();
  });

  it("leaves the controls inside the row doing their own jobs", async () => {
    /*
     * Both of these live INSIDE the clickable row, and both would otherwise
     * open it as well as firing: tapping a thumbnail to check a total against
     * the till slip would leave an edit dialog behind it, and "remove" would
     * open the row it had just taken off the claim.
     */
    await draw({ row: { receiptUrl: "https://blob/stub.jpg", receiptName: "stub.jpg" } });
    fireEvent.click(screen.getByAltText("stub.jpg"));
    expect(shut()).toBe(true);

    fireEvent.click(screen.getByLabelText("Remove Various Tools"));
    expect(removeReportExpense).toHaveBeenCalledWith(77);
    expect(shut()).toBe(true);
  });
});

describe("what the save does", () => {
  it("edits the row it opened rather than filing a second copy", async () => {
    await draw();
    fireEvent.click(screen.getByText("Various Tools"));
    fireEvent.change(within(sheet()).getByLabelText("Amount"), { target: { value: "91.20" } });
    fireEvent.click(within(sheet()).getByText("Save the changes"));
    await waitFor(() => expect(editReportExpense).toHaveBeenCalled());
    const [id, data] = editReportExpense.mock.calls[0] as unknown as [number, Record<string, unknown>];
    expect(id).toBe(77);
    expect(data.amount).toBe("91.20");
    expect(data.description).toBe("Various Tools");
    // The row already exists. Logging it again would pay the claimant twice.
    expect(logMyExpense).not.toHaveBeenCalled();
  });

  it("carries the receipt already on the row through an edit that is not about it", async () => {
    // Sent, rather than omitted, because the dialog holds the whole row - and
    // what it holds is what was there.
    await draw({ row: { receiptUrl: "https://blob/stub.jpg", receiptName: "stub.jpg" } });
    fireEvent.click(screen.getByText("Various Tools"));
    fireEvent.click(within(sheet()).getByText("Save the changes"));
    await waitFor(() => expect(editReportExpense).toHaveBeenCalled());
    const [, data] = editReportExpense.mock.calls[0] as unknown as [number, Record<string, unknown>];
    expect(data.receiptUrl).toBe("https://blob/stub.jpg");
  });

  it("detaches a receipt somebody removed in the dialog", async () => {
    await draw({ row: { receiptUrl: "https://blob/stub.jpg", receiptName: "stub.jpg" } });
    fireEvent.click(screen.getByText("Various Tools"));
    fireEvent.click(within(sheet()).getByText("remove"));
    fireEvent.click(within(sheet()).getByText("Save the changes"));
    await waitFor(() => expect(editReportExpense).toHaveBeenCalled());
    const [, data] = editReportExpense.mock.calls[0] as unknown as [number, Record<string, unknown>];
    expect(data.receiptUrl).toBe("");
  });

  it("still adds a NEW expense through the add door", async () => {
    // One dialog, two moods - and the add mood must not have become an edit.
    await draw();
    fireEvent.click(screen.getByText("+ Expense"));
    fireEvent.change(within(sheet()).getByLabelText("Description"), { target: { value: "Ferry" } });
    fireEvent.change(within(sheet()).getByLabelText("Amount"), { target: { value: "9.00" } });
    fireEvent.click(within(sheet()).getByText("Add it"));
    await waitFor(() => expect(logMyExpense).toHaveBeenCalled());
    expect(editReportExpense).not.toHaveBeenCalled();
    const [data] = logMyExpense.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(data.reportId).toBe(3);
    expect(data.description).toBe("Ferry");
    // A fresh row starts with a blank receipt, not the last row's.
    expect(data.receiptUrl).toBe("");
  });
});

describe("a claim that has been sent", () => {
  it("opens to be read, and says why it cannot be changed", async () => {
    /*
     * "What does this row actually say" is the question somebody chasing a
     * payout arrives with, and it is a fair one after they hit submit. The
     * fields are disabled rather than hidden, and the sentence names the step
     * out - withdraw it - rather than being a wall.
     */
    await draw({ report: { status: "submitted" } });
    fireEvent.click(screen.getByText("Various Tools"));
    const d = sheet();
    expect((within(d).getByLabelText("Amount") as HTMLInputElement).disabled).toBe(true);
    expect((within(d).getByLabelText("Description") as HTMLInputElement).disabled).toBe(true);
    expect(within(d).queryByText("Save the changes")).toBeNull();
    expect(within(d).getByText(/withdraw it to change its rows/)).toBeTruthy();
  });

  it("offers no way to add or remove anything on it", async () => {
    await draw({ report: { status: "paid" } });
    expect(screen.queryByText("+ Expense")).toBeNull();
    expect(screen.queryByLabelText("Remove Various Tools")).toBeNull();
    fireEvent.click(screen.getByText("Various Tools"));
    expect(within(sheet()).queryByText("Scan receipt")).toBeNull();
    expect(within(sheet()).getByText(/its rows are fixed/)).toBeTruthy();
  });
});
