// Mac Cloud package transfers use bounded batches of content-addressed blobs.
export const FILE_TRANSFER = "file-transfer-v1";
export const TRANSFER_BLOBS = 256;
export const TRANSFER_BATCH_BYTES = 24 * 1024 * 1024;
export const TRANSFER_BLOB_BYTES = 100 * 1024 * 1024;
export const TRANSFER_HEADER_BYTES = 128 * 1024;
export const TRANSFER_BODY_BYTES = TRANSFER_BLOB_BYTES + TRANSFER_HEADER_BYTES + 4;

export function* blobBatches<T>(items: Iterable<T>, sizeOf: (item: T) => number): Generator<T[]> {
    let batch: T[] = [], size = 0;
    for (const item of items) {
        const bytes = sizeOf(item);
        if (batch.length && (size + bytes > TRANSFER_BATCH_BYTES || batch.length === TRANSFER_BLOBS)) {
            yield batch;
            batch = [];
            size = 0;
        }
        batch.push(item);
        size += bytes;
    }
    if (batch.length) yield batch;
}
