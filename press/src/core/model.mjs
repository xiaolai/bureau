// core/model — the single read + validate authority (grill H3). loadCorpus does
// the one parse + all validation; buildModel is a pure function over it; the board
// (src/build.mjs) projects from the SAME corpus. No second parser, one identity rule
// (NFC), one validation policy — fail loud at the boundary.

import { readFileSync, existsSync, realpathSync, lstatSync } from "fs";
import { join, sep } from "path";
import { parseHtmlDoc, parseMarkdownDoc } from "./parse.mjs";
import { discover } from "./sources.mjs";
import { loadTypes, typesPlain } from "./types.mjs";
import { nfc } from "../services/i18n.mjs";
import { prettify } from "../shared/prettify.mjs";

export const SCHEMA_VERSION = 1;

// _config.json is now OPTIONAL — groups are derived from folders. When present it
// only provides meta (title/home/etc.) and per-group label/icon overrides.
function readConfig(docsDir) {
  const p = join(docsDir, "_config.json");
  if (!existsSync(p)) return { meta: {}, groups: [] };
  // never read a symlinked config — it could import metadata from outside the content tree
  // (matches the symlink policy on docs/assets). Treat a symlinked _config.json as absent.
  if (lstatSync(p).isSymbolicLink()) return { meta: {}, groups: [] };
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error("_config.json is not valid JSON (" + p + "): " + e.message);
  }
  // valid JSON is not a valid CONFIG — a scalar `meta`, or a `groups` that isn't a list of
  // objects, would sail through here and surface later as an opaque TypeError deep in the model.
  const where = " (" + p + ")";
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("_config.json must be a JSON object" + where);
  const meta = cfg.meta == null ? {} : cfg.meta;
  if (typeof meta !== "object" || Array.isArray(meta)) throw new Error('_config.json: "meta" must be an object' + where);
  const groups = cfg.groups == null ? [] : cfg.groups;
  if (!Array.isArray(groups)) throw new Error('_config.json: "groups" must be an array' + where);
  const seenId = new Set();
  for (const g of groups) {
    if (g === null || typeof g !== "object" || Array.isArray(g)) throw new Error('_config.json: every "groups" entry must be an object' + where);
    // an id is how a group is keyed (cfgById); a missing/non-string/duplicate id silently drops or
    // shadows a group's label/icon override (a no-id entry can target nothing), so reject it loudly.
    // "" is a valid id — it names the root/Overview section — so require a STRING, not truthiness.
    if (typeof g.id !== "string") throw new Error('_config.json: every "groups" entry needs a string "id"' + where);
    if (seenId.has(g.id)) throw new Error('_config.json: duplicate group id "' + g.id + '"' + where);
    seenId.add(g.id);
  }
  return { meta, groups };
}

// a doc's nav section = its TOP-LEVEL folder under the content dir (flat sections:
// deeper subfolders collapse into their top folder). Root files → the "" group.
// A leading NN- / NN_ ordering prefix is stripped from the section id.
function topFolderId(relPath) {
  const i = relPath.indexOf("/");
  if (i < 0) return "";
  return relPath.slice(0, i).replace(/^\d+[-_.]/, "");
}

// Defense in depth (discovery already skips symlinks): before reading a discovered doc,
// confirm its real path is a regular file inside the real content dir — never follow a
// link out of the tree. Returns the verified absolute path.
export function safeDocPath(docsDir, file) {
  const root = realpathSync(docsDir);
  const abs = realpathSync(join(docsDir, file));
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error("doc path escapes content dir: " + file);
  if (!lstatSync(abs).isFile()) throw new Error("doc path is not a regular file: " + file);
  return abs;
}

// Read + validate every doc once. Throws loudly on any boundary violation.
export function loadCorpus({ docsDir, dataDir = null } = {}) {
  if (!existsSync(docsDir)) throw new Error("docs directory not found: " + docsDir + " (run `gazette init`)");
  // The whole reader refuses to follow symlinks out of the content tree (safeDocPath, readConfig,
  // discovery). A symlinked ROOT is the one hole that posture left open — it would let the content
  // dir point anywhere and publish files from outside the project. Close it here, at the entry.
  if (lstatSync(docsDir).isSymbolicLink()) throw new Error("content directory is a symlink (refused): " + docsDir);
  const { meta, groups: cfgGroups } = readConfig(docsDir);
  const cfgById = new Map(cfgGroups.map((g) => [g.id, g])); // optional label/icon overrides

  const src = discover({ docsDir, dataDir });
  const types = loadTypes(src.typesDir, src.typeFiles);
  const files = src.docFiles;

  const entries = [];
  const byId = new Map();
  const byUid = new Map(); // opaque engine identity → file (ADR-0001); distinct from the title-key `id`
  const orderedGroups = []; const groupSeen = new Set(); // nav-section order = first appearance (folder-sorted)
  for (const file of files) {
    const isMd = file.endsWith(".md");
    const raw = readFileSync(safeDocPath(docsDir, file), "utf8");
    let parsed;
    // the parser sees text, not paths — name the offending file, or the author can't find it
    try { parsed = (isMd ? parseMarkdownDoc : parseHtmlDoc)(raw); }
    catch (e) { throw new Error(file + ": " + e.message); }
    const dm = parsed.meta;
    if (dm.title == null || dm.title === "") throw new Error("missing title: " + file + " (add data-title, a frontmatter title, or an <h1>)");
    if (/[[\]|]/.test(String(dm.title))) throw new Error('invalid title (must not contain [ ] |): "' + dm.title + '" (' + file + ")"); // `|` is the wiki-link label delimiter
    const title = String(dm.title);
    const id = nfc(title);
    // "__proto__" is the one title that can't be safely serialized as a JS object-literal key
    // (it becomes a prototype directive and the doc vanishes). It's never a legitimate title —
    // reject it loudly. ("Constructor"/"Prototype" ARE fine: own-property guards handle them.)
    if (id === "__proto__") throw new Error('invalid title "__proto__" (reserved): ' + file);
    if (byId.has(id)) throw new Error('duplicate title (after NFC): "' + title + '" in both ' + byId.get(id) + " and " + file);
    byId.set(id, file);

    // group = explicit data-group override, else the top-level folder (flat sections)
    const group = dm.group != null ? String(dm.group) : topFolderId(file);
    if (!groupSeen.has(group)) { groupSeen.add(group); orderedGroups.push(group); }

    // opaque engine identity (ADR-0001): authored `id:` if present, else a stable title-shim.
    // A shim uid changes on rename; a real authored id does not — so rename-stability is only
    // guaranteed once `id:` is authored (WI-10 stamps them). Distinct from the title-key `id`.
    const uid = dm.id != null && String(dm.id).trim() ? String(dm.id).trim() : "t:" + id;
    if (byUid.has(uid)) throw new Error('duplicate engine id "' + uid + '" in both ' + byUid.get(uid) + " and " + file);
    byUid.set(uid, file);

    // author-anchored spans (ADR-0001): reject duplicate anchors within one doc (ambiguous target)
    const spans = Array.isArray(parsed.spans) ? parsed.spans : [];
    const spanSeen = new Set();
    for (const s of spans) { if (spanSeen.has(s.anchor)) throw new Error('duplicate span anchor "^' + s.anchor + '" in ' + file); spanSeen.add(s.anchor); }

    const edges = [];
    // preserve rests_on's span/because/tracked so the engine can key verdicts on them; other edges
    // carry nulls (harmless). dedupe keys on (source,target,edgeType,span) so two rests_on edges to
    // different spans of one target both survive.
    for (const e of parsed.edges) edges.push({ target: nfc(e.target), edgeType: e.edgeType, span: e.span ?? null, because: e.because ?? null, tracked: e.tracked === true });
    for (const t of parsed.bodyLinks) edges.push({ target: nfc(t), edgeType: null, span: null, because: null, tracked: false });

    // trust falls back to the legacy `status:` until the corpus migrates to `trust:` (WI-10)
    const trust = dm.trust != null ? String(dm.trust) : (parsed.metaChips.status != null ? String(parsed.metaChips.status) : null);

    entries.push({
      file, id, uid, title, group,
      format: isMd ? "md" : "html",
      icon: dm.icon || "file",
      updated: dm.updated || null,
      status: parsed.metaChips.status != null ? String(parsed.metaChips.status) : null,
      trust, freeze: dm.freeze != null ? String(dm.freeze) : null,
      kind: dm.kind != null ? String(dm.kind) : null,
      claim: dm.claim != null ? String(dm.claim) : null,
      spans,
      type: parsed.metaChips.type != null ? String(parsed.metaChips.type) : null, // schema `required: [type]` checks node.type
      attrs: parsed.attrs, edges,
      body: parsed.body, bodyLinks: parsed.bodyLinks.map(nfc),
      metaChips: parsed.metaChips,
    });
  }

  // derive the nav-section list (folder order); _config overrides label/icon only.
  const labelFor = (gid) => {
    const cfg = cfgById.get(gid);
    if (cfg && cfg.label) return cfg.label;
    if (gid === "") return meta.rootLabel || "Overview";
    return prettify(gid);
  };
  const groups = orderedGroups.map((gid) => {
    const g = { id: gid, label: labelFor(gid) };
    const ic = cfgById.get(gid) && cfgById.get(gid).icon;
    if (ic) g.icon = ic;
    return g;
  });
  const groupIds = new Set(orderedGroups);

  // home must resolve (grill H5) — guards the runtime white-screen.
  if (meta.home && !byId.has(nfc(String(meta.home)))) {
    throw new Error('meta.home "' + meta.home + '" resolves to no document (would white-screen the home view)');
  }

  // dual index (ADR-0001): title-key ⇄ opaque uid. The renderer resolves links by title-key; the
  // engine keys everything by uid, so a rename (title-key change) leaves engine identity intact.
  const uidByKey = new Map(entries.map((e) => [e.id, e.uid]));
  const keyByUid = new Map(entries.map((e) => [e.uid, e.id]));

  return {
    meta, groups, groupIds, entries, types, docsDir,
    dataFiles: src.dataFiles, canvasFiles: src.canvasFiles,
    ids: new Set(byId.keys()),
    uidByKey, keyByUid,
    // the sidebar SECTION order the author declared in _config.json `groups[]` (by id, in array
    // order). Empty ⇒ keep the folder/first-appearance order. Applied to the FULL section set
    // (folders + generated Timeline/Health/…) in build.mjs, so any section is positionable by id.
    groupOrder: cfgGroups.map((g) => g.id),
  };
}

// Order a section list by an authored id order (stable): listed ids first, in `order`; unlisted
// keep their original relative order after. Empty order ⇒ unchanged (current folder behavior).
export function orderGroups(groups, order) {
  if (!Array.isArray(order) || !order.length) return groups;
  const idx = new Map(order.map((id, i) => [id, i]));
  const rank = (g) => (idx.has(g.id) ? idx.get(g.id) : order.length + 1);
  return groups.map((g, i) => ({ g, i })).sort((a, b) => (rank(a.g) - rank(b.g)) || (a.i - b.i)).map((x) => x.g);
}

function dedupeEdges(edges) {
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    // include span, because, AND tracked so two rests_on edges that differ in any of them both
    // survive — dropping one would silently lose an authored `because` (or a tracked/untracked
    // distinction) the verdict key depends on.
    const k = JSON.stringify([e.source, e.target, e.edgeType || "", e.span || "", e.because || "", e.tracked ? 1 : 0]);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

// Pure: corpus → canonical model. Time-independent (byte-stable). `corpus` may be
// passed to share the single read with the board; else it is loaded here.
export function buildModel({ docsDir, corpus } = {}) {
  const c = corpus || loadCorpus({ docsDir });
  const nodes = Object.create(null); // keyed by user-authored title — null proto so "__proto__" can't pollute
  const edges = [];
  for (const e of c.entries) {
    nodes[e.id] = {
      id: e.id, uid: e.uid, title: e.title, group: e.group, icon: e.icon,
      updated: e.updated, status: e.status ?? null,
      trust: e.trust ?? null, freeze: e.freeze ?? null, kind: e.kind ?? null, claim: e.claim ?? null,
      spans: e.spans || [],
      type: e.type ?? null, file: e.file, attrs: e.attrs,
    };
    for (const edge of e.edges) edges.push({ source: e.id, sourceUid: e.uid, target: edge.target, edgeType: edge.edgeType, span: edge.span ?? null, because: edge.because ?? null, tracked: edge.tracked === true });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: c.meta,
    nodeCount: Object.keys(nodes).length,
    nodes,
    edges: dedupeEdges(edges),
    types: typesPlain(c.types || {}),
    data: { files: c.dataFiles || [], canvas: c.canvasFiles || [] },
  };
}
