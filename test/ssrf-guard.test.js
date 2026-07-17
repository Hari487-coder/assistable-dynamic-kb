import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { isPrivateIp, assertPublicHttpUrl, safeFetch } from "../src/ssrf-guard.js";

test("isPrivateIp classification", () => {
  for (const ip of ["127.0.0.1","10.1.2.3","172.16.0.1","172.31.255.255","192.168.1.1","169.254.169.254","0.0.0.0","100.64.0.1","::1","fe80::1","fd00::1"]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8","1.1.1.1","172.32.0.1","2606:4700::1111"]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test("assertPublicHttpUrl blocks schemes, ports, private DNS", async () => {
  const pub = async () => [{ address: "93.184.216.34", family: 4 }];
  const priv = async () => [{ address: "192.168.0.10", family: 4 }];
  await assert.rejects(assertPublicHttpUrl("ftp://x.com", { lookupFn: pub }), /SSRF|scheme/i);
  await assert.rejects(assertPublicHttpUrl("http://x.com:22/", { lookupFn: pub }), /port/i);
  await assert.rejects(assertPublicHttpUrl("http://internal.corp/", { lookupFn: priv }), /private/i);
  await assert.doesNotReject(assertPublicHttpUrl("https://example.com/feed.json", { lookupFn: pub }));
});

test("safeFetch caps response size", async () => {
  const srv = http.createServer((req, res) => { res.end("x".repeat(2000)); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const loop = async () => [{ address: "127.0.0.1", family: 4 }];
  await assert.rejects(
    safeFetch(`http://localtest:${port}/`, { maxBytes: 100, lookupFn: loop, allowPrivateForTest: true, allowedPorts: [port] }),
    /size/i
  );
  srv.close();
});

test("safeFetch follows redirects and re-validates each hop", async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === "/start") { res.writeHead(302, { location: "/final" }); res.end(); }
    else { res.end("landed"); }
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const loop = async () => [{ address: "127.0.0.1", family: 4 }];
  const res = await safeFetch(`http://localtest:${port}/start`, { lookupFn: loop, allowPrivateForTest: true, allowedPorts: [port] });
  assert.equal(res.text, "landed");
  srv.close();
});
