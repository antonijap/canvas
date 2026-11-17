// Release checklist item 6: a crash during save loses nothing. A scratch server edits a large document while it is
// killed with SIGKILL at a random moment, again and again. After each kill:
// - document.json parses and is a whole document (what a build without the save log reads): the old version or a
//   newer one, never a torn one; with its save log applied (src/doc/doclog.ts) it is whole too;
// - a new server opens it, replays the crash journal, and every edit the dead server had answered 200 is there
//   (the document as Canvas reads it: document.json and its save log).
// Seeded (CRASH_SEED), so a failing round replays with the same timing choices.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDoc } from "../src/engine.ts";
import { sleep, startServer, type Scratch } from "./lib.ts";

type Item = { status: "PASS" | "FAIL" | "NEEDS-MAINTAINER" | "MANUAL" | "SKIP"; text: string; details?: string[] };

/** A document of `boards` boards with `perBoard` layers each, every layer a uniquely named rectangle. */
function largeDoc(boards: number, perBoard: number) {
  return {
    version: "2.21",
    children: Array.from({ length: boards }, (_, b) => ({
      type: "frame", id: `B${b}`, name: `Board ${b}`, x: (b % 20) * 500, y: Math.floor(b / 20) * 900, width: 390, height: 844, fill: "#ffffff", layout: "none",
      children: Array.from({ length: perBoard }, (_, i) => ({
        type: i % 3 ? "rectangle" : "text", id: `B${b}N${i}`, name: `Layer ${b}.${i}`, x: (i % 6) * 60, y: Math.floor(i / 6) * 40, width: 50, height: 30,
        ...(i % 3 ? { fill: "#e4e4e7", cornerRadius: 6 } : { content: `Text ${b}.${i} `.repeat(4), fontSize: 14, fontFamily: "Inter" }),
      })),
    })),
  };
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function crashCheck(o: { rounds: number; boards?: number; perBoard?: number; seed?: number }): Promise<Item[]> {
  const items: Item[] = [];
  const seed = o.seed ?? Number(process.env.CRASH_SEED ?? 6006);
  const rand = rng(seed);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvas-release-crash-")));
  const pkg = path.join(dir, "Large.canvas");
  const docPath = path.join(pkg, "document.json");
  fs.mkdirSync(pkg);
  const doc = largeDoc(o.boards ?? 400, o.perBoard ?? 60);
  fs.writeFileSync(docPath, JSON.stringify(doc, null, 2));
  fs.writeFileSync(path.join(pkg, "widgets.json"), JSON.stringify({ version: 1, widgets: [] }));
  const mb = (fs.statSync(docPath).size / 1024 / 1024).toFixed(1);
  const ids = doc.children.flatMap((b) => b.children.map((c) => c.id));
  const acked = new Map<string, string>(); // id -> the name its last answered edit set
  const problems: string[] = [];
  const onlyRecovered: string[] = [];
  const litter: string[] = [];
  const seen = new Set<string>();
  let srv: Scratch | undefined;
  let next = 0;
  let killedMidWrite = 0, answered = 0, logRounds = 0;
  const post = (s: Scratch, p: string, body: unknown) => fetch(`${s.base}${p}`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  try {
    for (let round = 1; round <= o.rounds; round++) {
      srv = await startServer(dir);
      const s = srv;
      const open = await fetch(`${s.base}/api/doc?file=${encodeURIComponent(pkg)}`);
      if (!open.ok) { problems.push(`round ${round}: the document did not open (${open.status})`); break; }
      await open.arrayBuffer();
      // Three writers rename layers as fast as the server answers; each answered edit is a promise kept.
      let stop = false;
      const writer = async () => {
        while (!stop) {
          const id = ids[next++ % ids.length];
          const name = `r${round}-e${next}`;
          try {
            const r = await post(s, "/api/update", { file: pkg, id, props: { name } });
            await r.arrayBuffer();
            if (r.ok) acked.set(id, name), answered++;
          } catch {
            return; // the server is gone
          }
        }
      };
      const writers = [writer(), writer(), writer()];
      await sleep(250 + Math.floor(rand() * 1500));
      // Mid-write or not: a temp file beside the document means a write was in flight.
      if (fs.readdirSync(pkg).some((f) => f.endsWith(".tmp") && f.includes(`-${s.proc.pid}-`))) killedMidWrite++;
      s.proc.kill("SIGKILL"); // only the server this check started
      await new Promise<void>((r) => (s.proc.exitCode !== null || s.proc.signalCode ? r() : s.proc.once("exit", () => r())));
      stop = true;
      await Promise.all(writers);
      srv = undefined;
      // The bytes on disk: a whole document.
      let onDisk: { children: { children: { id: string; name: string }[] }[] };
      try {
        onDisk = JSON.parse(fs.readFileSync(docPath, "utf8"));
        if (!Array.isArray(onDisk.children) || onDisk.children.length !== doc.children.length) throw new Error(`${onDisk.children?.length} boards instead of ${doc.children.length}`);
        const lp = loadDoc(docPath);
        if (lp.log?.records) logRounds++;
        const withLog = lp.doc as unknown as typeof onDisk;
        if (!Array.isArray(withLog.children) || withLog.children.length !== doc.children.length) throw new Error(`with its save log: ${withLog.children?.length} boards instead of ${doc.children.length}`);
      } catch (e) {
        problems.push(`round ${round}: document.json is torn after the kill: ${(e as Error).message}`);
        break;
      }
      // Reopen: the journal replays, then everything answered before the kill must be in the file.
      srv = await startServer(dir);
      const r2 = await fetch(`${srv.base}/api/doc?file=${encodeURIComponent(pkg)}`);
      await r2.arrayBuffer();
      const f = await post(srv, "/api/flush", { file: pkg });
      await f.arrayBuffer();
      // Where each answered edit is now: in the document, or only in a recovery copy saved beside it.
      const pairs = (file: string, design = false) => {
        try {
          const d = (design ? loadDoc(file).doc : JSON.parse(fs.readFileSync(file, "utf8"))) as typeof onDisk;
          return new Set(d.children.flatMap((b) => b.children.map((c) => `${c.id}=${c.name}`)));
        } catch {
          return new Set<string>();
        }
      };
      const inDoc = pairs(docPath, true);
      const recovered = fs.readdirSync(pkg).filter((f) => f.startsWith("document.json.recovered-")).map((f) => pairs(path.join(pkg, f)));
      const lost = [...acked].filter(([id, name]) => !inDoc.has(`${id}=${name}`) && !recovered.some((r) => r.has(`${id}=${name}`)));
      const aside = [...acked].filter(([id, name]) => !inDoc.has(`${id}=${name}`) && recovered.some((r) => r.has(`${id}=${name}`)));
      if (lost.length) problems.push(`round ${round}: ${lost.length} answered edits lost after the restart (in neither the document nor a recovery copy), e.g. ${lost.slice(0, 3).map(([id, n]) => `${id}=${n}`).join(", ")}`);
      if (aside.length) onlyRecovered.push(`round ${round}: ${aside.length} answered edits are not in document.json, only in a recovery copy beside it`);
      for (const [id, name] of aside) acked.delete(id), void name; // the document is what the next round builds on
      // Looked at once the reopened server has quit: a whole write right after the open (the dead server's save log
      // folded into document.json) keeps the bytes it replaced for 2 s, and quitting settles them.
      await srv.stop();
      srv = undefined;
      for (const f of fs.readdirSync(pkg)) if (!["document.json", "widgets.json", ".document.json.canvas-log", ".document.json.canvas-lock"].includes(f) && !seen.has(f)) seen.add(f), litter.push(`round ${round}: ${f}`);
    }
    const edits = answered;
    items.push(problems.length ? { status: "FAIL", text: `crash during save (${o.rounds} kills of a ${mb} MB document, seed ${seed})`, details: problems } : { status: "PASS", text: `${o.rounds} kill -9s of a ${mb} MB document mid-editing (${killedMidWrite} with a write in flight, ${logRounds} with edits in the save log): the file was always whole, and all ${edits} answered edits survived the restart (seed ${seed})` });
    const guide = fs.readFileSync(new URL("../docs/developer-guide.md", import.meta.url), "utf8");
    const guideSaysRecovered = !/replay onto the file/.test(guide) && /`<name>\.recovered-<time>`/.test(guide);
    if (onlyRecovered.length && guideSaysRecovered) items.push({ status: "PASS", text: `after each crash, answered edits the dead server had not saved yet are in document.json.recovered-<time> beside the document, as docs/developer-guide.md (Crash journal) says (${onlyRecovered.length} of ${o.rounds} rounds)` });
    else if (onlyRecovered.length) items.push({ status: "NEEDS-MAINTAINER", text: "after a crash, edits the server had answered are not put back into the document: the reopened file is the last saved version, and the answered edits sit in document.json.recovered-<time> beside it for the person to find. docs/developer-guide.md says they \"replay onto the file\". Replay them, or change the guide", details: onlyRecovered });
    const conflicts = litter.filter((l) => /\.conflict-/.test(l));
    if (conflicts.length) items.push({ status: "FAIL", text: `${conflicts.length} false conflict copies: on reopening, the killed server's copies of the bytes its own last writes replaced (-prev.tmp hard links) are kept as document.json.conflict-<time> and reported as "Someone saved at the same moment as Canvas" (src/docwriter.ts cleanStaleTemps)`, details: conflicts });
    const rest = litter.filter((l) => !/\.conflict-|\.recovered-/.test(l));
    if (rest.length) items.push({ status: "FAIL", text: "temp files left in the package after a crash and a clean reopen", details: rest });
  } catch (e) {
    items.push({ status: "FAIL", text: `crash check failed: ${(e as Error).message}` });
  } finally {
    if (srv) await srv.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return items;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const items = await crashCheck({ rounds: Number(process.env.CRASH_ROUNDS ?? 4) });
  for (const i of items) console.log(`${i.status} ${i.text}${i.details ? "\n  " + i.details.join("\n  ") : ""}`);
}
