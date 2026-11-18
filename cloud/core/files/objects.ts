// Where a file's big things live: board objects and manifests of its snapshots, and its blobs. R2 on Cloudflare, a
// folder on a Mac, a Map in tests. Keys are content addressed, and a key that exists is never overwritten.

export interface ObjectStore {
  /** Store `bytes` at `key` unless the key exists. True when this call wrote it. */
  putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export const boardKey = (file: string, sha: string) => `files/${file}/boards/${sha}.json.gz`;
export const versKey = (file: string, sha: string) => `files/${file}/vers/${sha}.json.gz`;
export const manifestKey = (file: string, seq: number) => `files/${file}/manifests/${seq}.json`;
export const blobKey = (file: string, sha: string) => `files/${file}/blobs/${sha}`;

/** An ObjectStore in memory. `failAfter` makes the nth write from now throw, as a crash in the middle of a build. */
export class MemoryObjects implements ObjectStore {
  readonly map = new Map<string, Uint8Array>();
  failAfter = -1;
  writes = 0;
  async putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean> {
    if (this.failAfter === 0) {
      this.failAfter = -1;
      throw new Error("crash: the object store went away");
    }
    if (this.failAfter > 0) this.failAfter--;
    if (this.map.has(key)) return false;
    this.map.set(key, new Uint8Array(bytes));
    this.writes++;
    return true;
  }
  async get(key: string): Promise<Uint8Array | null> {
    const v = this.map.get(key);
    return v ? new Uint8Array(v) : null;
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
export const gzipText = (s: string) => pipe(enc.encode(s), new CompressionStream("gzip"));
export const gunzipText = async (b: Uint8Array) => dec.decode(await pipe(b, new DecompressionStream("gzip")));
export const utf8 = (s: string) => enc.encode(s);
export const fromUtf8 = (b: Uint8Array) => dec.decode(b);
