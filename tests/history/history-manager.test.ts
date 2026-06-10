import { describe, expect, it } from "vitest";

import {
  HISTORY_PAGE_SIZE,
  HistoryManager,
  InMemoryHistoryRepository,
  createInMemoryHistoryManager,
  isValidRating,
  type HistoryRepository,
  type StoredBatchRecord,
} from "@/lib/history/history-manager";
import type {
  DesignBriefInput,
  DesignVariation,
  GenerationBatch,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBrief(
  overrides: Partial<DesignBriefInput> = {},
): DesignBriefInput {
  return {
    brandName: "Acme",
    tagline: "We build",
    mainMessage: "Join our team",
    contentGoal: "Rekrutmen",
    visualStyle: "CorporateBlue",
    tone: "Profesional",
    outputFormat: { name: "Square", width: 1080, height: 1080 },
    variationCount: 3,
    accentPalette: ["#112233", "#445566"],
    mandatoryElements: ["LogoStrip", "CTAButton"],
    uploadedAssets: [],
    ...overrides,
  };
}

function makeVariation(id: string, batchId: string): DesignVariation {
  return {
    id,
    batchId,
    brandDna: {
      brandName: "Acme",
      accentPalette: ["#112233"],
      tone: "Profesional",
      visualStyle: "CorporateBlue",
    },
    designSystem: {
      headlineFont: "Inter",
      bodyFont: "Inter",
      typographyScale: [12, 16, 24],
      radius: 8,
      layoutDensity: "regular",
      brandElementPosition: { logo: "top-left" },
      ctaStyle: "solid",
    },
    copy: {
      headline: "Hi",
      cta: "Go",
      alignedGoal: "Rekrutmen",
      alignedTone: "Profesional",
    },
    layout: {
      id: "layout-1",
      format: { name: "Square", width: 1080, height: 1080 },
      slots: [],
      includedElements: ["LogoStrip"],
    },
    imageAsset: { id: "img", url: "https://x.invalid/i.png", width: 1080, height: 1080 },
    renderedCanvas: { url: "https://x.invalid/c.png", width: 1080, height: 1080 },
  };
}

function makeBatch(
  id: string,
  userId: string,
  createdAt: string,
  variationIds: string[] = [`${id}-v1`],
): GenerationBatch {
  return {
    id,
    userId,
    briefId: `${id}-brief`,
    variations: variationIds.map((vid) => makeVariation(vid, id)),
    status: "done",
    createdAt,
  };
}

/** Repository whose mutating methods always reject (storage unavailable). */
class UnavailableHistoryRepository implements HistoryRepository {
  saveCalls = 0;
  saveRatingCalls = 0;
  async saveBatch(): Promise<void> {
    this.saveCalls++;
    throw new Error("storage down");
  }
  async listBatches(): Promise<StoredBatchRecord[]> {
    return [];
  }
  async loadBatch(): Promise<StoredBatchRecord | undefined> {
    return undefined;
  }
  async getRating(): Promise<number | undefined> {
    return undefined;
  }
  async saveRating(): Promise<void> {
    this.saveRatingCalls++;
    throw new Error("storage down");
  }
}

// ---------------------------------------------------------------------------
// isValidRating
// ---------------------------------------------------------------------------

describe("isValidRating", () => {
  it("accepts integers 1..5", () => {
    for (const r of [1, 2, 3, 4, 5]) expect(isValidRating(r)).toBe(true);
  });
  it("rejects out-of-range and non-integer values", () => {
    for (const r of [0, 6, -1, 2.5, NaN, Infinity]) {
      expect(isValidRating(r)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// saveBatch / loadBatch (Req 7.1, 7.3, 7.7)
// ---------------------------------------------------------------------------

describe("HistoryManager.saveBatch + loadBatch", () => {
  it("saves a batch and loads it back with its brief (round-trip)", async () => {
    const { manager } = createInMemoryHistoryManager();
    const batch = makeBatch("b1", "u1", "2024-01-01T00:00:00.000Z");
    const brief = makeBrief();

    const result = await manager.saveBatch(batch, brief);
    expect(result.saved).toBe(true);
    expect(result.retained).toBe(false);

    const loaded = await manager.loadBatch("b1");
    expect(loaded).toBeDefined();
    expect(loaded!.batch.id).toBe("b1");
    expect(loaded!.brief.brandName).toBe(brief.brandName);
  });

  it("returns undefined when loading an unknown batch", async () => {
    const { manager } = createInMemoryHistoryManager();
    expect(await manager.loadBatch("missing")).toBeUndefined();
  });

  it("retains the batch in-session and surfaces an error when persistence fails (Req 7.7)", async () => {
    const repo = new UnavailableHistoryRepository();
    const manager = new HistoryManager(repo, { saveAttempts: 3 });
    const batch = makeBatch("b1", "u1", "2024-01-01T00:00:00.000Z");

    const result = await manager.saveBatch(batch, makeBrief());

    expect(result.saved).toBe(false);
    expect(result.retained).toBe(true);
    expect(result.attempts).toBe(3);
    expect(repo.saveCalls).toBe(3); // retried up to the limit
    expect(typeof result.message).toBe("string");

    // The retained batch is still loadable from the active session.
    const loaded = await manager.loadBatch("b1");
    expect(loaded?.batch.id).toBe("b1");
    expect(manager.getRetainedBatches().map((r) => r.batch.id)).toContain("b1");
  });

  it("stores defensive copies (caller mutation does not corrupt history)", async () => {
    const { manager } = createInMemoryHistoryManager();
    const batch = makeBatch("b1", "u1", "2024-01-01T00:00:00.000Z");
    const brief = makeBrief();
    await manager.saveBatch(batch, brief);

    brief.brandName = "Mutated";
    batch.variations[0].rating = 5;

    const loaded = await manager.loadBatch("b1");
    expect(loaded!.brief.brandName).toBe("Acme");
    expect(loaded!.batch.variations[0].rating).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listBatches (Req 7.2)
// ---------------------------------------------------------------------------

describe("HistoryManager.listBatches", () => {
  it("orders newest → oldest and scopes to the user", async () => {
    const seed: StoredBatchRecord[] = [
      { batch: makeBatch("old", "u1", "2024-01-01T00:00:00.000Z"), brief: makeBrief() },
      { batch: makeBatch("new", "u1", "2024-03-01T00:00:00.000Z"), brief: makeBrief() },
      { batch: makeBatch("mid", "u1", "2024-02-01T00:00:00.000Z"), brief: makeBrief() },
      { batch: makeBatch("other", "u2", "2024-04-01T00:00:00.000Z"), brief: makeBrief() },
    ];
    const { manager } = createInMemoryHistoryManager(seed);

    const list = await manager.listBatches("u1");
    expect(list.map((b) => b.id)).toEqual(["new", "mid", "old"]);
  });

  it("caps results at 20 per page and paginates", async () => {
    const seed: StoredBatchRecord[] = [];
    for (let i = 0; i < 25; i++) {
      // createdAt increasing with i, so higher i = newer.
      const day = String(i + 1).padStart(2, "0");
      seed.push({
        batch: makeBatch(`b${i}`, "u1", `2024-01-${day}T00:00:00.000Z`),
        brief: makeBrief(),
      });
    }
    const { manager } = createInMemoryHistoryManager(seed);

    const page1 = await manager.listBatches("u1", 1);
    expect(page1).toHaveLength(HISTORY_PAGE_SIZE);
    // Newest first => b24 down to b5 on page 1.
    expect(page1[0].id).toBe("b24");

    const page2 = await manager.listBatches("u1", 2);
    expect(page2).toHaveLength(5);
    expect(page2[0].id).toBe("b4");
  });

  it("returns an empty list for a user with no history", async () => {
    const { manager } = createInMemoryHistoryManager();
    expect(await manager.listBatches("nobody")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// rateVariation (Req 7.4, 7.5, 7.8)
// ---------------------------------------------------------------------------

describe("HistoryManager.rateVariation", () => {
  it("accepts and stores an integer rating 1..5 (Req 7.4)", async () => {
    const { manager, repo } = createInMemoryHistoryManager();
    const result = await manager.rateVariation("v1", 4);
    expect(result.accepted).toBe(true);
    expect(result.storedRating).toBe(4);
    expect(await repo.getRating("v1")).toBe(4);
  });

  it("rejects out-of-range ratings and preserves the previous rating (Req 7.8)", async () => {
    const { manager } = createInMemoryHistoryManager();
    await manager.rateVariation("v1", 3); // establish previous

    const result = await manager.rateVariation("v1", 9);
    expect(result.accepted).toBe(false);
    expect(result.storedRating).toBe(3); // previous preserved
    expect(typeof result.message).toBe("string");
  });

  it("rejects non-integer ratings with no previous rating (Req 7.8)", async () => {
    const { manager } = createInMemoryHistoryManager();
    const result = await manager.rateVariation("v1", 2.5);
    expect(result.accepted).toBe(false);
    expect(result.storedRating).toBeUndefined();
  });

  it("accepts the rating and retries silently ≤3x when storage is unavailable (Req 7.5)", async () => {
    const repo = new UnavailableHistoryRepository();
    const manager = new HistoryManager(repo, { ratingAttempts: 3 });

    const result = await manager.rateVariation("v1", 5);

    // Accepted at the UI level despite storage being down; no error surfaced.
    expect(result.accepted).toBe(true);
    expect(result.storedRating).toBe(5);
    expect(result.message).toBeUndefined();
    // Persistence retried up to the limit silently.
    expect(repo.saveRatingCalls).toBe(3);
  });

  it("preserves the in-session accepted rating after a failed rejection follows", async () => {
    const repo = new UnavailableHistoryRepository();
    const manager = new HistoryManager(repo, { ratingAttempts: 2 });
    await manager.rateVariation("v1", 4); // accepted in-session, persist fails

    const rejected = await manager.rateVariation("v1", 0);
    expect(rejected.accepted).toBe(false);
    // The previous in-session rating is preserved even though it never persisted.
    expect(rejected.storedRating).toBe(4);
  });
});
