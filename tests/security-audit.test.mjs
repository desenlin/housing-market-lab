import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAudit } from "../scripts/security-audit.mjs";

const report = vulnerabilities => ({
  auditReportVersion: 2,
  vulnerabilities,
  metadata: { vulnerabilities: {} },
});

test("an empty report and findings below moderate pass", () => {
  assert.deepEqual(evaluateAudit(report({})).blocked, []);
  assert.deepEqual(evaluateAudit(report({
    informational: { severity: "info" },
    minor: { severity: "low" },
  })).blocked, []);
});

test("all moderate-or-higher findings fail, including development dependencies", () => {
  const findings = {
    moderate: { severity: "moderate", nodes: ["node_modules/dev-tool"] },
    high: { severity: "high" },
    critical: { severity: "critical" },
    low: { severity: "low" },
  };
  assert.deepEqual(evaluateAudit(report(findings)).blocked, ["moderate", "high", "critical"]);
});

test("the former braces advisory receives no exception if it is reported again", () => {
  const findings = {
    braces: {
      severity: "high",
      via: [{ url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm" }],
    },
    micromatch: { severity: "high", via: ["braces"] },
  };
  assert.deepEqual(evaluateAudit(report(findings)).blocked, ["braces", "micromatch"]);
});

test("registry errors and malformed reports cannot pass", () => {
  for (const value of [
    null, {}, { error: { code: "ENOAUDIT" } },
    { ...report({}), auditReportVersion: 99 },
    { ...report({}), vulnerabilities: [] },
    { ...report({}), metadata: {} },
  ]) {
    assert.throws(() => evaluateAudit(value), /invalid npm audit report/);
  }
  for (const entry of [null, { severity: "unknown" }, { severity: "toString" }]) {
    assert.throws(() => evaluateAudit(report({ invalid: entry })), /Unknown audit severity/);
  }
});
