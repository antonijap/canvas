// Local import reads may use folders that the Cloud wire format does not accept.
import fs from 'node:fs';
import path from 'node:path';

/** Read a regular, singly linked package asset without following links or escaping the package. */
export function readMoveAsset(pkg: string, rel: string): Buffer {
    if (rel.split('/').some(p => p.startsWith('.') || p.startsWith('~') || p.includes('..')))
        throw new Error('Move refuses an asset path outside the package');
    return readPackageFile(pkg, rel);
}

/** The same confined read for package metadata and assets, including dotfiles. */
export function readPackageFile(pkg: string, rel: string): Buffer {
    return withPackageFile(pkg, rel, fd => fs.readFileSync(fd));
}

export function withPackageFile<T>(pkg: string, rel: string, read: (fd: number) => T): T {
    const parts = rel.split('/');
    if (!rel || path.isAbsolute(rel) || rel.includes('\\') || rel.includes('\0') || /^[a-z][a-z0-9+.-]*:/i.test(rel)
        || parts.some(p => !p || p === '.' || p === '..'))
        throw new Error('Move refuses a path outside the package');
    const check = () => {
        if (fs.lstatSync(pkg).isSymbolicLink()) throw new Error('Move refuses a linked package');
        let at = pkg;
        for (const part of parts) {
            at = path.join(at, part);
            if (fs.lstatSync(at).isSymbolicLink()) throw new Error('Move refuses linked assets');
        }
        if (fs.realpathSync(path.dirname(at)) !== path.join(fs.realpathSync(pkg), ...parts.slice(0, -1)))
            throw new Error('Move refuses linked asset folders');
        const stat = fs.lstatSync(at);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('Move refuses linked or non-regular files');
        return stat;
    };
    const seen = check();
    const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
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
        return read(fd);
    } finally {
        fs.closeSync(fd);
    }
}
