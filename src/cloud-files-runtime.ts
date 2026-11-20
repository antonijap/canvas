// Small dependency seam: the writer and renderers need no network or session imports.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkBlobPath } from '../cloud/protocol-files.ts';
import { openInPackage } from '../cloud/core/files/confine.ts';
export const cloudFileHooks: {
    isCloud?: (file: string) => boolean;
    assertEdit?: (file: string) => void;
    undoConflict?: (file: string, writers: Record<string, string | 0>) => string | undefined;
    info?: (file: string) => {
        name: string;
    } | null;
} = {};
export function isCloudFile(file: string): boolean {
    return cloudFileHooks.isCloud?.(file) ?? fs.existsSync(path.join(path.dirname(file), '.cloud', 'state.sqlite'));
}
export function cloudAsset(file: string, rel: string): string | null {
    if (checkBlobPath(rel))
        return null;
    const opened = openInPackage(path.dirname(file), rel, fs);
    if ('refused' in opened)
        return null;
    fs.closeSync(opened.fd);
    return path.join(path.dirname(file), rel);
}
export function cloudDerived(file: string): string {
    const pkg = path.dirname(file), key = path.basename(path.dirname(pkg)), id = path.basename(pkg, '.canvas');
    if (!/^[0-9a-f]{16}$/.test(key) || !/^[0-9a-f-]{36}$/.test(id))
        throw new Error('Invalid Cloud cache identity');
    const dir = path.join(os.homedir(), 'Library', 'Caches', 'Canvas', 'cloud', key, 'derived', id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
}
