import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

type TrashIO = Pick<typeof fs, 'renameSync' | 'cpSync' | 'rmSync'>;
function treeHash(dir: string): string {
    const h = createHash('sha256');
    const walk = (p: string, rel: string) => {
        const s = fs.lstatSync(p);
        h.update(JSON.stringify([rel, s.isDirectory() ? 'dir' : s.isSymbolicLink() ? 'link' : 'file']));
        if (s.isDirectory()) for (const n of fs.readdirSync(p).sort()) walk(path.join(p, n), path.join(rel, n));
        else h.update(s.isSymbolicLink() ? fs.readlinkSync(p) : fs.readFileSync(p));
    };
    walk(dir, '');
    return h.digest('hex');
}

/** Cross-volume moves copy and verify before removing anything. A failed removal restores the source. */
export function trashPackage(source: string, trash = path.join(os.homedir(), '.Trash'), io: TrashIO = fs): string {
    fs.mkdirSync(trash, { recursive: true });
    const dest = path.join(trash, path.basename(source, '.canvas') + '-' + randomUUID() + '.canvas');
    try { io.renameSync(source, dest); return dest; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e; }
    const stage = dest + '.partial';
    let complete = false;
    try {
        const before = treeHash(source);
        io.cpSync(source, stage, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
        if (treeHash(stage) !== before || treeHash(source) !== before) throw new Error('Trash copy verification failed; source kept');
        io.renameSync(stage, dest);
        complete = true;
        try { io.rmSync(source, { recursive: true }); }
        catch (e) {
            // Removal can fail after deleting some children. Restore from the verified complete copy first.
            complete = false;
            io.cpSync(dest, source, { recursive: true, dereference: false, verbatimSymlinks: true, force: true });
            if (treeHash(source) !== before) throw new Error('Could not restore source; verified copy kept in Trash');
            complete = true;
            throw e;
        }
        return dest;
    } catch (e) {
        io.rmSync(stage, { recursive: true, force: true });
        if (complete) io.rmSync(dest, { recursive: true, force: true });
        throw e;
    }
}
