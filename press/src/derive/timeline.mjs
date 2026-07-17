// derive/timeline — turn data/* into generated timeline docs. The derivation seam
// for data-driven views (PRD: generalize the MVP cold-events to data/*). Currently
// supports the cold-events format (data/cold-events.md); add formats here.
import { existsSync, readFileSync, lstatSync } from "fs";
import { join } from "path";
import { parseCold, coldEventDocs } from "../cold-events.mjs";

export function deriveTimeline(dataDir) {
  const docs = Object.create(null); // generated ids derive from data — null proto, same as the board
  let count = 0;
  const coldPath = join(dataDir, "cold-events.md");
  // require a REGULAR file: a symlink could read outside the tree (as sources.mjs guards), and a
  // directory/FIFO/device named cold-events.md would crash or block the build in readFileSync.
  // isFile() is false for all of those AND for a symlink (lstat doesn't follow), so it's the one check.
  let st = null; try { st = lstatSync(coldPath); } catch { st = null; }
  if (st && st.isFile()) {
    const events = parseCold(readFileSync(coldPath, "utf8"));
    if (events.length) { Object.assign(docs, coldEventDocs(events)); count = events.length; }
  }
  return { docs, count };
}
