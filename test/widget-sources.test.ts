import assert from "node:assert/strict";
import { test } from "node:test";
import { ciData, diskData, gitData, metricData, previewData, usageData } from "../src/widgets/source-data.ts";

test("Git counts changed paths and reads the current branch and upstream", () => {
  assert.deepEqual(gitData("# branch.head main\0# branch.ab +2 -3\0? first file\0" + "2 R. N... 100644 100644 100644 a b new\0old\0", "abc123\tA commit\n"), {
    branch: "main", changed: 2, ahead: 2, behind: 3, commits: [{ id: "abc123", title: "A commit" }],
  });
  assert.equal(gitData("# branch.head (detached)\0", "").branch, "Detached HEAD");
});

test("CI keeps failing jobs and pull request links", () => {
  const result = ciData([{ name: "Build", conclusion: "failure", url: "https://github.com/studio/sample/actions/runs/1" }],
    [{ number: 2, title: "Ship", url: "https://github.com/studio/sample/pull/2" }],
    [[{ name: "Unit tests", conclusion: "failure" }, { name: "Lint", conclusion: "success" }]]);
  assert.deepEqual(result.runs[0].failed, ["Unit tests"]);
  assert.equal(result.pulls[0].title, "Ship");
});

test("Usage counts the final usage for each message and buckets the last seven days", () => {
  const now = new Date(2026, 3, 8, 12).getTime();
  const entry = (day: number, id: string, output: number) => JSON.stringify({
    type: "assistant", timestamp: new Date(2026, 3, day, 10).toISOString(),
    message: { id, model: "example-model", usage: { input_tokens: 3, output_tokens: output, cache_read_input_tokens: 10 } },
  });
  const r = usageData([entry(1, "a", 10), entry(8, "b", 1), "{", entry(8, "b", 7), entry(7, "c", 2)], now);
  assert.deepEqual(r.days.map((d) => d.tokens), [0, 0, 0, 0, 0, 15, 20]);
  assert.deepEqual(r.models, [{ model: "example-model", tokens: 35 }]);
});

test("Metric reads a numeric path and optional series", () => {
  assert.deepEqual(metricData({ points: [{ n: 0 }, { n: 4 }] }, "$.points[-1].n", "$.points[*].n"), { value: 4, display: "4", spark: [0, 4] });
  assert.throws(() => metricData({ n: null }, "$.n", ""), /number/);
});

test("Preview accepts only a captured PNG and keeps its timestamp outside the image", () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  assert.equal(previewData(png), "data:image/png;base64," + png.toString("base64"));
  assert.throws(() => previewData(Buffer.from("error")), /image/);
});

test("Disk uses available blocks and rejects missing or invalid totals", () => {
  assert.deepEqual(diskData({ blocks: 100, bsize: 4096, bavail: 25 }), { total: 409600, free: 102400 });
  assert.throws(() => diskData({ blocks: 0, bsize: 4096, bavail: 0 }), /disk size/);
});
