/** A page's event stream, embedded in the editor HTML. Re-create the EventSource on
 * failure, including HTTP errors that leave it permanently closed. */
export function reconnectingStream(url: () => string, disconnected = () => {}) {
  const listeners: [string, EventListener][] = [];
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let active = false;
  let delay = 250;
  function start() {
    retry = undefined;
    if (!active) return;
    const stream = source = new EventSource(url());
    for (const [name, fn] of listeners) stream.addEventListener(name, fn);
    stream.addEventListener("open", () => { if (source === stream) delay = 250; });
    stream.addEventListener("error", () => {
      if (source !== stream) return;
      stream.close();
      source = null;
      retry = setTimeout(start, delay);
      delay = Math.min(delay * 2, 4000);
      disconnected();
    });
  }
  return {
    addEventListener(name: string, fn: EventListener) {
      listeners.push([name, fn]);
      source?.addEventListener(name, fn);
    },
    connect() {
      if (active) return;
      active = true;
      start();
    },
    close() {
      active = false;
      clearTimeout(retry);
      retry = undefined;
      source?.close();
      source = null;
      delay = 250;
      disconnected();
    },
  };
}
