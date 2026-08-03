// The board tier is the decision-log PROJECTION, not authored `status:` (ADR-0004 Decision C). This
// exercises the exact chain build.mjs's canvas uses — liveFreshness.authority → the effective-canonical
// set → renderGraphSvg — so a page approved in the log renders `canonical` even though its authored
// `status:` still records the `proposed` intent, and a STALE approval drops back out of the tier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorpus, buildModel } from "../src/core/model.mjs";
import { liveFreshness } from "../src/engine/live.mjs";
import { deriveLayout } from "../src/derive/layout.mjs";
import { renderGraphSvg } from "../src/render/graph-svg.mjs";
import { scan } from "../src/engine/scan.mjs";
import { appendEvent, logPath } from "../src/engine/log.mjs";
import { reviewDigest } from "../src/engine/review-digest.mjs";

// Replicates build.mjs's canvasState tier + flag derivation, then renders the near tier.
function nearTier(dir) {
  const corpus = loadCorpus({ docsDir: dir });
  const model = buildModel({ corpus });
  const fresh = liveFreshness({ corpus, docsDir: dir, model });
  const flagByPage = new Map();
  for (const r of fresh.authority?.unauthorized || []) flagByPage.set(r.page, "unauthorized");
  for (const r of fresh.authority?.unbacked || []) flagByPage.set(r.page, "unbacked");
  for (const r of fresh.authority?.stale || []) flagByPage.set(r.page, "stale");
  const staleUids = new Set((fresh.authority?.stale || []).map((r) => r.uid));
  const effCanon = new Set((fresh.authority?.canonical || []).filter((r) => r.authorized && !staleUids.has(r.uid)).map((r) => r.uid));
  const state = {};
  for (const key of Object.keys(model.nodes)) {
    const n = model.nodes[key];
    state[key] = { freshness: fresh.byKey.get(key) || "current", trust: effCanon.has(n.uid) ? "canonical" : (n.trust || n.status || null), flag: flagByPage.get(key) || null };
  }
  return renderGraphSvg(deriveLayout(model), model, state).split("lod--near")[1] || "";
}
function fixture(t, body) {
  const root = mkdtempSync(join(tmpdir(), "wb-boardtier-"));
  const dir = join(root, "canon"); mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(dir, "p.md"), body);
  return dir;
}
const approve = (dir) =>
  appendEvent(logPath(dir), { type: "approve", id: "ttl", by: "human", hash: reviewDigest({ raw: readFileSync(join(dir, "p.md"), "utf8"), uid: "ttl", title: "Token TTL" }) });

test("board tier: a log-approved page authored `proposed` renders CANONICAL on the graph (Decision C)", (t) => {
  const dir = fixture(t, "---\nid: ttl\ntitle: Token TTL\nstatus: proposed\n---\n# Token TTL\nbody ^t\n");
  scan({ docsDir: dir });
  approve(dir);
  const near = nearTier(dir);
  assert.match(near, /canonical/, "the graph shows the EFFECTIVE canonical tier from the log");
  assert.doesNotMatch(near, /proposed/, "not the authored `proposed` intent");
});

test("board tier: an approval staled by an edit drops out of the effective tier (+ stale flag)", (t) => {
  const dir = fixture(t, "---\nid: ttl\ntitle: Token TTL\nstatus: proposed\n---\n# Token TTL\noriginal ^t\n");
  scan({ docsDir: dir });
  approve(dir);
  // edit the body → the content-bound approval no longer covers it → not effectively canonical
  writeFileSync(join(dir, "p.md"), "---\nid: ttl\ntitle: Token TTL\nstatus: proposed\n---\n# Token TTL\nEDITED ^t\n");
  const near = nearTier(dir);
  assert.doesNotMatch(near, /canonical/, "a stale approval is not effectively canonical");
  assert.match(near, /stale/, "and the node carries the stale trust flag");
});
