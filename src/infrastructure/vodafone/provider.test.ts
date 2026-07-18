import { describe, expect, it, vi } from "vitest";
import { SessionExpiredError } from "../../domain/errors.js";
import type { AccountCredentials } from "../../domain/invoice.js";
import type { AuthSession } from "../../domain/vodafone-session.js";
import { VodafoneProviderFacade } from "./provider.js";

const credentials: AccountCredentials = { username: "u", password: "p" };
const fresh: AuthSession = { accessToken: "fresh", expiresAt: 10_000, storageState: "{}" };
const expired: AuthSession = { accessToken: "old", expiresAt: 100, storageState: "{}" };

function deps(overrides: {
  fullLogin?: () => Promise<AuthSession>;
  silentRenewal?: () => Promise<AuthSession>;
  silentRenewalSupported?: boolean;
}) {
  return {
    authenticator: {
      fullLogin: vi.fn(overrides.fullLogin ?? (async () => fresh)),
      silentRenewal: vi.fn(overrides.silentRenewal ?? (async () => fresh)),
    },
    apiClient: {
      discoverAssets: vi.fn(async () => []),
      listInvoices: vi.fn(async () => []),
      fetchDocument: vi.fn(async () => ({ mime: "application/pdf", bytes: Buffer.alloc(1) })),
    },
    silentRenewalSupported: overrides.silentRenewalSupported ?? true,
    now: () => 1000,
  };
}

describe("VodafoneProviderFacade.getSession", () => {
  it("reuses a still-valid existing session without touching the browser", async () => {
    const d = deps({});
    const provider = new VodafoneProviderFacade(d);
    const result = await provider.getSession(credentials, fresh);
    expect(result).toBe(fresh);
    expect(d.authenticator.fullLogin).not.toHaveBeenCalled();
    expect(d.authenticator.silentRenewal).not.toHaveBeenCalled();
  });

  it("tries silent renewal for an expired session when supported", async () => {
    const d = deps({ silentRenewalSupported: true });
    const provider = new VodafoneProviderFacade(d);
    await provider.getSession(credentials, expired);
    expect(d.authenticator.silentRenewal).toHaveBeenCalledOnce();
    expect(d.authenticator.fullLogin).not.toHaveBeenCalled();
  });

  it("falls back to full login when silent renewal reports the session gone", async () => {
    const d = deps({
      silentRenewalSupported: true,
      silentRenewal: async () => {
        throw new SessionExpiredError("gone");
      },
    });
    const provider = new VodafoneProviderFacade(d);
    await provider.getSession(credentials, expired);
    expect(d.authenticator.fullLogin).toHaveBeenCalledOnce();
  });

  it("goes straight to full login when there is no existing session", async () => {
    const d = deps({});
    const provider = new VodafoneProviderFacade(d);
    await provider.getSession(credentials);
    expect(d.authenticator.fullLogin).toHaveBeenCalledOnce();
    expect(d.authenticator.silentRenewal).not.toHaveBeenCalled();
  });

  it("skips silent renewal entirely when unsupported", async () => {
    const d = deps({ silentRenewalSupported: false });
    const provider = new VodafoneProviderFacade(d);
    await provider.getSession(credentials, expired);
    expect(d.authenticator.silentRenewal).not.toHaveBeenCalled();
    expect(d.authenticator.fullLogin).toHaveBeenCalledOnce();
  });
});
