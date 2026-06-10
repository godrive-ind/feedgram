import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST, setObjectStorage } from "@/app/api/uploads/route";
import { USER_ID_HEADER } from "@/lib/auth";
import {
  InMemoryObjectStorage,
  type ObjectStorage,
} from "@/lib/storage/object-storage";
import { MAX_FILE_SIZE_BYTES } from "@/lib/intake/upload-validation";

let storage: InMemoryObjectStorage;

beforeEach(() => {
  storage = new InMemoryObjectStorage();
  setObjectStorage(storage);
});

afterEach(() => {
  // Restore the default shared adapter for subsequent suites.
  setObjectStorage(new InMemoryObjectStorage());
});

interface FileInput {
  name: string;
  type: string;
  size: number;
}

/** Build an authed multipart upload Request from a list of file descriptors. */
function uploadRequest(files: FileInput[], userId = "user-1"): Request {
  const form = new FormData();
  for (const f of files) {
    const blob = new Blob([new Uint8Array(f.size)], { type: f.type });
    form.append("files", new File([blob], f.name, { type: f.type }));
  }
  const headers = new Headers();
  if (userId) headers.set(USER_ID_HEADER, userId);
  return new Request("https://example.com/api/uploads", {
    method: "POST",
    headers,
    body: form,
  });
}

describe("POST /api/uploads", () => {
  it("returns 401 when unauthenticated", async () => {
    const req = uploadRequest([{ name: "a.png", type: "image/png", size: 10 }], "");
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 when no files are submitted", async () => {
    const headers = new Headers({ [USER_ID_HEADER]: "user-1" });
    const req = new Request("https://example.com/api/uploads", {
      method: "POST",
      headers,
      body: new FormData(),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("accepts a valid PNG, stores it, and returns a FileRef", async () => {
    const res = await POST(
      uploadRequest([{ name: "logo.png", type: "image/png", size: 1024 }]),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      uploaded: { url: string; bytes: number; triggerBackgroundRemoval: boolean }[];
      rejected: unknown[];
    };
    expect(body.uploaded).toHaveLength(1);
    expect(body.rejected).toHaveLength(0);
    expect(body.uploaded[0].url).toContain("uploads/user-1/");
    // Accepted files are flagged for automatic background removal (Req 1.10).
    expect(body.uploaded[0].triggerBackgroundRemoval).toBe(true);

    // The bytes were actually written to storage.
    const key = body.uploaded[0].url.split("memory://storage/")[1];
    expect(await storage.get(key)).toBeDefined();
  });

  it("rejects unsupported formats without cancelling valid files (Req 1.11)", async () => {
    const res = await POST(
      uploadRequest([
        { name: "ok.jpg", type: "image/jpeg", size: 2048 },
        { name: "bad.gif", type: "image/gif", size: 2048 },
      ]),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      uploaded: { name: string }[];
      rejected: { file: string; reason: string }[];
    };
    expect(body.uploaded.map((u) => u.name)).toEqual(["ok.jpg"]);
    expect(body.rejected).toEqual([
      expect.objectContaining({ file: "bad.gif", reason: "format" }),
    ]);
  });

  it("rejects files larger than 10 MB with reason size (Req 1.12)", async () => {
    const res = await POST(
      uploadRequest([
        { name: "huge.png", type: "image/png", size: MAX_FILE_SIZE_BYTES + 1 },
      ]),
    );
    // All files rejected -> 400.
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      uploaded: unknown[];
      rejected: { file: string; reason: string }[];
    };
    expect(body.uploaded).toHaveLength(0);
    expect(body.rejected[0]).toMatchObject({ file: "huge.png", reason: "size" });
  });

  it("rejects files beyond the 10-per-session count budget (Req 1.12)", async () => {
    const files: FileInput[] = Array.from({ length: 12 }, (_, i) => ({
      name: `f${i}.png`,
      type: "image/png",
      size: 16,
    }));
    const res = await POST(uploadRequest(files));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      uploaded: unknown[];
      rejected: { reason: string }[];
    };
    expect(body.uploaded).toHaveLength(10);
    expect(body.rejected).toHaveLength(2);
    expect(body.rejected.every((r) => r.reason === "count")).toBe(true);
  });

  it("returns 400 with rejection reasons when every file is rejected", async () => {
    const res = await POST(
      uploadRequest([
        { name: "a.gif", type: "image/gif", size: 10 },
        { name: "b.txt", type: "text/plain", size: 10 },
      ]),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      uploaded: unknown[];
      rejected: { file: string; reason: string }[];
    };
    expect(body.uploaded).toHaveLength(0);
    expect(body.rejected).toHaveLength(2);
  });

  it("uploads files under the authenticated user's prefix only", async () => {
    const res = await POST(
      uploadRequest([{ name: "x.png", type: "image/png", size: 32 }], "user-42"),
    );
    const body = (await res.json()) as { uploaded: { url: string }[] };
    expect(body.uploaded[0].url).toContain("uploads/user-42/");
  });
});
