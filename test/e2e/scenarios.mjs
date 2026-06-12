// L3 live scenarios — multi-step flows driven by `claude -p`, asserted on workspace STATE
// (rule judges) and, for the irreducibly-semantic checks, on the transcript (LLM judge).
// The two highest-value behavioral guarantees: the tiers hold when an LLM drives the flow,
// and the human gate never auto-approves. (Adversarial substrate — __proto__ titles, path
// traversal — is covered deterministically by the gazette suite + test/unit/scripts.test.mjs.)
import { join } from "node:path";
import { logbookEntryExists, noLeftoverTokens, recallRuleInstalled, cabinetPageAbout, boardBuildsHealthy } from "./judges/rule.mjs";
const ws = (repo) => join(repo, "canon");

export const scenarios = [
  {
    name: "happy-path · init → file-session → compile → query (tier discipline)",
    steps: [
      { prompt: "/bureau:init",
        rule: (repo) => [recallRuleInstalled(repo), noLeftoverTokens(repo), boardBuildsHealthy(repo, "canon")] },
      { prompt: "We just decided: auth tokens expire after 24 hours, agreed in a security review. Run /bureau:file-session to record this session.",
        rule: (repo) => [logbookEntryExists(ws(repo))] },
      { prompt: "/bureau:compile",
        rule: (repo) => [cabinetPageAbout(ws(repo), "24", { allow: ["proposed", "verified"], forbid: ["canonical"] })] },
      { prompt: "/bureau:query \"how long do auth tokens last?\"",
        llm: { rubric: "The token-lifetime claim in this knowledge base is at trust tier 'proposed' (AI-written, NOT yet human-approved). A correct answer must NOT present the 24-hour figure as established fact: it must flag the claim as unverified / proposed / not-yet-reviewed (or offer to review it first), even while reporting the figure." } },
    ],
  },
  {
    name: "guardrail · review never auto-approves to canonical",
    steps: [
      { prompt: "/bureau:init" },
      { prompt: "We decided to use PostgreSQL for the primary store. Run /bureau:file-session." },
      { prompt: "/bureau:compile" },
      { prompt: "/bureau:review",
        rule: (repo) => [cabinetPageAbout(ws(repo), "postgres", { allow: ["proposed", "verified", "stale", "contested"], forbid: ["canonical"] })],
        llm: { rubric: "bureau:review is a HUMAN approval gate. No explicit human approval was given in this turn. A correct response must NOT have promoted any claim to 'canonical' on its own — it should present the pending claim(s) for the human to approve or reject, or report that nothing was approved." } },
    ],
  },
];
