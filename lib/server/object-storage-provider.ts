/**
 * Server-side object-storage provider (mockable seam).
 *
 * Extracted out of `app/api/uploads/route.ts` because Next.js App Router route
 * modules may ONLY export route handlers and route-segment config — a
 * `setObjectStorage` seam exported from the route fails the production build
 * ("is not a valid Route export field"). Hosting the seam here keeps the route
 * build-valid while preserving the same testable wiring pattern used by sibling
 * providers (`variation-store.ts`, `intelligence-memory-provider.ts`).
 *
 * Default: the shared adapter from `lib/storage/object-storage.ts`. Tests and
 * production wiring substitute an adapter via {@link setObjectStorage} without
 * changing the route handler.
 */

import {
  getObjectStorage,
  type ObjectStorage,
} from "@/lib/storage/object-storage";

let storage: ObjectStorage | undefined;

/** Resolve the upload storage adapter, defaulting to the shared adapter. */
export function getUploadStorage(): ObjectStorage {
  return storage ?? getObjectStorage();
}

/** Override the storage adapter (used by production wiring and tests). */
export function setObjectStorage(adapter: ObjectStorage): void {
  storage = adapter;
}

/** Reset the seam (test helper) so the next access restores the default. */
export function resetObjectStorage(): void {
  storage = undefined;
}
