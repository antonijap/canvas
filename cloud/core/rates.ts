/** Shared by HTTP and sockets at the Team, before parsing payloads or reading roles. */
export class Rates {
  private readonly windows = new Map<string, { start: number; count: number }>();
  take(email: string, bucket: string, limit: number, count = 1): number {
    const now = Date.now();
    for (const [key, value] of this.windows) if (now - value.start >= 60_000) this.windows.delete(key);
    const key = `${bucket}:${email}`;
    const window = this.windows.get(key) ?? { start: now, count: 0 };
    const allowed = Math.min(count, Math.max(0, limit - window.count));
    window.count += allowed;
    this.windows.set(key, window);
    return allowed;
  }
}
