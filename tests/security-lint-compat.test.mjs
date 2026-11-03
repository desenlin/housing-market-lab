import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const eslint = new ESLint({ cwd, ignorePatterns: ["dist/**", ".next/**"] });
const filePath = "app/security-lint-compat-fixture.tsx";

test("patched glob matching preserves source and generated-file selection", async () => {
  assert.equal(await eslint.isPathIgnored(filePath), false);
  for (const path of ["dist/client/page.tsx", ".next/server/page.tsx", "build/sites-vite-plugin.ts"]) {
    assert.equal(await eslint.isPathIgnored(path), true, path);
  }
});

test("the actual Next/TypeScript lint configuration accepts valid TSX", async () => {
  const [result] = await eslint.lintText(`
    export default function SecurityLintFixture({ ready }: { ready: boolean }) {
      return <main>{ready ? "Ready" : "Waiting"}</main>;
    }
  `, { filePath });
  assert.equal(result.fatalErrorCount, 0);
  assert.equal(result.errorCount, 0, JSON.stringify(result.messages));
  assert.equal(result.warningCount, 0, JSON.stringify(result.messages));
});

test("patched glob matching retains React, accessibility, and TypeScript diagnostics", async () => {
  const [result] = await eslint.lintText(`
    import { useState } from "react";
    export default function SecurityLintFixture({ ready }: { ready: boolean }) {
      const unused: number = 1;
      if (ready) useState(0);
      return <img src="/fixture.png" />;
    }
  `, { filePath });
  assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
  const rules = result.messages.map(message => message.ruleId);
  for (const rule of ["react-hooks/rules-of-hooks", "jsx-a11y/alt-text", "@typescript-eslint/no-unused-vars"]) {
    assert.ok(rules.includes(rule), `Missing ${rule}: ${JSON.stringify(result.messages)}`);
  }
});
