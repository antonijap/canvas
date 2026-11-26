import type { CompiledMotion } from "./motion-logic.js";
export type MotionRect = { x: number; y: number; w: number; h: number };
export const MAX_SPRITES: number;
type MotionSprite<T> = { node: T; compiled: CompiledMotion; pivot: MotionRect; placement: MotionRect; clip: MotionRect | null; animateOpacity: boolean; parent: MotionSprite<T> | null };
export function planMotion<T>(root: T, geometry: (n: T) => { box: MotionRect; bounds?: MotionRect | null; ink?: MotionRect | null; placement?: MotionRect } | undefined, limits?: { scale?: number; budget?: number }): {
  sprites: MotionSprite<T>[];
  skipped: { id: string; reason: string }[];
};
