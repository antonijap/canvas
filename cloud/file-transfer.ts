// Mac Cloud package transfers use bounded batches of content-addressed blobs.
export const FILE_TRANSFER = "file-transfer-v1";
export const FILE_TRANSFER_PARTS = "file-transfer-parts";
export const TRANSFER_PART_BYTES = 8 * 1024 * 1024;
export const TRANSFER_BLOBS = 256;
export const TRANSFER_BATCH_BYTES = 24 * 1024 * 1024;
export const TRANSFER_BLOB_BYTES = 100 * 1024 * 1024;
export const TRANSFER_HEADER_BYTES = 128 * 1024;
export const TRANSFER_BODY_BYTES = TRANSFER_BLOB_BYTES + TRANSFER_HEADER_BYTES + 4;

export function isImportUpload(sub: string, method: string): boolean {
    return method === "POST" && /^import\/uploads(?:\/[a-z0-9-]+\/complete)?$/.test(sub)
        || method === "PUT" && /^import\/uploads\/[a-z0-9-]+\/parts\/\d+$/.test(sub);
}

export function* blobBatches<T>(items: Iterable<T>, sizeOf: (item: T) => number, maxBytes = TRANSFER_BATCH_BYTES): Generator<T[]> {
    let batch: T[] = [], size = 0;
    for (const item of items) {
        const bytes = sizeOf(item);
        if (batch.length && (size + bytes > maxBytes || batch.length === TRANSFER_BLOBS)) {
            yield batch;
            batch = [];
            size = 0;
        }
        batch.push(item);
        size += bytes;
    }
    if (batch.length) yield batch;
}
