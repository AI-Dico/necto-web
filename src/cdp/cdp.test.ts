//
// Copyright (c) 2026 AI-Dico
//
// Run with `node --test src/cdp/*.test.ts` (Node 22.18+ strips the types).

import assert from "node:assert/strict";
import test from "node:test";

import { consoleEntry, formatRemoteObject } from "./console.ts";
import { curlCommand, describeURL, NetworkLog } from "./network.ts";
import { DISCOVERY_COMMAND, panelSocketURL, parsePort, parseTargets } from "./targets.ts";

test("a request becomes one record that finishes with its size and duration", () => {
  const log = new NetworkLog();
  log.apply("Network.requestWillBeSent", {
    requestId: "1",
    timestamp: 100,
    wallTime: 1_700_000_000,
    type: "Fetch",
    request: { url: "https://api.example.com/posts?page=2", method: "POST", headers: { A: "1" }, postData: "{}" },
  });
  log.apply("Network.responseReceived", {
    requestId: "1",
    response: { status: 201, mimeType: "application/json", headers: { "content-type": "application/json" } },
  });
  const changed = log.apply("Network.loadingFinished", { requestId: "1", timestamp: 100.25, encodedDataLength: 512 });

  assert.equal(changed, "1");
  const record = log.records.get("1");
  assert.ok(record);
  assert.equal(record.state, "finished");
  assert.equal(record.statusCode, 201);
  assert.equal(record.responseByteCount, 512);
  assert.equal(record.durationMilliseconds, 250);
  assert.equal(record.startedAtMilliseconds, 1_700_000_000_000);
  assert.equal(record.name, "posts?page=2");
  assert.equal(record.host, "api.example.com");
  assert.equal(record.requestBody, "{}");
  assert.equal(record.resourceType, "Fetch");
});

test("a redirect keeps the first hop as its own finished record", () => {
  const log = new NetworkLog();
  log.apply("Network.requestWillBeSent", { requestId: "7", timestamp: 1, request: { url: "http://a.test/old", method: "GET" } });
  log.apply("Network.requestWillBeSent", {
    requestId: "7",
    timestamp: 1.1,
    redirectResponse: { status: 301, headers: { Location: "http://a.test/new" } },
    request: { url: "http://a.test/new", method: "GET" },
  });

  assert.equal(log.records.size, 2);
  const hop = [...log.records.values()].find((record) => record.id !== "7");
  assert.ok(hop);
  assert.equal(hop.statusCode, 301);
  assert.equal(hop.state, "finished");
  assert.equal(hop.redirectedTo, "http://a.test/new");
  assert.equal(log.records.get("7")?.url, "http://a.test/new");
  assert.equal(log.records.get("7")?.state, "pending");
});

test("a failed load says why, and canceled ones say so", () => {
  const log = new NetworkLog();
  log.apply("Network.requestWillBeSent", { requestId: "2", timestamp: 5, request: { url: "https://x.invalid/", method: "GET" } });
  log.apply("Network.loadingFailed", { requestId: "2", timestamp: 5.007, errorText: "net::ERR_NAME_NOT_RESOLVED", canceled: true });

  const record = log.records.get("2");
  assert.equal(record?.state, "failed");
  assert.equal(record?.errorSummary, "net::ERR_NAME_NOT_RESOLVED (canceled)");
  assert.equal(Math.round(record?.durationMilliseconds ?? 0), 7);
});

test("events for unknown requests and other domains change nothing", () => {
  const log = new NetworkLog();
  assert.equal(log.apply("Network.loadingFinished", { requestId: "nope" }), null);
  assert.equal(log.apply("Page.loadEventFired", {}), null);
  assert.equal(log.records.size, 0);
});

test("describeURL names data URLs and unparsable input without throwing", () => {
  assert.equal(describeURL("data:image/png;base64,AAAA").host, "data");
  assert.deepEqual(describeURL("not a url"), { name: "not a url", host: "" });
  assert.equal(describeURL("https://example.com/").name, "example.com");
});

test("curlCommand quotes single quotes and skips pseudo headers", () => {
  const log = new NetworkLog();
  log.apply("Network.requestWillBeSent", {
    requestId: "3",
    timestamp: 1,
    request: { url: "https://e.test/q", method: "PUT", headers: { ":authority": "e.test", X: "it's" }, postData: "a'b" },
  });
  const record = log.records.get("3");
  assert.ok(record);
  assert.equal(curlCommand(record), `curl 'https://e.test/q' -X 'PUT' -H 'X: it'\\''s' --data-raw 'a'\\''b'`);
});

test("curlCommand quotes a page-controlled method", () => {
  const log = new NetworkLog();
  log.apply("Network.requestWillBeSent", {
    requestId: "m",
    timestamp: 1,
    request: { url: "https://e.test/", method: "X`pwd`", headers: {} },
  });
  const record = log.records.get("m");
  assert.ok(record);
  assert.equal(curlCommand(record), "curl 'https://e.test/' -X 'X`pwd`'");
});

test("a redirect hop never offers the final hop's body", () => {
  const log = new NetworkLog();
  log.apply("Network.requestWillBeSent", { requestId: "r", timestamp: 1, request: { url: "http://a.test/old", method: "GET" } });
  log.apply("Network.requestWillBeSent", {
    requestId: "r",
    timestamp: 2,
    redirectResponse: { status: 302 },
    request: { url: "http://a.test/new", method: "GET" },
  });
  const hop = [...log.records.values()].find((record) => record.id !== "r");
  assert.equal(hop?.bodyUnavailable, true);
  assert.equal(log.records.get("r")?.bodyUnavailable, undefined);
});

test("ExtraInfo replaces the cached status with the wire status, in either order", () => {
  const before = new NetworkLog();
  before.apply("Network.requestWillBeSent", { requestId: "a", timestamp: 1, request: { url: "https://e.test/a", method: "GET" } });
  before.apply("Network.responseReceivedExtraInfo", { requestId: "a", statusCode: 304, headers: { etag: "x" } });
  before.apply("Network.responseReceived", { requestId: "a", hasExtraInfo: true, response: { status: 200, headers: { "content-type": "text/plain" } } });
  assert.equal(before.records.get("a")?.statusCode, 304);
  assert.deepEqual(before.records.get("a")?.responseHeaders, { etag: "x" });

  const after = new NetworkLog();
  after.apply("Network.requestWillBeSent", { requestId: "b", timestamp: 1, request: { url: "https://e.test/b", method: "GET" } });
  after.apply("Network.responseReceived", { requestId: "b", hasExtraInfo: true, response: { status: 200, headers: {} } });
  assert.equal(after.apply("Network.responseReceivedExtraInfo", { requestId: "b", statusCode: 304, headers: { etag: "y" } }), "b");
  assert.equal(after.records.get("b")?.statusCode, 304);
});

test("a late ExtraInfo for a redirect hop lands on that hop, not the next", () => {
  const log = new NetworkLog();
  log.apply("Network.requestWillBeSent", { requestId: "r", timestamp: 1, request: { url: "http://a.test/old", method: "GET" } });
  log.apply("Network.requestWillBeSent", {
    requestId: "r",
    timestamp: 2,
    redirectHasExtraInfo: true,
    redirectResponse: { status: 302, headers: {} },
    request: { url: "http://a.test/new", method: "GET" },
  });
  log.apply("Network.responseReceived", { requestId: "r", hasExtraInfo: true, response: { status: 200, headers: { a: "final" } } });
  // Both ExtraInfos arrive late, in order: the hop's first, then the final response's.
  log.apply("Network.responseReceivedExtraInfo", { requestId: "r", statusCode: 302, headers: { location: "/new" } });
  log.apply("Network.responseReceivedExtraInfo", { requestId: "r", statusCode: 200, headers: { a: "wire" } });

  const hop = [...log.records.values()].find((record) => record.id !== "r");
  assert.equal(hop?.statusCode, 302);
  assert.deepEqual(hop?.responseHeaders, { location: "/new" });
  assert.equal(log.records.get("r")?.statusCode, 200);
  assert.deepEqual(log.records.get("r")?.responseHeaders, { a: "wire" });
});

test("request ExtraInfo is kept whether it comes before or after the request", () => {
  const early = new NetworkLog();
  early.apply("Network.requestWillBeSentExtraInfo", { requestId: "e", headers: { cookie: "s=1" } });
  early.apply("Network.requestWillBeSent", { requestId: "e", timestamp: 1, request: { url: "https://e.test/", method: "GET", headers: {} } });
  assert.deepEqual(early.records.get("e")?.requestHeaders, { cookie: "s=1" });

  const late = new NetworkLog();
  late.apply("Network.requestWillBeSent", { requestId: "l", timestamp: 1, request: { url: "https://e.test/", method: "GET", headers: {} } });
  assert.equal(late.apply("Network.requestWillBeSentExtraInfo", { requestId: "l", headers: { cookie: "s=2" } }), "l");
  assert.deepEqual(late.records.get("l")?.requestHeaders, { cookie: "s=2" });
});

test("a CORS failure keeps the status and headers only ExtraInfo saw, early or late", () => {
  const early = new NetworkLog();
  early.apply("Network.requestWillBeSent", { requestId: "c", timestamp: 1, request: { url: "https://other.test/", method: "GET" } });
  early.apply("Network.responseReceivedExtraInfo", { requestId: "c", statusCode: 200, headers: { "x-a": "1" } });
  early.apply("Network.loadingFailed", { requestId: "c", timestamp: 1.01, errorText: "net::ERR_FAILED" });
  assert.equal(early.records.get("c")?.state, "failed");
  assert.equal(early.records.get("c")?.statusCode, 200);

  const late = new NetworkLog();
  late.apply("Network.requestWillBeSent", { requestId: "d", timestamp: 1, request: { url: "https://other.test/", method: "GET" } });
  late.apply("Network.loadingFailed", { requestId: "d", timestamp: 1.01, errorText: "net::ERR_FAILED" });
  assert.equal(late.apply("Network.responseReceivedExtraInfo", { requestId: "d", statusCode: 403, headers: { "x-b": "2" } }), "d");
  assert.equal(late.records.get("d")?.statusCode, 403);
  assert.equal(late.records.get("d")?.state, "failed");
});

test("early ExtraInfo for ids never seen stays bounded", async () => {
  const { ExtraInfoSlots } = await import("./extra-info.ts");
  const slots = new ExtraInfoSlots<number, string>(10, 10);
  for (let index = 0; index < 100; index += 1) slots.arrive(`id${index}`, index);
  assert.ok(slots.size <= 10);
  assert.equal(slots.claim("id99", "r"), 99);
  assert.equal(slots.claim("id0", "r"), null);
});

const req = (id: string, url: string, extra: Record<string, unknown> = {}) => ({
  requestId: id,
  timestamp: 1,
  request: { url, method: "GET", headers: {} },
  ...extra,
});

test("review 3, case 1: a late request ExtraInfo for hop A stays on A after the redirect", () => {
  const log = new NetworkLog();
  log.apply("Network.requestWillBeSent", req("r", "http://a.test/a"));
  log.apply("Network.requestWillBeSent", req("r", "http://a.test/b", { redirectHasExtraInfo: true, redirectResponse: { status: 302 } }));
  log.apply("Network.requestWillBeSentExtraInfo", { requestId: "r", headers: { cookie: "for-a" } });
  log.apply("Network.requestWillBeSentExtraInfo", { requestId: "r", headers: { cookie: "for-b" } });

  const hop = [...log.records.values()].find((record) => record.id !== "r");
  assert.deepEqual(hop?.requestHeaders, { cookie: "for-a" });
  assert.deepEqual(log.records.get("r")?.requestHeaders, { cookie: "for-b" });
});

test("review 3, case 2: a request trimmed before its redirect keeps the final response's status", () => {
  const log = new NetworkLog(1);
  log.apply("Network.requestWillBeSent", req("a", "http://a.test/old"));
  log.apply("Network.requestWillBeSent", req("other", "http://o.test/"));
  log.apply("Network.requestWillBeSent", req("a", "http://a.test/new", { redirectHasExtraInfo: true, redirectResponse: { status: 302 } }));
  log.apply("Network.responseReceived", { requestId: "a", hasExtraInfo: true, response: { status: 200, headers: { x: "plain" } } });
  log.apply("Network.responseReceivedExtraInfo", { requestId: "a", statusCode: 302, headers: { location: "/new" } });
  log.apply("Network.responseReceivedExtraInfo", { requestId: "a", statusCode: 200, headers: { x: "wire" } });

  assert.equal(log.records.get("a")?.statusCode, 200);
  assert.deepEqual(log.records.get("a")?.responseHeaders, { x: "wire" });
});

test("review 3, case 3: hundreds of other waiting requests do not shift a redirect's pairing", () => {
  const log = new NetworkLog();
  log.apply("Network.requestWillBeSent", req("r", "http://a.test/old"));
  log.apply("Network.requestWillBeSent", req("r", "http://a.test/new", { redirectHasExtraInfo: true, redirectResponse: { status: 302 } }));
  for (let index = 0; index < 600; index += 1) {
    log.apply("Network.requestWillBeSent", req(`w${index}`, `http://w.test/${index}`));
    log.apply("Network.responseReceived", { requestId: `w${index}`, hasExtraInfo: true, response: { status: 200, headers: {} } });
  }
  log.apply("Network.responseReceived", { requestId: "r", hasExtraInfo: true, response: { status: 200, headers: {} } });
  log.apply("Network.responseReceivedExtraInfo", { requestId: "r", statusCode: 302, headers: { location: "/new" } });
  log.apply("Network.responseReceivedExtraInfo", { requestId: "r", statusCode: 200, headers: { x: "final" } });

  const hop = [...log.records.values()].find((record) => record.requestID === "r" && record.id !== "r");
  assert.equal(hop?.statusCode, 302);
  assert.equal(log.records.get("r")?.statusCode, 200);
  assert.deepEqual(log.records.get("r")?.responseHeaders, { x: "final" });
});

test("a DNS failure without ExtraInfo leaves the record as it failed", () => {
  const log = new NetworkLog();
  log.apply("Network.requestWillBeSent", req("f", "https://x.invalid/"));
  log.apply("Network.loadingFailed", { requestId: "f", timestamp: 1.1, errorText: "net::ERR_NAME_NOT_RESOLVED" });
  assert.equal(log.records.get("f")?.statusCode, undefined);
  assert.equal(log.records.get("f")?.state, "failed");
});

test("finished requests are forgotten oldest first and running ones are kept", async () => {
  const { ExtraInfoSlots } = await import("./extra-info.ts");
  const slots = new ExtraInfoSlots<number, string>(2, 2);
  slots.claim("running", "x");
  for (const id of ["a", "b", "c"]) {
    slots.claim(id, id);
    slots.finish(id);
  }
  assert.equal(slots.arrive("running", 1), "x");
  assert.equal(slots.arrive("c", 2), "c");
  assert.equal(slots.arrive("a", 3), null);
});

test("a long session keeps only the newest records", () => {
  const log = new NetworkLog(3);
  for (let index = 0; index < 5; index += 1) {
    log.apply("Network.requestWillBeSent", { requestId: String(index), timestamp: index, request: { url: `https://e.test/${index}`, method: "GET" } });
    log.apply("Network.loadingFinished", { requestId: String(index), timestamp: index + 0.1 });
  }
  assert.deepEqual([...log.records.keys()], ["2", "3", "4"]);
  assert.equal(log.records.get("4")?.state, "finished");
});

test("console arguments read the way a console prints them", () => {
  assert.equal(formatRemoteObject({ type: "string", value: "hi" }), "hi");
  assert.equal(formatRemoteObject({ type: "number", value: 3 }), "3");
  assert.equal(formatRemoteObject({ type: "number", unserializableValue: "NaN" }), "NaN");
  assert.equal(formatRemoteObject({ type: "undefined" }), "undefined");
  assert.equal(formatRemoteObject({ type: "object", subtype: "null", value: null }), "null");
  assert.equal(
    formatRemoteObject({
      type: "object",
      preview: { properties: [{ name: "a", type: "number", value: "1" }, { name: "b", type: "string", value: "x" }] },
    }),
    `{a: 1, b: "x"}`,
  );
  assert.equal(
    formatRemoteObject({ type: "object", subtype: "array", preview: { subtype: "array", overflow: true, properties: [{ name: "0", type: "number", value: "1" }] } }),
    "[1, …]",
  );
});

test("consoleAPICalled, exceptions and browser log entries become entries with a level", () => {
  const warn = consoleEntry(
    "Runtime.consoleAPICalled",
    {
      type: "warning",
      timestamp: 42,
      args: [{ type: "string", value: "careful" }, { type: "number", value: 2 }],
      stackTrace: { callFrames: [{ url: "https://e.test/app.js", lineNumber: 9 }] },
    },
    1,
  );
  assert.deepEqual(warn, {
    id: 1,
    level: "warning",
    source: "console",
    text: "careful 2",
    timestampMilliseconds: 42,
    location: "app.js:10",
  });

  const thrown = consoleEntry(
    "Runtime.exceptionThrown",
    { timestamp: 1, exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: x is undefined" } } },
    2,
  );
  assert.equal(thrown?.level, "error");
  assert.equal(thrown?.text, "TypeError: x is undefined");

  const logged = consoleEntry("Log.entryAdded", { entry: { source: "network", level: "error", text: "404", timestamp: 3 } }, 3);
  assert.equal(logged?.source, "network");
  assert.equal(logged?.level, "error");

  assert.equal(consoleEntry("Network.dataReceived", {}, 4), null);
});

test("target lists keep pages first, drop what cannot be attached, and use localhost", () => {
  const stdout = JSON.stringify([
    { id: "w", type: "service_worker", url: "sw.js", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/w" },
    { id: "f", type: "iframe", title: "frame", url: "https://f.test", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/f" },
    { id: "p", type: "page", title: "Home", url: "https://e.test", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/p" },
    { id: "taken", type: "page", title: "Attached elsewhere", url: "https://t.test" },
  ]);
  const targets = parseTargets(stdout);
  assert.deepEqual(targets.map((target) => target.id), ["p", "f"]);
  assert.equal(targets[0]?.webSocketDebuggerUrl, "ws://localhost:9222/devtools/page/p");
  assert.throws(() => parseTargets("{}"));
});

test("panelSocketURL rewrites loopback addresses only", () => {
  assert.equal(panelSocketURL("ws://[::1]:9339/devtools/page/a"), "ws://localhost:9339/devtools/page/a");
  assert.equal(panelSocketURL("ws://127.0.0.10:1/x"), "ws://127.0.0.10:1/x");
  assert.equal(panelSocketURL("ws://localhost:9222/x"), "ws://localhost:9222/x");
});

test("ports are digits in range and nothing else", () => {
  assert.equal(parsePort(" 9222 "), 9222);
  assert.equal(parsePort("0"), null);
  assert.equal(parsePort("70000"), null);
  assert.equal(parsePort("92a2"), null);
  assert.equal(parsePort("9222; rm -rf ~"), null);
});

test("the approved command refuses anything but digits on standard input", async () => {
  const { spawnSync } = await import("node:child_process");
  const run = (input: string) =>
    spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", DISCOVERY_COMMAND.replace("curl", "echo curl")], {
      input,
      encoding: "utf8",
    });

  assert.equal(run("$(touch /tmp/necto-web-injected)\n").status, 2);
  assert.equal(run("1; id\n").status, 2);
  assert.equal(run("\n").status, 2);
  const ok = run("9222\n");
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /http:\/\/localhost:9222\/json\/list/);
});
