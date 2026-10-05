import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const mitigation = JSON.parse(readFileSync(join(projectRoot, "patches/braces-3.0.3-depth.json"), "utf8"));

// Pin both the lockfile scope and all executable package files. A changed
// version, extra install location, production dependency, or partial patch
// requires review instead of silently extending the advisory exception.
export function checkBracesLock(lock) {
  const entries = Object.entries(lock.packages ?? {}).filter(([path]) => /(^|\/)node_modules\/braces$/.test(path));
  if (entries.length !== 1 || entries[0][0] !== "node_modules/braces"
      || entries[0][1].version !== mitigation.version || entries[0][1].dev !== true) {
    throw new Error("The reviewed dev-only braces@3.0.3 scope changed; review or retire its mitigation.");
  }
}

export function checkBracesPatch(root = projectRoot, apply = false) {
  checkBracesLock(JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")));
  const packageDir = join(root, "node_modules/braces");
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  if (pkg.name !== "braces" || pkg.version !== mitigation.version || pkg.main !== "index.js") {
    throw new Error("Unexpected installed braces package.");
  }
  const states = Object.entries(mitigation.files).map(([file, hashes]) => {
    const hash = createHash("sha256").update(readFileSync(join(packageDir, file))).digest("hex");
    if (hash === hashes.patched) return "patched";
    if (apply && hash === hashes.original) return "original";
    throw new Error(`braces/${file}: missing mitigation or unexpected source checksum.`);
  });
  if (states.includes("original")) {
    const patch = join(projectRoot, "patches/braces-3.0.3-depth.patch");
    // --check prevents partial application. Git is already required by the
    // repository's build; no patching package or new dependency is installed.
    const args = ["apply", "--directory=node_modules/braces", patch];
    execFileSync("git", [args[0], "--check", ...args.slice(1)], { cwd: root, stdio: "pipe" });
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
    checkBracesPatch(root);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkBracesPatch(projectRoot, !process.argv.includes("--check"));
  console.log("Verified braces@3.0.3 depth-limit mitigation (GHSA-vfj7-8cjw-p6xm).");
}
