// derive/backlinks — inverse edge index. Pure function of the model.
// Self-edges ([[A]] inside doc A) are excluded: a doc linking only to itself is not
// "connected" and must still be eligible for the orphan check (grill M12).

export function deriveBacklinks(model) {
  // null-proto: a dangling wiki-link to an inherited key ([[constructor]], [[toString]]) must
  // index as "no such node", not resolve to a prototype member and crash on .includes/.push.
  const inbound = Object.create(null);
  const outbound = Object.create(null);
  for (const id of Object.keys(model.nodes)) {
    inbound[id] = [];
    outbound[id] = [];
  }
  for (const e of model.edges) {
    if (e.source === e.target) continue; // self-edge — not a real link for degree
    if (outbound[e.source] && !outbound[e.source].includes(e.target)) outbound[e.source].push(e.target);
    if (inbound[e.target] && !inbound[e.target].includes(e.source)) inbound[e.target].push(e.source);
  }
  return { inbound, outbound };
}
