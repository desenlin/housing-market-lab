import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkBracesLock, checkBracesPatch, mitigation, projectRoot } from "./patch-braces.mjs";

const severity = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

export function evaluateAudit(report, lock, { now = new Date(), patchVerified = false } = {}) {
  if (report.error || report.auditReportVersion !== 2 || !report.vulnerabilities
      || typeof report.vulnerabilities !== "object" || Array.isArray(report.vulnerabilities)
      || !report.metadata?.vulnerabilities) {
    throw new Error("Missing or invalid npm audit report; refusing to pass the audit.");
  }
  const vulnerabilities = report.vulnerabilities;
  const blocked = [];
  const mitigated = [];
  const isMitigated = (name, visiting = new Set()) => {
    const entry = vulnerabilities[name];
    if (!entry || visiting.has(name) || !Array.isArray(entry.via) || !entry.via.length) {
      throw new Error(`Invalid npm audit dependency chain: ${name}`);
    }
    if (!Array.isArray(entry.nodes) || !entry.nodes.length || !entry.nodes.every(path => lock.packages?.[path]?.dev === true)) {
      return false;
    }
    const next = new Set([...visiting, name]);
    return entry.via.every(via => {
      if (typeof via === "string") return isMitigated(via, next);
      if (!via || name !== "braces" || via.name !== "braces" || via.dependency !== "braces"
          || via.url !== mitigation.advisory || via.severity !== "high" || entry.severity !== "high") return false;
      checkBracesLock(lock);
      return patchVerified && now < new Date(`${mitigation.expires}T00:00:00Z`)
        && entry.nodes.length === 1 && entry.nodes[0] === "node_modules/braces";
    });
  };
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    if (!(entry.severity in severity)) throw new Error(`Unknown audit severity: ${entry.severity}`);
    if (severity[entry.severity] < severity.moderate) continue;
    (isMitigated(name) ? mitigated : blocked).push(name);
  }
  return { blocked, mitigated };
}

function main() {
  checkBracesPatch();
  const result = spawnSync("npm", ["audit", "--package-lock-only", "--include=dev", "--audit-level=moderate", "--json", "--fetch-retries=0", "--fetch-timeout=30000"], {
    cwd: projectRoot, encoding: "utf8", timeout: 120000, maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error || ![0, 1].includes(result.status)) {
    throw new Error(`npm audit could not complete: ${result.error?.message ?? result.stderr}`);
  }
  // Retain the unfiltered report, including the mitigated advisory.
  writeFileSync(join(projectRoot, "security-audit.json"), result.stdout);
  const report = JSON.parse(result.stdout);
  if (result.status === 1 && !Object.keys(report.vulnerabilities ?? {}).length) {
    throw new Error("npm audit failed without vulnerability findings.");
  }
  const lock = JSON.parse(readFileSync(join(projectRoot, "package-lock.json"), "utf8"));
  const { blocked, mitigated } = evaluateAudit(report, lock, { patchVerified: true });
  const lines = ["### Dependency security audit", "", `Unmitigated moderate-or-higher findings: ${blocked.length}.`];
  if (mitigated.length) {
    const message = `GHSA-vfj7-8cjw-p6xm remains reported upstream. Verified the local depth-limit patch for dev-only braces@3.0.3 (${mitigated.length} affected dependency entries). Temporary exception expires ${mitigation.expires}; this is not an upstream fix.`;
    console.log(`::warning::${message}`);
    lines.push("", message);
  }
  if (blocked.length) lines.push("", `Failing packages: ${blocked.join(", ")}. Review security-audit.json.`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
  if (blocked.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
