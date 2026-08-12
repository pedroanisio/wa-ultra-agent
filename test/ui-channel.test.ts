import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The gate in front of the whole UI.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `routeAuth` does not throw when a caller fails the walk. It RETURNS the 401
 * response object, and returns an auth context when the caller is admitted. A
 * guard written as try/catch around it therefore never rejects anybody: the
 * refusal arrives as an ordinary return value, the catch never runs, and every
 * route behind it — the queue, the send, the file writer — is open to anyone
 * who can reach the port.
 *
 * That is precisely the failure that cannot be noticed by using the page: a
 * browser with the right password sees exactly what a browser with none does.
 * So it is asserted here, against eve's real implementation.
 */

process.env.WA_UI_PASSWORD ??= "test-password";
process.env.WA_UI_USERNAME ??= "me";

const { authFailure } = await import("../agent/channels/ui.ts");

function basic(username: string, password: string): Request {
  const token = Buffer.from(`${username}:${password}`).toString("base64");
  return new Request("http://agent.local/ui", { headers: { authorization: `Basic ${token}` } });
}

test("a request with no credentials is refused", async () => {
  const refusal = await authFailure(new Request("http://agent.local/ui"));
  assert.ok(refusal instanceof Response, "an anonymous request must not be admitted");
  assert.equal(refusal!.status, 401);
});

test("the refusal carries a Basic challenge, so a browser can ask for the password", async () => {
  const refusal = await authFailure(new Request("http://agent.local/ui"));
  assert.match(refusal!.headers.get("www-authenticate") ?? "", /^Basic/);
});

test("the wrong password is refused", async () => {
  const refusal = await authFailure(basic("me", "not-the-password"));
  assert.ok(refusal instanceof Response);
  assert.equal(refusal!.status, 401);
});

test("the wrong username is refused", async () => {
  const refusal = await authFailure(basic("someone-else", "test-password"));
  assert.ok(refusal instanceof Response);
});

test("a bearer token is not a way in — this walk is Basic only", async () => {
  const refusal = await authFailure(
    new Request("http://agent.local/ui", { headers: { authorization: "Bearer test-password" } }),
  );
  assert.ok(refusal instanceof Response);
});

test("the right credentials are admitted", async () => {
  assert.equal(await authFailure(basic("me", "test-password")), null);
});
