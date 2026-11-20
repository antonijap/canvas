// Local import reads may use folders that the Cloud wire format does not accept.
import fs from 'node:fs';
import path from 'node:path';

/** Read a regular, singly linked package asset without following links or escaping the package. */
export function readMoveAsset(pkg: string, rel: string): Buffer {
    const parts = rel.split('/');
    if (!rel || path.isAbsolute(rel) || rel.includes('\\') || rel.includes('\0') || /^[a-z][a-z0-9+.-]*:/i.test(rel) || parts.some(p => !p || p === '.' || p === '..'))
        throw new Error('Move refuses an asset path outside the package');
    const check = () => {
        let at = pkg;
        for (const part of parts) {
            at = path.join(at, part);
            if (fs.lstatSync(at).isSymbolicLink()) throw new Error('Move refuses linked assets');
        }
        if (fs.realpathSync(path.dirname(at)) !== path.join(fs.realpathSync(pkg), ...parts.slice(0, -1)))
            throw new Error('Move refuses linked asset folders');
        return fs.lstatSync(at);
    };
    const seen = check();
    const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
    let fd: number;
    try {
        fd = fs.openSync(path.join(pkg, rel), flags | (process.platform === 'darwin' ? 0x20000000 : 0));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EINVAL') throw new Error('Move could not open a package asset');
        fd = fs.openSync(path.join(pkg, rel), flags);
    }
    try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1 || st.ino !== seen.ino || st.dev !== seen.dev)
            throw new Error('Move refuses linked or changed assets');
        check();
        return fs.readFileSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}
