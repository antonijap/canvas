import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Expected fixture bytes: Cloud packages extract inline image fills into content addressed assets. */
export function expectedMove(pkg: string) {
    const doc = JSON.parse(fs.readFileSync(path.join(pkg, 'document.json'), 'utf8'));
    const images: { rel: string; bytes: Buffer }[] = [];
    const walk = (value: any) => {
        if (!value || typeof value !== 'object') return;
        if (value.type === 'image' && typeof value.url === 'string' && value.url.startsWith('data:')) {
            const [, type, data] = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,(.*)$/.exec(value.url)!;
            const bytes = Buffer.from(data, 'base64');
            const ext = type === 'jpeg' ? 'jpg' : type === 'svg+xml' ? 'svg' : type;
            const rel = `media/${createHash('sha256').update(bytes).digest('hex')}.${ext}`;
            images.push({ rel, bytes });
            value.url = rel;
        }
        Object.values(value).forEach(walk);
    };
    walk(doc);
    return { document: JSON.stringify(doc), images };
}
