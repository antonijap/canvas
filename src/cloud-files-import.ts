// A package can hold boards larger than one wire action. Insert parents and component definitions before users.
import type { DocNode, FileOp, Json } from '../cloud/protocol-files.ts';
import { stateFromFiles } from '../cloud/core/files/state.ts';

/** Preserve document containers and key order when rebuilding an empty Cloud file. */
export function importDocument(document: Record<string, Json>): FileOp[] {
    const state = stateFromFiles(document);
    const values: Extract<FileOp, { k: 'doc' }>[] = [];
    for (const [key, value] of Object.entries(state.doc)) {
        if (key === 'variables') {
            const entries = Object.entries(value as Record<string, Json>);
            if (!entries.length) values.push({ k: 'doc', key: 'variables', value: { v: {} } });
            for (const [id, v] of entries) values.push({ k: 'doc', key: `variables/${id}`, value: { v } });
        } else values.push({ k: 'doc', key: key as 'fonts' | 'themes', value: { v: value! } });
    }
    // Even a document without values can put children before version. Removing an absent key changes no content.
    if (!values.length) values.push({ k: 'doc', key: 'themes', value: null });
    values[values.length - 1].order = Object.keys(document);
    return [...importNodes(state.children), ...values];
}

export function importNodes(children: DocNode[]): FileOp[] {
    const entries = new Map<string, {
        node: DocNode;
        parent: string | null;
        siblings: DocNode[];
    }>();
    const index = (list: DocNode[], parent: string | null) => { for (const node of list) {
        const id = String(node.id);
        if (entries.has(id))
            throw new Error('Duplicate imported layer id');
        entries.set(id, { node, parent, siblings: list });
        if (Array.isArray(node.children))
            index(node.children as DocNode[], String(node.id));
    } };
    index(children, null);
    const added = new Set<string>(), adding = new Set<string>(), ops: FileOp[] = [];
    const add = (id: string) => {
        if (added.has(id))
            return;
        if (adding.has(id))
            throw new Error('Imported component cycle');
        const e = entries.get(id);
        if (!e)
            throw new Error('Missing imported component');
        adding.add(id);
        if (e.parent && !added.has(e.parent))
            add(e.parent);
        if (e.node.type === 'ref' && typeof e.node.ref === 'string' && !added.has(e.node.ref))
            add(e.node.ref);
        const at = e.siblings.indexOf(e.node);
        let after: string | null = null;
        for (let i = at - 1; i >= 0; i--)
            if (added.has(String(e.siblings[i].id))) {
                after = String(e.siblings[i].id);
                break;
            }
        const node = Object.fromEntries(Object.entries(e.node).map(([key, value]) => [key, key === 'children' ? [] : value])) as DocNode;
        ops.push({ k: 'insert', parent: e.parent, after, node });
        added.add(id);
        adding.delete(id);
    };
    for (const id of entries.keys())
        add(id);
    return ops;
}
