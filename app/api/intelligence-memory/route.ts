/**
 * `DELETE /api/intelligence-memory` — hapus seluruh data pembelajaran
 * (Intelligence_Memory) milik pengguna yang terautentikasi (task 17.4).
 *
 * Mendukung hak pengguna untuk menghapus data pembelajarannya (Req 9.6) melalui
 * endpoint terautentikasi yang menegakkan otorisasi kepemilikan (Req 11.6).
 *
 * Autentikasi & otorisasi (design "Architecture → Keamanan"):
 *   - Id pengguna terautentikasi dibaca dari header tepercaya yang disuntikkan
 *     middleware (`x-fdg-user-id`, via `getAuthenticatedUserId`). Tidak ada →
 *     401 (fail closed), konsisten dengan route lain.
 *   - Operasi memori bersifat per-pengguna: seorang pengguna HANYA boleh
 *     menghapus datanya sendiri. Bila permintaan menyasar `userId` lain (lewat
 *     body JSON atau query string yang berbeda dari pengguna terautentikasi),
 *     kembalikan **403** (akses lintas-pengguna ditolak) — sesuai konvensi
 *     untuk operasi memori milik pengguna pada design (Req 11.6).
 *
 * Hasil:
 *   - 200 `{ deleted }` di mana `deleted` adalah jumlah entri yang dihapus
 *     (`IntelligenceMemoryStore.deleteByUser`).
 *
 * Store di-resolve via seam `getIntelligenceMemory()` sehingga wiring
 * Prisma-backed menjadi drop-in tanpa mengubah handler ini.
 *
 * Runtime: Node.js (konsisten dengan API lainnya). Mutasi ini tidak boleh
 * di-cache.
 *
 * Requirements: 9.6, 11.6
 */

import { NextResponse } from "next/server";

import { authorizeOwnership, getAuthenticatedUserId } from "@/lib/auth";
import { getIntelligenceMemory } from "@/lib/server/intelligence-memory-provider";

export const runtime = "nodejs";
export const maxDuration = 15;
// Penghapusan mengubah state penyimpanan; jangan pernah di-cache.
export const dynamic = "force-dynamic";

/**
 * Ekstrak `userId` target dari permintaan (jika ada) untuk pengecekan
 * kepemilikan. Mengembalikan `undefined` ketika tidak ada target eksplisit
 * (artinya: hapus data pengguna terautentikasi sendiri).
 *
 * Sumber yang diperiksa, berurutan: query string `?userId=...` lalu body JSON
 * `{ "userId": "..." }`. Body diuraikan secara defensif; body kosong / non-JSON
 * diperlakukan sebagai tanpa target eksplisit.
 */
async function resolveTargetUserId(
  request: Request,
): Promise<{ targetUserId?: string }> {
  // 1. Query string.
  try {
    const url = new URL(request.url);
    const fromQuery = url.searchParams.get("userId");
    if (fromQuery && fromQuery.length > 0) {
      return { targetUserId: fromQuery };
    }
  } catch {
    // URL parsing tak terduga gagal — abaikan, lanjut ke body.
  }

  // 2. Body JSON (opsional).
  try {
    const body = (await request.json()) as unknown;
    if (body && typeof body === "object") {
      const value = (body as Record<string, unknown>).userId;
      if (typeof value === "string" && value.length > 0) {
        return { targetUserId: value };
      }
    }
  } catch {
    // Body kosong / bukan JSON — tidak ada target eksplisit.
  }

  return {};
}

export async function DELETE(request: Request): Promise<NextResponse> {
  // 1. Autentikasi — percayai hanya header dari middleware (fail closed).
  const userId = getAuthenticatedUserId(request.headers);
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized", message: "Permintaan tidak terautentikasi." },
      { status: 401 },
    );
  }

  // 2. Otorisasi per-pengguna — bila ada target eksplisit, ia HARUS sama dengan
  //    pengguna terautentikasi; selain itu akses lintas-pengguna → 403 (Req 11.6).
  const { targetUserId } = await resolveTargetUserId(request);
  if (targetUserId !== undefined && !authorizeOwnership(userId, targetUserId)) {
    return NextResponse.json(
      {
        error: "forbidden",
        message: "Tidak diizinkan menghapus data pembelajaran pengguna lain.",
      },
      { status: 403 },
    );
  }

  // 3. Hapus seluruh entri milik pengguna terautentikasi (Req 9.6).
  const deleted = await getIntelligenceMemory().deleteByUser(userId);

  return NextResponse.json({ deleted }, { status: 200 });
}
