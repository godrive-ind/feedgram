import { afterEach, describe, expect, it } from "vitest";

import { GET } from "@/app/api/credits/route";
import { setCreditManager } from "@/lib/server/credit-provider";
import { USER_ID_HEADER } from "@/lib/auth";
import { createInMemoryCreditManager } from "@/lib/credit/credit-manager";

/** Build a Request carrying the middleware-injected authenticated user id. */
function authedRequest(userId?: string): Request {
  const headers = new Headers();
  if (userId) headers.set(USER_ID_HEADER, userId);
  return new Request("https://example.com/api/credits", {
    method: "GET",
    headers,
  });
}

afterEach(() => {
  // Reset to a fresh default manager between tests.
  setCreditManager(createInMemoryCreditManager().manager);
});

describe("GET /api/credits", () => {
  it("returns 401 when no authenticated user id is present", async () => {
    const res = await GET(authedRequest());
    expect(res.status).toBe(401);
  });

  it("returns 200 with the user's non-negative integer balance", async () => {
    const { manager } = createInMemoryCreditManager({ "user-1": 7 });
    setCreditManager(manager);

    const res = await GET(authedRequest("user-1"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { balance: number };
    expect(body.balance).toBe(7);
    expect(Number.isInteger(body.balance)).toBe(true);
    expect(body.balance).toBeGreaterThanOrEqual(0);
  });

  it("returns balance 0 for a user with no credit record", async () => {
    const res = await GET(authedRequest("unknown-user"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { balance: number };
    expect(body.balance).toBe(0);
  });

  it("only reports the authenticated user's balance, not another user's", async () => {
    const { manager } = createInMemoryCreditManager({
      "user-1": 5,
      "user-2": 99,
    });
    setCreditManager(manager);

    const res = await GET(authedRequest("user-1"));
    const body = (await res.json()) as { balance: number };
    expect(body.balance).toBe(5);
  });
});
