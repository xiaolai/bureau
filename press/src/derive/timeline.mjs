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
  // skip a symlinked cold-events.md (sources.mjs skips symlinks for discovery; this direct
  // read must honor the same policy so timeline data can't be pulled from outside the tree).
  if (existsSync(coldPath) && !lstatSync(coldPath).isSymbolicLink()) {
    const events = parseCold(readFileSync(coldPath, "utf8"));
    if (events.length) { Object.assign(docs, coldEventDocs(events)); count = events.length; }
  }
  return { docs, count };
}
