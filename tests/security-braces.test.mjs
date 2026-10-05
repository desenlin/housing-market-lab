import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { checkBracesPatch } from "../scripts/patch-braces.mjs";

const require = createRequire(import.meta.url);
const braces = require("braces");
const micromatch = require("micromatch");
const glob = require("fast-glob");

test("the pinned source patch is verified and idempotent", () => {
  checkBracesPatch();
  checkBracesPatch(undefined, true);
  checkBracesPatch();
});

test("normal sets, ranges, parentheses and stringify escaping stay compatible", () => {
  assert.equal(braces.compile("src/{app,components}/**/*.{ts,tsx}"), "src/(app|components)/**/*.(ts|tsx)");
  assert.deepEqual(braces.expand("v{01..03}/{a,b}"), ["v01/a", "v01/b", "v02/a", "v02/b", "v03/a", "v03/b"]);
  assert.deepEqual(braces.expand("foo/({a,b})"), ["foo/(a)", "foo/(b)"]);
  for (const pattern of ["{{a}}", "{a,{b}}", "{{x}y}", "{a,{b,{c}}}", "{}{a}"]) {
    assert.equal(braces.stringify(pattern, { escapeInvalid: true }), pattern);
  }
  assert.deepEqual(micromatch(["app/page.tsx", "app/data.json", "lib/x.ts"], "{app,lib}/**/*.{ts,tsx}"), ["app/page.tsx", "lib/x.ts"]);
  assert.deepEqual(glob.sync("tests/security-{braces,audit}.test.mjs").sort(), ["tests/security-audit.test.mjs", "tests/security-braces.test.mjs"]);
});

test("all public string processors enforce the 100/101 boundary and hostile depth", () => {
  for (const method of [braces, braces.parse, braces.compile, braces.expand, braces.stringify]) {
    for (const [open, close] of [["{", "}"], ["(", ")"]]) {
      assert.doesNotThrow(() => method(open.repeat(100) + "x" + close.repeat(100)));
      for (const depth of [101, 4000]) {
        const input = open.repeat(depth) + "x" + close.repeat(depth);
        assert.throws(() => method(input), /exceeds max depth/);
        assert.throws(() => method(input, { maxDepth: Infinity }), /exceeds max depth/);
      }
    }
  }
  assert.throws(() => micromatch.braces("{".repeat(4000) + "a,b" + "}".repeat(4000)), /exceeds max depth/);
  assert.throws(() => glob.sync("{".repeat(4000) + "a,b" + "}".repeat(4000)), /exceeds max depth/);
});

test("stricter and fractional limits cannot admit excessive nesting", () => {
  for (const method of [braces.parse, braces.compile, braces.expand, braces.stringify]) {
    assert.doesNotThrow(() => method("{a,b}", { maxDepth: 1.5 }));
    assert.throws(() => method("{{a,b},c}", { maxDepth: 1.5 }), /exceeds max depth/);
    assert.throws(() => method("((a))", { maxDepth: 1 }), /exceeds max depth/);
    assert.doesNotThrow(() => method("\\{literal\\}".repeat(200)));
  }
});

test("direct syntax trees and parent cycles cannot bypass depth checks", () => {
  for (const method of [braces.compile, braces.expand, braces.stringify]) {
    let ast = { type: "text", value: "a" };
    for (let i = 0; i < 4000; i++) ast = { type: "brace", nodes: [ast] };
    ast = { type: "root", nodes: [ast] };
    assert.throws(() => method(ast), /exceeds max depth/);
  }
  for (const cycleLength of [1, 2]) {
    const ast = { type: "paren", nodes: [{ type: "text", value: "a" }] };
    ast.parent = cycleLength === 1 ? ast : { type: "paren", parent: ast };
    assert.throws(() => runInNewContext("expand(ast)", { expand: braces.expand, ast }, { timeout: 250 }), /parent chain contains a cycle/);
  }
});
