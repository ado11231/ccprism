// Turns a real session log into a safe test fixture.
//
//   node scripts/scrub.mjs input.jsonl output.jsonl
//
// Every string value is replaced with a placeholder unless its key is
// on the allowlist below. Structure, uuids, timestamps, model ids, and
// usage numbers survive untouched, so the parser sees the exact shape
// of a real session while no conversation content leaves the machine.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Keys whose string values carry no user content.
const SAFE_KEYS = new Set([
  "type",
  "subtype",
  "uuid",
  "parentUuid",
  "logicalParentUuid",
  "leafUuid",
  "sessionId",
  "session_id",
  "requestId",
  "promptId",
  "timestamp",
  "version",
  "model",
  "id",
  "role",
  "name",
  "tool_use_id",
  "stop_reason",
  "stop_sequence",
  "service_tier",
  "level",
  "userType",
  "entrypoint",
  "speed",
  "inference_geo",
  "operation",
  "trigger",
  "status",
]);

const PLACEHOLDER = "[scrubbed]";

// A stand in for lines that were not valid json in the original file.
// The broken shape is the point, the content is not.
const MALFORMED_PLACEHOLDER = "{ this line was malformed in the original";

export function scrubValue(value, key) {
  if (typeof value === "string") {
    return key !== undefined && SAFE_KEYS.has(key) ? value : PLACEHOLDER;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, undefined));
  }
  if (typeof value === "object" && value !== null) {
    const result = {};
    let pathKeys = 0;
    for (const [childKey, childValue] of Object.entries(value)) {
      // Some objects use file paths as keys. Structural keys never
      // contain a slash, so path like keys are user content.
      if (childKey.includes("/") || childKey.includes("\\")) {
        pathKeys += 1;
        result[`[scrubbed-key-${pathKeys}]`] = scrubValue(childValue, undefined);
      } else {
        result[childKey] = scrubValue(childValue, childKey);
      }
    }
    return result;
  }
  return value;
}

export function scrubLine(text) {
  if (text.trim() === "") return text;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return MALFORMED_PLACEHOLDER;
  }
  return JSON.stringify(scrubValue(parsed, undefined));
}

function main() {
  const [input, output] = process.argv.slice(2);
  if (input === undefined || output === undefined) {
    console.error("usage: node scripts/scrub.mjs input.jsonl output.jsonl");
    process.exit(1);
  }
  const lines = readFileSync(input, "utf8").split("\n");
  const scrubbed = lines.map((line) => scrubLine(line));
  writeFileSync(output, scrubbed.join("\n"));
  console.log(`scrubbed ${lines.length} lines into ${output}`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
