import { afterEach, describe, expect, it } from "vitest";

import { GET } from "@/app/api/history/route";
import { USER_ID_HEADER } from "@/lib/auth";
import {
  createInMemoryHistoryManager,
  type StoredBatchRecord,
} from "@/lib/history/history-manager";
import {
  resetHistoryManager,
  setHistoryManager,
} from "@/lib/server/history-provider";
import type { DesignBriefInput, GenerationBatch } from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBrief(): DesignBriefInput {
  return {
    brandName: "Acme",
    contentGoal: "Rekrutmen",
    visualStyle: "CorporateBlue",
    tone: "Profesional",
    outputFormat: { name: "Square", width: 1080, height: 1080 },
    variationCount: 3,
    accentPalette: ["#112233"],
    mandatoryElements: ["LogoStrip"],
    uploadedAssets: [],
  };
}

function makeBatch(
  id: string,
  userId: string,
  createdAt: string,
): GenerationBatch {
  return {
    id,
    userId,
    briefId: `${id}-brief`,
    variations: [],
    status: "done",
    createdAt,
  };
}

function makeRequest(userId: string | undefined, query = ""): Request {
  const headers = new Headers();
  if (userId !== undefined) headers.set(USER_ID_HEADER, userId);
  return new Request(`https://example.invalid/api/history${query}`, {
    method: "GET",
    headers,
  });
}

function installSeed(seed: StoredBatchRecord[]): void {
  setHistoryManager(createInMemoryHistoryManager(seed).manager);
}

afterEach(() => {
  resetHistoryManager();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/history", () => {
  it("returns 401 when the trusted user header is absent", async () => {
    installSeed([]);
    const res = await GET(makeRequest(undefined));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });

  it("lists the user's batches newest → oldest, scoped per user (Req 7.2)", async () => {
    installSeed([
      { batch: makeBatch("old", "u1", "2024-01-01T00:00:00.000Z"), brief: makeBrief() },
      { batch: makeBatch("new", "u1", "2024-03-01T00:00:00.000Z"), brief: makeBrief() },
      { batch: makeBatch("other", "u2", "2024-04-01T00:00:00.000Z"), brief: makeBrief() },
    ]);

    const res = await GET(makeRequest("u1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.batches.map((b: GenerationBatch) => b.id)).toEqual(["new", "old"]);
    expect(body.page).toBe(1);
  });

  it("paginates with ?page=N", async () => {
    const seed: StoredBatchRecord[] = [];
    for (let i = 0; i < 22; i++) {
      const day = String(i + 1).padStart(2, "0");
      seed.push({
        batch: makeBatch(`b${i}`, "u1", `2024-01-${day}T00:00:00.000Z`),
        brief: makeBrief(),
      });
    }
    installSeed(seed);

    const res = await GET(makeRequest("u1", "?page=2"));
    const body = await res.json();
    expect(body.batches).toHaveLength(2);
    expect(body.page).toBe(2);
  });

  it("loads a batch + brief by id for the owner (Req 7.3)", async () => {
    installSeed([
      { batch: makeBatch("b1", "u1", "2024-01-01T00:00:00.000Z"), brief: makeBrief() },
    ]);

    const res = await GET(makeRequest("u1", "?batchId=b1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.batch.id).toBe("b1");
    expect(body.brief.brandName).toBe("Acme");
  });

  it("returns 404 loading an unknown batch", async () => {
    installSeed([]);
    const res = await GET(makeRequest("u1", "?batchId=missing"));
    expect(res.status).toBe(404);
  });

  it("returns 404 loading a batch owned by another user (no existence leak)", async () => {
    installSeed([
      { batch: makeBatch("b1", "owner", "2024-01-01T00:00:00.000Z"), brief: makeBrief() },
    ]);
    const res = await GET(makeRequest("intruder", "?batchId=b1"));
    expect(res.status).toBe(404);
  });
});
