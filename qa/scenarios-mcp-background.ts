import { sc, type T } from "./harness.ts";
import { exerciseBackground } from "./mcp-background.ts";

sc("mcp-background", "background-disk edits and renders without app requests", { covers: ["mcp-background:disk"], skip: { visual: "Protocol scenario renders and checks its own scratch file; the harness page is unchanged." } }, async (t: T) => {
  const video = await t.ev<string>(`(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#336699'; ctx.fillRect(0, 0, 32, 32);
    const stream = canvas.captureStream(10);
    const chunks = []; const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const done = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.start(); await new Promise(r => setTimeout(r, 300)); recorder.stop(); await done;
    stream.getTracks().forEach(track => track.stop());
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    return btoa(String.fromCharCode(...bytes));
  })()`);
  const result = await exerciseBackground(video);
  t.eq(result.boards, 2, "both agents' writes reached disk");
  t.ok(result.rendered, "headless render returned an image");
  t.notes.push(`${result.requests} MCP HTTP calls, all on the headless port, no shell commands`);
});
