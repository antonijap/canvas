// Read marks are local to this installation, outside the document and its Cloud replica.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Author, Thread } from "../cloud/protocol.ts";
import { stateDir } from "./usage-counts.ts";

type Reader = Pick<Author, "id" | "email"> & { name?: string };

function samePerson(author: Author, me: Reader): boolean {
  if (author.agent) return false;
  if (author.id && me.id) return author.id === me.id;
  if (author.email && me.email) return author.email.toLowerCase() === me.email.toLowerCase();
  return author.name === me.name;
}

export function isUnread(thread: Thread, me: Reader, through: number, forced = false): boolean {
  return !thread.deletedAt && thread.comments.some(c => !c.deletedAt &&
    (forced || (!samePerson(c.author, me) && Date.parse(c.createdAt) > through)));
}

const personKey = (me: Reader) => me.id ? "id:" + me.id : me.email ? "email:" + me.email.toLowerCase() : "name:" + me.name;
const startedAt = Date.now();

export class CommentReads {
  private db: DatabaseSync;
  private baseline: number;

  constructor(dir: string, baseline = startedAt) {
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path.join(dir, "comment-reads.sqlite"));
    this.db.exec(`
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS baseline (id INTEGER PRIMARY KEY CHECK(id = 1), through INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS marks (
        file TEXT NOT NULL, person TEXT NOT NULL, thread TEXT NOT NULL,
        through INTEGER NOT NULL, forced INTEGER NOT NULL,
        PRIMARY KEY (file, person, thread)
      );
    `);
    this.db.prepare("INSERT OR IGNORE INTO baseline VALUES (1, ?)").run(baseline);
    this.baseline = Number(this.db.prepare("SELECT through FROM baseline").get()!.through);
  }

  close(): void { this.db.close(); }

  unread(file: string, me: Reader, threads: readonly Thread[]): string[] {
    const rows = this.db.prepare("SELECT thread, through, forced FROM marks WHERE file = ? AND person = ?").all(file, personKey(me));
    const marks = new Map(rows.map(row => [row.thread, row]));
    return threads.filter(thread => {
      const mark = marks.get(thread.id);
      return isUnread(thread, me, mark ? Number(mark.through) : this.baseline, !!mark?.forced);
    }).map(thread => thread.id);
  }

  mark(file: string, me: Reader, threads: readonly Thread[], unread: boolean, at = Date.now()): void {
    // Include visible messages dated ahead of this clock, for example from a Cloud host.
    const updates = threads.filter(t => !t.deletedAt).map(t => ({
      id: t.id,
      through: t.comments.reduce((through, c) => Math.max(through, Date.parse(c.createdAt) || 0), Math.max(at, this.baseline)),
    }));
    this.db.prepare(`
      INSERT INTO marks (file, person, thread, through, forced)
      SELECT ?, ?, value ->> 'id', value ->> 'through', ? FROM json_each(?) WHERE true
      ON CONFLICT (file, person, thread) DO UPDATE SET through = MAX(excluded.through, marks.through), forced = excluded.forced
    `).run(file, personKey(me), +unread, JSON.stringify(updates));
  }
}

let local: CommentReads | undefined;
export const commentReads = () => local ??= new CommentReads(stateDir());

export function unreadThreads(file: string | null, me: Reader, threads: readonly Thread[]): string[] | undefined {
  if (!file) return [];
  try { return commentReads().unread(file, me, threads); }
  catch { return undefined; } // A local state error must not prevent reading or posting comments.
}
