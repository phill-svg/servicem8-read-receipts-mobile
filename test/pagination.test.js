import { test } from "node:test";
import assert from "node:assert/strict";
import { listRecentEmails } from "../src/servicem8-api.js";

// ServiceM8 caps /email.json at 1000 records and pages with an x-next-cursor
// header; $top and $skip are accepted and silently ignored (probed live
// 2026-09-06), so without this walk the poller would sit on exactly 1000
// records looking healthy while never seeing the 1001st.
const env = {
  DB: {
    prepare: () => ({
      bind: () => ({
        async first() {
          return { access_token: "tok", access_token_expires_at: Date.now() + 3600_000 };
        },
      }),
    }),
  },
};

function page(rows, nextCursor) {
  const headers = { "Content-Type": "application/json" };
  if (nextCursor) headers["x-next-cursor"] = nextCursor;
  return new Response(JSON.stringify(rows), { status: 200, headers });
}

const rowsNamed = (prefix, n) => Array.from({ length: n }, (_, i) => ({ uuid: `${prefix}-${i}` }));

async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return handler(String(url), calls.length);
  };
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = real;
  }
}

test("follows x-next-cursor across pages and concatenates them", async () => {
  const { result, calls } = await withFetch(
    (_url, n) => (n === 1 ? page(rowsNamed("a", 1000), "cur1") : n === 2 ? page(rowsNamed("b", 1000), "cur2") : page(rowsNamed("c", 7))),
    () => listRecentEmails(env, "t1")
  );

  assert.equal(result.length, 2007);
  assert.equal(calls.length, 3);
  assert.equal(calls[0], "https://api.servicem8.com/api_1.0/email.json");
  assert.equal(calls[1], "https://api.servicem8.com/api_1.0/email.json?cursor=cur1");
  assert.equal(calls[2], "https://api.servicem8.com/api_1.0/email.json?cursor=cur2");
});

test("makes exactly one request when no cursor header comes back", async () => {
  // The safety property: if ServiceM8 stops sending the header, this degrades
  // to the previous unpaged behaviour rather than misbehaving.
  const { result, calls } = await withFetch(() => page(rowsNamed("a", 12)), () => listRecentEmails(env, "t1"));

  assert.equal(result.length, 12);
  assert.deepEqual(calls, ["https://api.servicem8.com/api_1.0/email.json"]);
});

test("stops instead of looping when the server repeats a cursor", async () => {
  const { result, calls } = await withFetch(() => page(rowsNamed("a", 1000), "same"), () => listRecentEmails(env, "t1"));

  assert.equal(calls.length, 2, "follows it once, then recognises the repeat");
  assert.equal(result.length, 2000);
});

test("stops on an empty page even if a cursor is offered", async () => {
  const { calls } = await withFetch(
    (_url, n) => (n === 1 ? page(rowsNamed("a", 1000), "cur1") : page([], "cur2")),
    () => listRecentEmails(env, "t1")
  );

  assert.equal(calls.length, 2);
});

test("a cursor is url-encoded into the query string", async () => {
  const { calls } = await withFetch(
    (_url, n) => (n === 1 ? page(rowsNamed("a", 1), "a b&c=d") : page([])),
    () => listRecentEmails(env, "t1")
  );

  assert.equal(calls[1], "https://api.servicem8.com/api_1.0/email.json?cursor=a%20b%26c%3Dd");
});

test("the walk is bounded, so an endless cursor chain can't spin the Worker", async () => {
  let n = 0;
  const { calls } = await withFetch(() => page(rowsNamed(`p${n++}`, 1000), `cur${n}`), () => listRecentEmails(env, "t1"));

  assert.equal(calls.length, 20, "MAX_EMAIL_PAGES");
});
