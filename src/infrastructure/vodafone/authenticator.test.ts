import { describe, expect, it } from "vitest";
import { waitUntil } from "./authenticator.js";

describe("waitUntil", () => {
  it("resolves as soon as the condition becomes true", async () => {
    let flag = false;
    setTimeout(() => {
      flag = true;
    }, 20);
    const start = Date.now();
    await waitUntil(() => flag, 1000, 5);
    expect(flag).toBe(true);
    expect(Date.now() - start).toBeLessThan(200);
  });

  it("returns once the timeout elapses even if the condition never becomes true", async () => {
    const start = Date.now();
    await waitUntil(() => false, 50, 10);
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
  });

  it("does not poll again once the condition is already true", async () => {
    let calls = 0;
    await waitUntil(
      () => {
        calls++;
        return true;
      },
      1000,
      10,
    );
    expect(calls).toBe(1);
  });
});
