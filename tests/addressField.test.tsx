// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The address field's contract: with no browser key it is a plain input that
 * touches no network - the old behavior, verbatim. With a key, typing asks
 * Places for suggestions and PICKING one writes Google's formatted address,
 * which is the string the server-side geocoder will always be able to place.
 * "Never misinputs" is that pick, not a validation message.
 */
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetModules(); });
beforeEach(() => { delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY; });

const load = async () => (await import("@/components/AddressField")).default;

describe("without a browser key", () => {
  it("renders a plain input and never calls out", async () => {
    const AddressField = await load();
    const spy = vi.spyOn(global, "fetch");
    const onChange = vi.fn();
    render(<AddressField value="" onChange={onChange} ariaLabel="Site address" />);
    fireEvent.change(screen.getByLabelText("Site address"), { target: { value: "1400 Harbor Way, Richmond" } });
    expect(onChange).toHaveBeenCalledWith("1400 Harbor Way, Richmond");
    await new Promise((r) => setTimeout(r, 400));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("with a browser key", () => {
  const suggest = {
    suggestions: [
      { placePrediction: { placeId: "p1", text: { text: "1400 Harbor Way, Richmond, CA, USA" } } },
      { placePrediction: { placeId: "p2", text: { text: "1400 Harbor Ave, Rich Creek, VA, USA" } } },
    ],
  };

  it("suggests while typing, and a pick writes the formatted address", async () => {
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY = "test-key";
    const AddressField = await load();
    const calls: string[] = [];
    vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      calls.push(String(url));
      if (String(url).includes(":autocomplete")) {
        return { ok: true, json: async () => suggest } as Response;
      }
      return { ok: true, json: async () => ({ formattedAddress: "1400 Harbor Way, Richmond, CA 94804, USA" }) } as Response;
    });
    let value = "";
    const onChange = vi.fn((v: string) => { value = v; });
    render(<AddressField value={value} onChange={onChange} ariaLabel="Site address" />);
    fireEvent.change(screen.getByLabelText("Site address"), { target: { value: "1400 Harbor" } });
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy(), { timeout: 2000 });

    fireEvent.click(screen.getByText("1400 Harbor Way, Richmond, CA, USA"));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("1400 Harbor Way, Richmond, CA 94804, USA"));
    // Details asked only the field the pick needs - the formatted address.
    expect(calls.some((u) => u.includes("/places/p1"))).toBe(true);
  });

  it("keeps one session token across the keystrokes and the pick", async () => {
    // Places bills a session as one unit only when the same token spans it.
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY = "test-key";
    const AddressField = await load();
    const tokens: string[] = [];
    vi.spyOn(global, "fetch").mockImplementation(async (url, init) => {
      if (String(url).includes(":autocomplete")) {
        tokens.push(JSON.parse(String(init?.body)).sessionToken);
        return { ok: true, json: async () => suggest } as Response;
      }
      tokens.push(new URL(String(url)).searchParams.get("sessionToken") ?? "");
      return { ok: true, json: async () => ({ formattedAddress: "x" }) } as Response;
    });
    render(<AddressField value="" onChange={() => {}} ariaLabel="Site address" />);
    const input = screen.getByLabelText("Site address");
    fireEvent.change(input, { target: { value: "1400 Harb" } });
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
    fireEvent.click(screen.getByText("1400 Harbor Way, Richmond, CA, USA"));
    await waitFor(() => expect(tokens.length).toBeGreaterThanOrEqual(2));
    expect(new Set(tokens).size).toBe(1);
  });

  it("swallows a failed lookup instead of breaking the input", async () => {
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY = "test-key";
    const AddressField = await load();
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("offline"));
    const onChange = vi.fn();
    render(<AddressField value="" onChange={onChange} ariaLabel="Site address" />);
    fireEvent.change(screen.getByLabelText("Site address"), { target: { value: "1400 Harbor Way" } });
    await new Promise((r) => setTimeout(r, 500));
    expect(onChange).toHaveBeenCalledWith("1400 Harbor Way");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
