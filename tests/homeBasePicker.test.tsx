// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import HomeBasePicker from "@/components/HomeBasePicker";

/**
 * The home-base picker's contract: an address of their own, typed, or a
 * client's lab picked from the organizations we work with - and either way
 * what comes out is one plain address string, which is what gets saved.
 */
afterEach(() => cleanup());

const sites = [
  { orgName: "LabZen", label: "HQ", address: "780 Chadbourne Rd, Fairfield CA" },
  { orgName: "LabZen", label: "Building 4", address: "790 Chadbourne Rd, Fairfield CA" },
  { orgName: "Acme Bio", label: "Reno lab", address: "1 Main St, Reno NV" },
];

describe("stationing an engineer at a client", () => {
  it("picking a lab writes that lab's address, grouped by the client", () => {
    const onChange = vi.fn();
    render(<HomeBasePicker value="" onChange={onChange} sites={sites} />);
    const pick = screen.getByLabelText("Use a client site") as HTMLSelectElement;
    expect(Array.from(pick.querySelectorAll("optgroup")).map((g) => g.label)).toEqual(["LabZen", "Acme Bio"]);
    fireEvent.change(pick, { target: { value: "790 Chadbourne Rd, Fairfield CA" } });
    expect(onChange).toHaveBeenCalledWith("790 Chadbourne Rd, Fairfield CA");
  });

  it("shows which lab the field currently holds, and none once it is edited", () => {
    const { rerender } = render(
      <HomeBasePicker value="1 Main St, Reno NV" onChange={() => {}} sites={sites} />);
    expect((screen.getByLabelText("Use a client site") as HTMLSelectElement).value).toBe("1 Main St, Reno NV");
    rerender(<HomeBasePicker value="1 Main St, Reno NV, apt 2" onChange={() => {}} sites={sites} />);
    expect((screen.getByLabelText("Use a client site") as HTMLSelectElement).value).toBe("");
  });

  it("is just the address field when there are no labs to offer", () => {
    render(<HomeBasePicker value="" onChange={() => {}} sites={[]} />);
    expect(screen.getByLabelText("Home base address")).toBeTruthy();
    expect(screen.queryByLabelText("Use a client site")).toBeNull();
  });
});
