import assert from "node:assert/strict";
import { test } from "node:test";
import { previewUrl, tokenFromHost } from "../src/routing.ts";

const HOST = "preview.von.app";
const TOKEN = "a".repeat(32);

test("a session subdomain resolves to its token", () => {
  assert.equal(tokenFromHost(`${TOKEN}.${HOST}`, HOST), TOKEN);
});

test("the port in the Host header is ignored", () => {
  assert.equal(tokenFromHost(`${TOKEN}.${HOST}:8787`, HOST), TOKEN);
  assert.equal(tokenFromHost(`${TOKEN}.${HOST}`, `${HOST}:8787`), TOKEN);
});

test("case and a trailing dot do not change the answer", () => {
  assert.equal(tokenFromHost(`${TOKEN.toUpperCase()}.${HOST}.`, HOST), TOKEN);
});

test("the preview host itself is not a session", () => {
  // Otherwise a request to the bare host would resolve to *something*, and the
  // control plane's own routes would stop being reachable.
  assert.equal(tokenFromHost(HOST, HOST), null);
  assert.equal(tokenFromHost(`www.${HOST}`, HOST), null);
});

test("a lookalike domain is rejected", () => {
  // `evilpreview.von.app` ends with the host's characters but is not under it.
  assert.equal(tokenFromHost(`${TOKEN}.evil${HOST}`, HOST), null);
  assert.equal(tokenFromHost(`${TOKEN}.${HOST}.evil.com`, HOST), null);
});

test("only one label in front of the host counts", () => {
  // A wildcard certificate covers `*.preview.von.app` — one label. Accepting
  // deeper names would route addresses the certificate does not cover.
  assert.equal(tokenFromHost(`extra.${TOKEN}.${HOST}`, HOST), null);
});

test("an implausible label is not treated as a token", () => {
  assert.equal(tokenFromHost(`short.${HOST}`, HOST), null);
  assert.equal(tokenFromHost(`has-a-dash-in-it-here.${HOST}`, HOST), null);
  assert.equal(tokenFromHost(`${"a".repeat(200)}.${HOST}`, HOST), null);
});

test("a missing host or unconfigured preview host resolves to nothing", () => {
  assert.equal(tokenFromHost(undefined, HOST), null);
  assert.equal(tokenFromHost(`${TOKEN}.${HOST}`, ""), null);
});

test("the client URL is the session's own origin", () => {
  // Its own origin, not a path under the control plane: Metro serves
  // root-absolute URLs, and separate origins keep one preview's code from
  // reading another's.
  assert.equal(previewUrl(HOST, TOKEN), `https://${TOKEN}.${HOST}/`);
  assert.equal(previewUrl(HOST, TOKEN, "http"), `http://${TOKEN}.${HOST}/`);
});
