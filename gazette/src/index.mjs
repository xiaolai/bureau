// gazette — public module API. The package is detachable (own bin + exports), so its
// programmatic surface should match its CLI capability, not just `build`. This barrel
// re-exports the entry point of every CLI verb; keep it in lockstep with bin/cli.mjs.
//
//   build / serve / watch / open → buildSite, computeHealth
//   audit (health)               → deriveHealth, healthTotal, renderHealthText/Html
//   doctor                       → buildRepairPlan, applySafe, renderRepairText
//   rename                       → planRename, applyRename
//   (programmatic substrate)     → loadCorpus, buildModel, SCHEMA_VERSION

export { buildSite, computeHealth } from "./build.mjs";
export { loadCorpus, buildModel, SCHEMA_VERSION } from "./core/model.mjs";
export { deriveHealth, healthTotal } from "./derive/health.mjs";
export { renderHealthHtml, renderHealthText } from "./render/health-report.mjs";
export { planRename, applyRename } from "./maintain/rename.mjs";
export { buildRepairPlan, applySafe, renderRepairText } from "./maintain/doctor.mjs";
