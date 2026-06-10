/**
 * Object storage adapter (Layer / infra support for tasks 8.4, 12.x).
 *
 * Vercel serverless functions have no persistent, writable filesystem (only an
 * ephemeral `/tmp`), so every uploaded asset, render, and export MUST be stored
 * in external object storage (S3 / Cloudflare R2) — see design
 * "Deployment di Vercel → Tanpa filesystem persisten". Components return a
 * {@link FileRef} pointing at the stored object rather than a local path.
 *
 * This module defines a pluggable {@link ObjectStorage} contract plus an
 * in-memory implementation used by tests and local wiring. A real S3/R2-backed
 * implementation (reading `STORAGE_*` env vars) is wired later without changing
 * callers, mirroring the pluggable-adapter approach used by the
 * AI_Service_Connector.
 *
 * Requirements: 1.10 (store accepted uploads), Architecture → object storage.
 */

import type { FileRef } from "@/lib/types";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** An object to be uploaded to storage. */
export interface PutObjectInput {
  /** Storage key / path (e.g. `uploads/<userId>/<name>`). */
  key: string;
  /** Raw bytes of the object. */
  data: Uint8Array;
  /** MIME content type (e.g. `image/png`). */
  contentType: string;
}

/**
 * Pluggable object-storage boundary. Implementations persist bytes and return a
 * {@link FileRef} (URL + format + byte size) for the stored object.
 */
export interface ObjectStorage {
  /** Store an object and return a reference to it. */
  put(input: PutObjectInput): Promise<FileRef>;
  /** Read back a previously stored object's bytes (mainly for tests). */
  get(key: string): Promise<Uint8Array | undefined>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests + local wiring; not for production)
// ---------------------------------------------------------------------------

/**
 * In-memory {@link ObjectStorage}. Keeps object bytes in a map keyed by storage
 * key and mints deterministic local-style URLs. Suitable for tests and local
 * development; production wires an S3/R2 adapter with the same contract.
 */
export class InMemoryObjectStorage implements ObjectStorage {
  private objects = new Map<string, { data: Uint8Array; contentType: string }>();

  constructor(private readonly baseUrl = "memory://storage") {}

  async put(input: PutObjectInput): Promise<FileRef> {
    // Defensive copy so later mutation of the caller's buffer can't change the
    // stored object.
    const data = input.data.slice();
    this.objects.set(input.key, { data, contentType: input.contentType });
    return {
      url: `${this.baseUrl}/${input.key}`,
      format: input.contentType,
      bytes: data.byteLength,
    };
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const entry = this.objects.get(key);
    return entry ? entry.data.slice() : undefined;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let defaultStorage: ObjectStorage | undefined;

/**
 * Return the process-wide default {@link ObjectStorage}. For the MVP this is an
 * in-memory adapter; a real S3/R2 adapter (driven by `STORAGE_*` env vars) is
 * substituted later behind the same contract. Lazily constructed and cached.
 */
export function getObjectStorage(): ObjectStorage {
  if (!defaultStorage) {
    defaultStorage = new InMemoryObjectStorage();
  }
  return defaultStorage;
}
