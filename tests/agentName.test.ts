import { describe, expect, it } from "vitest";
import { brandingFrom, fileNameFromDisposition, isEngineDefaultName } from "@/lib/agentName";

describe("reading the installer's name off the host's answer", () => {
  it("takes it out of the header the engine writes", () => {
    expect(fileNameFromDisposition('attachment; filename="meshagent64.exe"')).toBe("meshagent64.exe");
  });

  it("undoes the percent-encoding the engine applies to it", () => {
    // setContentDispositionHeader runs the name through encodeURIComponent, so a
    // branded name with a space or a dash arrives escaped.
    expect(fileNameFromDisposition('attachment; filename="Sierra%20Spectra%20Support64.exe"'))
      .toBe("Sierra Spectra Support64.exe");
  });

  it("survives a header that is malformed rather than reporting a wrong name", () => {
    expect(fileNameFromDisposition('attachment; filename="100%.exe"')).toBe("100%.exe");
  });

  it("says nothing when there is nothing to read", () => {
    for (const h of ["", "attachment", "inline", null, undefined]) {
      expect(fileNameFromDisposition(h)).toBe("");
    }
  });
});

describe("whether the host has been branded", () => {
  it("knows the engine's own names", () => {
    for (const n of ["meshagent64.exe", "MeshAgent.exe", "meshagent32-Acme.exe", "MeshService64.exe",
      "MeshCentralAssistant.exe", "meshagent"]) {
      expect(isEngineDefaultName(n)).toBe(true);
    }
  });

  it("knows an operator's", () => {
    for (const n of ["SierraSpectraSupport64-Acme.exe", "NorthwindRemote.exe", "LabZenSupport64.exe"]) {
      expect(isEngineDefaultName(n)).toBe(false);
    }
  });

  it("reports the name and the verdict together", () => {
    expect(brandingFrom('attachment; filename="meshagent64.exe"'))
      .toEqual({ fileName: "meshagent64.exe", branded: false });
    expect(brandingFrom('attachment; filename="SierraSpectraSupport"'))
      .toEqual({ fileName: "SierraSpectraSupport", branded: true });
  });

  it("reports nothing at all when the host could not be asked", () => {
    // Distinct from "unbranded" on purpose: an unreachable host is not evidence
    // that somebody forgot a setting, and must not be shown as if it were.
    expect(brandingFrom(null)).toBeNull();
    expect(brandingFrom("attachment")).toBeNull();
  });
});
