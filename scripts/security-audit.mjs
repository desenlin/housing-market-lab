import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

const severity = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

export function evaluateAudit(report) {
  if (!report || report.error || report.auditReportVersion !== 2 || !report.vulnerabilities
      || typeof report.vulnerabilities !== "object" || Array.isArray(report.vulnerabilities)
      || !report.metadata?.vulnerabilities) {
    throw new Error("Missing or invalid npm audit report; refusing to pass the audit.");
  }
  const vulnerabilities = report.vulnerabilities;
  const blocked = [];
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    if (!entry || !Object.hasOwn(severity, entry.severity)) throw new Error(`Unknown audit severity: ${entry?.severity}`);
    if (severity[entry.severity] < severity.moderate) continue;
    blocked.push(name);
  }
  return { blocked };
}

function main() {
  const result = spawnSync("npm", ["audit", "--package-lock-only", "--include=dev", "--audit-level=moderate", "--json", "--fetch-retries=0", "--fetch-timeout=30000"], {
    cwd: projectRoot, encoding: "utf8", timeout: 120000, maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error || ![0, 1].includes(result.status)) {
    throw new Error(`npm audit could not complete: ${result.error?.message ?? result.stderr}`);
  }
  // Retain the unfiltered report. There are no advisory exceptions.
  writeFileSync(join(projectRoot, "security-audit.json"), result.stdout);
  const report = JSON.parse(result.stdout);
  if (result.status === 1 && !Object.keys(report.vulnerabilities ?? {}).length) {
    throw new Error("npm audit failed without vulnerability findings.");
  }
  const { blocked } = evaluateAudit(report);
  const lines = ["### Dependency security audit", "", `Moderate-or-higher findings: ${blocked.length}.`];
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
