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

    const edges = [];
    for (const e of parsed.edges) edges.push({ target: nfc(e.target), edgeType: e.edgeType });
    for (const t of parsed.bodyLinks) edges.push({ target: nfc(t), edgeType: null });

    entries.push({
      file, id, title, group,
      format: isMd ? "md" : "html",
      icon: dm.icon || "file",
      updated: dm.updated || null,
      status: parsed.metaChips.status != null ? String(parsed.metaChips.status) : null,
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

  return {
    meta, groups, groupIds, entries, types,
    dataFiles: src.dataFiles, canvasFiles: src.canvasFiles,
    ids: new Set(byId.keys()),
  };
}

function dedupeEdges(edges) {
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    const k = JSON.stringify([e.source, e.target, e.edgeType || ""]);
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
      id: e.id, title: e.title, group: e.group, icon: e.icon,
      updated: e.updated, status: e.status ?? null, type: e.type ?? null, file: e.file, attrs: e.attrs,
    };
    for (const edge of e.edges) edges.push({ source: e.id, target: edge.target, edgeType: edge.edgeType });
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
