import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateAudit } from "../scripts/security-audit.mjs";
import { checkBracesPatch, projectRoot } from "../scripts/patch-braces.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/braces-audit.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const reviewed = { now: new Date("2026-10-05T23:00:00Z"), patchVerified: true };

test("only the one mitigated advisory and its dev-only effects pass", () => {
  const result = evaluateAudit(fixture, lock, reviewed);
  assert.deepEqual(result.blocked, []);
  assert.equal(result.mitigated.length, 8);
});

test("another advisory on the same package and its parents still fails", () => {
  const report = structuredClone(fixture);
  report.vulnerabilities.braces.via.push({ ...report.vulnerabilities.braces.via[0], url: "https://github.com/advisories/GHSA-new-advisory", severity: "moderate" });
  const result = evaluateAudit(report, lock, reviewed);
  assert.equal(result.blocked.length, 8);
  assert.deepEqual(result.mitigated, []);
});

test("a new unrelated moderate vulnerability still fails", () => {
  const report = structuredClone(fixture);
  report.vulnerabilities.example = { severity: "moderate", nodes: ["node_modules/example"], via: [{ name: "example", url: "https://example.com/advisory", severity: "moderate" }] };
  assert.deepEqual(evaluateAudit(report, lock, reviewed).blocked, ["example"]);
});

test("missing patch, expiry and changed severity cannot be waived", () => {
  for (const options of [{ ...reviewed, patchVerified: false }, { ...reviewed, now: new Date("2026-11-05T00:00:00Z") }]) {
    assert.equal(evaluateAudit(fixture, lock, options).blocked.length, 8);
  }
  const report = structuredClone(fixture);
  report.vulnerabilities.braces.severity = "critical";
  assert.equal(evaluateAudit(report, lock, reviewed).blocked.length, 8);
});

test("production paths, changed versions and duplicate installations fail closed", () => {
  const productionLock = structuredClone(lock);
  productionLock.packages["node_modules/braces"].dev = false;
  assert.equal(evaluateAudit(fixture, productionLock, reviewed).blocked.length, 8);
  const changedLock = structuredClone(lock);
  changedLock.packages["node_modules/braces"].version = "3.0.4";
  assert.throws(() => evaluateAudit(fixture, changedLock, reviewed), /scope changed/);
  const duplicateLock = structuredClone(lock);
  duplicateLock.packages["node_modules/example/node_modules/braces"] = duplicateLock.packages["node_modules/braces"];
  assert.throws(() => evaluateAudit(fixture, duplicateLock, reviewed), /scope changed/);
  const parentLock = structuredClone(lock);
  parentLock.packages["node_modules/vinext"].dev = false;
  assert.ok(evaluateAudit(fixture, parentLock, reviewed).blocked.includes("vinext"));
});

test("registry errors, malformed reports and broken dependency chains fail", () => {
  for (const report of [{ error: { code: "ENOAUDIT" } }, {}, { ...fixture, auditReportVersion: 99 }]) {
    assert.throws(() => evaluateAudit(report, lock, reviewed), /invalid npm audit/);
  }
  const report = structuredClone(fixture);
  report.vulnerabilities.braces.via = ["missing-package"];
  assert.throws(() => evaluateAudit(report, lock, reviewed), /Invalid npm audit dependency chain/);
  report.vulnerabilities.braces.via = ["micromatch"];
  assert.throws(() => evaluateAudit(report, lock, reviewed), /Invalid npm audit dependency chain/);
});

test("tampering with a patched source file is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "housing-braces-test-"));
  try {
    mkdirSync(join(dir, "node_modules"));
    cpSync(join(projectRoot, "node_modules/braces"), join(dir, "node_modules/braces"), { recursive: true });
    cpSync(join(projectRoot, "package-lock.json"), join(dir, "package-lock.json"));
    checkBracesPatch(dir);
    writeFileSync(join(dir, "node_modules/braces/lib/compile.js"), "module.exports = () => 'unpatched';\n");
    assert.throws(() => checkBracesPatch(dir), /unexpected source checksum/);
    assert.throws(() => checkBracesPatch(dir, true), /unexpected source checksum/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
