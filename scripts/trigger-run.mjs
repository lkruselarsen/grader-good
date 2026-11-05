/**
 * Dev helper: trigger a deployed Trigger.dev task and wait for the result,
 * using the CLI login (no secret key needed in env).
 * Run: node scripts/trigger-run.mjs <taskId> '<json payload>' [prod|dev]
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [taskId, payloadJson = "{}", env = "prod"] = process.argv.slice(2);
const PROJECT = "proj_vucaytuhpumjnzjistwk";
const API = "https://api.trigger.dev";

const configPath = [
  join(homedir(), "Library/Preferences/trigger/config.json"),
  join(homedir(), ".config/trigger/config.json"),
].find((p) => {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
});
const config = JSON.parse(readFileSync(configPath, "utf8"));
const pat = (config.profiles?.default ?? Object.values(config.profiles)[0]).accessToken;

const envRes = await fetch(`${API}/api/v1/projects/${PROJECT}/${env}`, {
  headers: { Authorization: `Bearer ${pat}` },
});
const { apiKey } = await envRes.json();
if (!apiKey) throw new Error(`Could not get the ${env} API key (${envRes.status})`);

const trig = await fetch(`${API}/api/v1/tasks/${taskId}/trigger`, {
  method: "POST",
  headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
  body: JSON.stringify({ payload: JSON.parse(payloadJson) }),
});
const { id } = await trig.json();
console.log("run", id);
const t0 = Date.now();
for (;;) {
  const r = await (await fetch(`${API}/api/v3/runs/${id}`, { headers: { Authorization: `Bearer ${apiKey}` } })).json();
  if (["COMPLETED", "FAILED", "CRASHED", "SYSTEM_FAILURE", "CANCELED", "TIMED_OUT", "EXPIRED"].includes(r.status)) {
    console.log(r.status, `${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify(r.output ?? r.error ?? null).slice(0, 600));
    break;
  }
  await new Promise((res) => setTimeout(res, 3000));
}
