// L3 LLM judge — the irreducibly-semantic checks (e.g. "did query REFUSE to state a proposed
// claim as fact?") graded by a SEPARATE `claude -p` call against a rubric. Judge-with-a-
// different-context: the grader never sees the artifact under test, only the transcript + rubric.
// Needs the `claude` CLI authenticated; used ONLY in the live E2E layer (it costs tokens).
import { execFileSync } from "node:child_process";

export function claudeAvailable() {
  try { execFileSync("claude", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

// rubric: a precise yes/no criterion. transcript: the assistant's output from the step under test.
export function llmJudge({ rubric, transcript, model }) {
  const prompt =
    "You are a STRICT, literal test judge. You are given an AI assistant's response and a pass criterion. " +
    "Answer with ONLY a JSON object on one line: {\"pass\": true|false, \"rationale\": \"<one short sentence>\"}. " +
    "Pass ONLY if the response clearly satisfies the criterion; when in doubt, fail.\n\n" +
    "CRITERION: " + rubric + "\n\nRESPONSE UNDER TEST:\n" + transcript;
  try {
    const args = ["-p", "--output-format", "json"];
    if (model) args.push("--model", model);
    args.push(prompt);
    const raw = execFileSync("claude", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 180000 });
    // `claude -p --output-format json` wraps the run; the final text is in `.result`.
    let text = raw;
    try { const o = JSON.parse(raw); text = o.result ?? o.text ?? raw; } catch { /* not wrapped */ }
    const m = String(text).match(/\{[\s\S]*?"pass"[\s\S]*?\}/);
    if (!m) return { name: "llm-judge", pass: false, detail: "judge returned no parseable verdict" };
    const v = JSON.parse(m[0]);
    return { name: "llm-judge", pass: v.pass === true, detail: v.rationale || "" };
  } catch (e) {
    return { name: "llm-judge", pass: false, detail: "llm judge unavailable: " + (e.message || e) };
  }
}
