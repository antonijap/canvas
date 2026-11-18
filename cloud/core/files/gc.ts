// Collection of a file's objects (Section 3): keeps the current blobs, everything a kept snapshot names (done or still
// building), and uploads in their grace. Everything else under the file's prefix goes, and its storage is given back.
// It runs under the room's lock, so no build, restore or upload can pick an object it is about to drop.

import type { FileRoom } from "./room.ts";
import type { Manifest } from "./snapshots.ts";
import { compact } from "./snapshots.ts";
import { boardKey, versKey, manifestKey, blobKey } from "./objects.ts";
import { UPLOAD_GRACE_MS, type StorageBudget } from "./uploads.ts";

export type GcResult = { kept: number; deleted: string[]; uploadsExpired: number };

export function collectGarbage(room: FileRoom, budget: StorageBudget): Promise<GcResult> {
  return room.exclusive(async () => {
    const { store, file, objects } = room;
    compact(room);
    const now = room.now();
    const keep = new Set<string>();
    const shas = new Set<string>();
    for (const r of store.sql.exec<{ sha256: string }>("SELECT DISTINCT sha256 FROM blobs").toArray()) shas.add(r.sha256);
    for (const r of store.sql.exec<{ seq: number; manifest: string }>("SELECT seq, manifest FROM snapshots").toArray()) {
      const m = JSON.parse(r.manifest) as Manifest;
      keep.add(manifestKey(file, r.seq));
      for (const b of m.boards) keep.add(boardKey(file, b.sha256));
      keep.add(versKey(file, m.vers.sha256));
      for (const b of m.blobs) shas.add(b.sha256);
    }
    // Uploads: in their grace they stay; past it, unused ones go and give their bytes back.
    let uploadsExpired = 0;
    for (const u of store.sql.exec<{ id: string; sha256: string; at_ms: number; state: string }>("SELECT id, sha256, at_ms, state FROM uploads").toArray()) {
      if (u.state === "used") continue;
      if (now - u.at_ms < UPLOAD_GRACE_MS) shas.add(u.sha256);
      else {
        store.sql.exec("DELETE FROM uploads WHERE id = ?", u.id);
        budget.release(`${file}/${u.id}`);
        uploadsExpired++;
      }
    }
    for (const s of shas) keep.add(blobKey(file, s));
    // Used uploads whose bytes no kept state names: the storage goes back with the object.
    for (const u of store.sql.exec<{ id: string; sha256: string }>("SELECT id, sha256 FROM uploads WHERE state = 'used'").toArray()) {
      if (shas.has(u.sha256)) continue;
      store.sql.exec("DELETE FROM uploads WHERE id = ?", u.id);
      budget.release(`${file}/${u.id}`);
    }
    const deleted: string[] = [];
    for (const key of await objects.list(`files/${file}/`)) {
      if (keep.has(key)) continue;
      await objects.delete(key);
      deleted.push(key);
    }
    return { kept: keep.size, deleted, uploadsExpired };
  });
}
