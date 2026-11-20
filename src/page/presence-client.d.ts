import type { Presence, PeerPresence } from '../../cloud/core/presence.ts';
export function createPresenceSender(options: { send(p: Presence): void; now?: () => number; schedule?: (fn: () => void, ms: number) => () => void; every?: number }): {
    update(p: Presence): void; end(p?: Presence): void; setHidden(h: boolean): void; dispose(): void; readonly waiting: boolean;
};
export function createPeers(options?: { idleMs?: number; fadeMs?: number }): {
    receive(peers: unknown, now: number): void; view(now: number, page?: string | null): any[]; busy(now: number): boolean; readonly size: number; clear(): void;
};
export const FRAME_BYTES: number, TEXT_CHARS: number, PER_SECOND: number, SEND_EVERY_MS: number, IDLE_MS: number, FADE_MS: number;
export const KINDS: string[];
export function fitFrame(p: Presence): Presence | null;
export function idleOpacity(since: number, idleMs?: number, fadeMs?: number): number;
export function toScreen(p: {x:number;y:number}, cam: {x:number;y:number;z:number}): {x:number;y:number};
export function inkOn(hex: string): string;
export function selectionBoxes(ids: string[], rectOf: (id:string)=>any): any[];
export function previewBoxes(preview: any, rectOf:(id:string)=>any): any[];
export function applyPeerPreviews(root: any, peers: any[]): boolean;
