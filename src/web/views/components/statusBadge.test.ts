import { describe, expect, it } from "vitest";
import { statusBadge } from "./statusBadge.js";

describe("statusBadge", () => {
  it("renders a badge for each known status", () => {
    expect(statusBadge("ok")).toContain("status-ok");
    expect(statusBadge("error")).toContain("status-error");
    expect(statusBadge("needs_action")).toContain("status-needs_action");
  });
});
