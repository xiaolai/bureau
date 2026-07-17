// gazette — public module API. The package is detachable (own bin + exports), so its
// programmatic surface matches its CLI capability where one exists. This barrel re-exports
// the FUNCTIONS behind the verbs; the pure-CLI verbs (serve / watch / open / init / new) are
// interactive wrappers around buildSite with no separate programmatic entry point.
//
//   build (+ serve/watch/open build via)  → buildSite, computeHealth
//   audit (health)                        → deriveHealth, healthTotal, renderHealthText/Html
//   doctor                                → buildRepairPlan, applySafe, renderRepairText
//   rename                                → planRename, applyRename
//   (programmatic substrate)              → loadCorpus, buildModel, SCHEMA_VERSION

export { buildSite, computeHealth } from "./build.mjs";
export { loadCorpus, buildModel, SCHEMA_VERSION } from "./core/model.mjs";
export { deriveHealth, healthTotal } from "./derive/health.mjs";
export { renderHealthHtml, renderHealthText } from "./render/health-report.mjs";
export { planRename, applyRename } from "./maintain/rename.mjs";
export { buildRepairPlan, applySafe, renderRepairText } from "./maintain/doctor.mjs";
