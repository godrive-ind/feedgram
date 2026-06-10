import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SESSION_COOKIE,
  USER_ID_HEADER,
  USER_PLAN_HEADER,
  authenticateRequest,
  authorizeOwnership,
  extractToken,
  getAuthSecret,
  getAuthenticatedUser,
  getAuthenticatedUserId,
  signSessionToken,
  verifySessionToken,
} from "@/lib/auth";

const SECRET = "test-secret-please-change";

/** Build a `Headers`-compatible accessor from a plain map. */
function headers(map: Record<string, string>): Headers {
  return new Headers(map);
}

describe("signSessionToken / verifySessionToken round-trip", () => {
  it("verifies a token it just signed and returns the payload", async () => {
    const token = await signSessionToken({ sub: "user-1", plan: "Pro" }, SECRET);
    const payload = await verifySessionToken(token, SECRET);
    expect(payload).toBeDefined();
    expect(payload!.sub).toBe("user-1");
    expect(payload!.plan).toBe("Pro");
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signSessionToken({ sub: "user-1" }, SECRET);
    expect(await verifySessionToken(token, "other-secret")).toBeUndefined();
  });

  it("rejects a tampered payload", async () => {
    const token = await signSessionToken({ sub: "user-1" }, SECRET);
    const [h, , s] = token.split(".");
    // Re-encode a different payload while keeping the original signature.
    const forgedPayload = Buffer.from(JSON.stringify({ sub: "attacker" }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const forged = `${h}.${forgedPayload}.${s}`;
    expect(await verifySessionToken(forged, SECRET)).toBeUndefined();
  });

  it("rejects malformed tokens", async () => {
    expect(await verifySessionToken("not-a-jwt", SECRET)).toBeUndefined();
    expect(await verifySessionToken("a.b", SECRET)).toBeUndefined();
    expect(await verifySessionToken("", SECRET)).toBeUndefined();
  });

  it("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const token = await signSessionToken({ sub: "user-1", exp: past }, SECRET);
    expect(await verifySessionToken(token, SECRET)).toBeUndefined();
  });

  it("accepts a token that is not yet expired", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const token = await signSessionToken({ sub: "user-1", exp: future }, SECRET);
    const payload = await verifySessionToken(token, SECRET);
    expect(payload?.sub).toBe("user-1");
  });
});

describe("extractToken", () => {
  it("reads a Bearer token from the Authorization header", () => {
    expect(extractToken(headers({ authorization: "Bearer abc.def.ghi" }))).toBe(
      "abc.def.ghi",
    );
  });

  it("reads the session cookie when no Authorization header is present", () => {
    expect(
      extractToken(headers({ cookie: `${SESSION_COOKIE}=cookie.token.value; other=1` })),
    ).toBe("cookie.token.value");
  });

  it("returns undefined when no token is present", () => {
    expect(extractToken(headers({}))).toBeUndefined();
    expect(extractToken(headers({ cookie: "other=1" }))).toBeUndefined();
  });
});

describe("authenticateRequest", () => {
  const original = process.env.AUTH_SECRET;
  beforeEach(() => {
    process.env.AUTH_SECRET = SECRET;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = original;
  });

  it("fails closed (misconfigured) when AUTH_SECRET is unset", async () => {
    delete process.env.AUTH_SECRET;
    const result = await authenticateRequest(headers({}));
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) expect(result.reason).toBe("misconfigured");
  });

  it("rejects a request with no token (missing -> 401 path)", async () => {
    const result = await authenticateRequest(headers({}));
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) expect(result.reason).toBe("missing");
  });

  it("rejects a request with an invalid token", async () => {
    const result = await authenticateRequest(
      headers({ authorization: "Bearer garbage" }),
    );
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) expect(result.reason).toBe("invalid");
  });

  it("authenticates a request carrying a valid token", async () => {
    const token = await signSessionToken({ sub: "user-9", plan: "Free" }, SECRET);
    const result = await authenticateRequest(
      headers({ authorization: `Bearer ${token}` }),
    );
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.user.userId).toBe("user-9");
      expect(result.user.plan).toBe("Free");
    }
  });

  it("getAuthSecret reflects the env var", () => {
    expect(getAuthSecret()).toBe(SECRET);
    delete process.env.AUTH_SECRET;
    expect(getAuthSecret()).toBeUndefined();
  });
});

describe("authorizeOwnership (403 for cross-user access)", () => {
  it("allows access to a user's own resource", () => {
    expect(authorizeOwnership("user-1", "user-1")).toBe(true);
  });

  it("denies access to another user's resource", () => {
    expect(authorizeOwnership("user-1", "user-2")).toBe(false);
  });

  it("denies when either id is empty", () => {
    expect(authorizeOwnership("", "user-1")).toBe(false);
    expect(authorizeOwnership("user-1", "")).toBe(false);
  });
});

describe("trusted header accessors", () => {
  it("reads the injected user id and plan", () => {
    const h = headers({ [USER_ID_HEADER]: "user-5", [USER_PLAN_HEADER]: "Pro" });
    expect(getAuthenticatedUserId(h)).toBe("user-5");
    expect(getAuthenticatedUser(h)).toEqual({ userId: "user-5", plan: "Pro" });
  });

  it("returns undefined without the injected header", () => {
    expect(getAuthenticatedUserId(headers({}))).toBeUndefined();
    expect(getAuthenticatedUser(headers({}))).toBeUndefined();
  });

  it("ignores an invalid plan header", () => {
    const h = headers({ [USER_ID_HEADER]: "user-5", [USER_PLAN_HEADER]: "Bogus" });
    expect(getAuthenticatedUser(h)).toEqual({ userId: "user-5", plan: undefined });
  });
});
