import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The setting that stops a slow turn from being run twice.
 *
 * ── Why a config file is worth a test ───────────────────────────────────────
 * This one is load-bearing and invisible. eve's local world delivers a queued
 * turn by POSTing it to the agent and awaiting the whole response, with undici
 * timeouts that default to 30 seconds on headers and body. A turn that takes
 * longer has its delivery abandoned and REDELIVERED, and the workflow SDK
 * re-executes it while the first execution is still running — two model runs and
 * two different answers to one question, which is what happened on 12 August
 * 2026 at 11:53 UTC.
 *
 * Nothing in the codebase references these names except docker-compose.yml, so
 * a future edit that drops them restores the bug silently and no other test
 * notices. This is that notice.
 *
 * The guard in `agent/lib/delivery-guard.ts` is the other half: it makes a
 * redelivery harmless. This makes it rare. Neither replaces the other — removing
 * this and keeping the guard means paying for every long turn twice, and the
 * user seeing one answer while the bill shows two.
 */

const compose = readFileSync(
  fileURLToPath(new URL("../docker-compose.yml", import.meta.url)),
  "utf8",
);

/** The floor: comfortably above the slowest observed turn (a ~2 min render). */
const FLOOR_MS = 300_000;

/** The runtime's own default, which is the value that caused the incident. */
const RUNTIME_DEFAULT_MS = 30_000;

for (const name of ["WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS", "WORKFLOW_LOCAL_BODY_TIMEOUT_MS"]) {
  test(`${name} is set for the agent, above any real turn`, () => {
    const declared = compose.match(new RegExp(`^\\s*${name}:\\s*"([^"]*)"`, "m"));
    assert.ok(declared, `${name} must be set on the agent service in docker-compose.yml`);

    // `${VAR:-600000}` — the default is what runs unless an operator overrides it.
    const fallback = declared[1].match(/:-(\d+)\}/);
    assert.ok(fallback, `${name} must carry a numeric default, not an empty one`);

    const ms = Number(fallback[1]);
    assert.ok(
      ms >= FLOOR_MS,
      `${name} is ${ms}ms; below ${FLOOR_MS}ms a long turn is redelivered and executed twice`,
    );
    assert.notEqual(ms, RUNTIME_DEFAULT_MS);
  });
}
