import { test } from "node:test";
import assert from "node:assert/strict";

import { createSessionLifecycle } from "../src/lifecycle.js";

/**
 * The browser's lifecycle, exercised without a browser.
 *
 * The launcher is injected for the same reason it is in `self-note.js` and
 * `media.js`: the interesting cases here are all failure cases, and a test that
 * needs Chromium to fail on demand cannot be written deterministically.
 *
 * The case that matters most is the second one. A cached rejected promise is
 * invisible in normal operation — it only appears once something has already
 * gone wrong, and then it converts one transient failure into a dead service.
 */

/** A launcher whose outcome the test decides, and which counts its calls. */
function launcher(outcomes) {
  let call = 0;
  const fn = async () => {
    const outcome = outcomes[Math.min(call, outcomes.length - 1)];
    call++;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { fn, calls: () => call };
}

test("acquire: concurrent callers share one launch", async () => {
  const { fn, calls } = launcher(["page"]);
  const session = createSessionLifecycle({ launch: fn });

  const all = await Promise.all([session.acquire(), session.acquire(), session.acquire()]);

  assert.deepEqual(all, ["page", "page", "page"]);
  assert.equal(calls(), 1, "three callers during startup must not launch three browsers");
});

test("acquire: a failed launch is retried by the next caller, not cached forever", async () => {
  const { fn, calls } = launcher([new Error("Chromium died"), "page"]);
  const session = createSessionLifecycle({ launch: fn });

  await assert.rejects(session.acquire(), /Chromium died/);

  // The whole point: the failure must not become permanent. Before this was
  // fixed, `launching ??= launch()` held the rejected promise and every later
  // call re-awaited it, so one bad launch wedged the bridge until a restart.
  assert.equal(await session.acquire(), "page");
  assert.equal(calls(), 2);
});

test("acquire: every waiter on a failed launch sees the failure", async () => {
  const { fn, calls } = launcher([new Error("no display"), "page"]);
  const session = createSessionLifecycle({ launch: fn });

  const results = await Promise.allSettled([session.acquire(), session.acquire()]);

  assert.deepEqual(
    results.map((r) => r.status),
    ["rejected", "rejected"],
    "a caller must never be handed a half-launched session",
  );
  assert.equal(calls(), 1, "waiters share the attempt they joined");
});

test("acquire: a live session is reused rather than relaunched", async () => {
  const { fn, calls } = launcher(["page"]);
  const session = createSessionLifecycle({ launch: fn, alive: () => true });

  await session.acquire();
  await session.acquire();

  assert.equal(calls(), 1);
});

test("acquire: a session that is no longer alive is relaunched", async () => {
  const { fn, calls } = launcher(["first", "second"]);
  let alive = true;
  const session = createSessionLifecycle({ launch: fn, alive: () => alive });

  assert.equal(await session.acquire(), "first");
  alive = false;
  assert.equal(await session.acquire(), "second", "a closed page must not be handed out");
  assert.equal(calls(), 2);
});

test("lost: a disconnected browser relaunches on the next acquire", async () => {
  const { fn, calls } = launcher(["first", "second"]);
  const session = createSessionLifecycle({ launch: fn, alive: () => true });

  await session.acquire();
  session.lost("browser disconnected");

  assert.equal(await session.acquire(), "second");
  assert.equal(calls(), 2);
});

test("health: never launched reads as starting, not as broken", async () => {
  const session = createSessionLifecycle({ launch: async () => "page" });

  // This distinction gates the agent container: compose waits on
  // `service_healthy`, and the browser is only launched on the first request.
  // Reporting a boot-time absence as a fault would deadlock startup.
  assert.equal(session.health().state, "starting");
  assert.equal(session.health().ok, true);
});

test("health: a live session reads as up", async () => {
  const session = createSessionLifecycle({ launch: async () => "page", alive: () => true });
  await session.acquire();

  const health = session.health();
  assert.equal(health.state, "up");
  assert.equal(health.ok, true);
  assert.equal(health.launches, 1);
});

test("health: a failed launch reads as down, with the reason and a count", async () => {
  const { fn } = launcher([new Error("Executable doesn't exist")]);
  const session = createSessionLifecycle({ launch: fn, now: () => 1000 });

  await assert.rejects(session.acquire());

  const health = session.health();
  assert.equal(health.state, "down");
  assert.equal(health.ok, false, "this is what makes the container healthcheck mean something");
  assert.equal(health.failures, 1);
  assert.match(health.lastError, /Executable doesn't exist/);
  assert.equal(health.lastFailureAt, 1000);
});

test("health: a recovered session stops reporting down", async () => {
  const { fn } = launcher([new Error("transient"), "page"]);
  const session = createSessionLifecycle({ launch: fn, alive: () => true });

  await assert.rejects(session.acquire());
  assert.equal(session.health().state, "down");

  await session.acquire();
  const health = session.health();
  assert.equal(health.state, "up");
  assert.equal(health.ok, true);
  // Kept deliberately: a bridge that recovered after three failed launches is
  // not the same as one that came up cleanly, and only the count says so.
  assert.equal(health.failures, 1, "the failure history survives the recovery");
});

test("health: reports no error text once recovered", async () => {
  const { fn } = launcher([new Error("secret path /data/profile"), "page"]);
  const session = createSessionLifecycle({ launch: fn, alive: () => true });

  await assert.rejects(session.acquire());
  await session.acquire();

  assert.equal(session.health().lastError, undefined);
});

test("reset: forgets the session without counting a failure", async () => {
  const { fn, calls } = launcher(["first", "second"]);
  const session = createSessionLifecycle({ launch: fn, alive: () => true });

  await session.acquire();
  await session.reset();

  assert.equal(session.health().state, "starting");
  assert.equal(session.health().failures, 0, "a deliberate shutdown is not a fault");
  assert.equal(await session.acquire(), "second");
  assert.equal(calls(), 2);
});

test("acquire: a launch in flight is not disturbed by alive() on a stale handle", async () => {
  // `alive` is asked about the CURRENT handle. While a launch is in flight there
  // is no current handle, and calling the predicate on the previous one would
  // relaunch on top of a launch already running.
  let resolveLaunch;
  const launch = () => new Promise((r) => (resolveLaunch = r));
  const session = createSessionLifecycle({
    launch,
    alive: () => {
      throw new Error("alive() must not be consulted mid-launch");
    },
  });

  const first = session.acquire();
  const second = session.acquire();
  resolveLaunch("page");

  assert.deepEqual(await Promise.all([first, second]), ["page", "page"]);
});
