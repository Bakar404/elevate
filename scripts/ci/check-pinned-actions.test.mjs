import assert from "node:assert/strict";
import { test } from "node:test";
import { findUnpinned } from "./check-pinned-actions.mjs";

const SHA = "11d5960a326750d5838078e36cf38b85af677262";
const check = (uses) => findUnpinned(`steps:\n  - uses: ${uses}\n`, "ci.yml");

test("flags a major-version tag", () => {
	assert.deepEqual(check("actions/checkout@v4"), [{ file: "ci.yml", line: 2, uses: "actions/checkout@v4" }]);
});

test("flags a branch ref", () => {
	assert.equal(check("foo/bar@main").length, 1);
});

test("flags a short SHA", () => {
	assert.equal(check("actions/checkout@11d5960").length, 1);
});

test("flags a ref with no @", () => {
	assert.equal(check("actions/checkout").length, 1);
});

test("flags an uppercase SHA", () => {
	assert.equal(check(`actions/checkout@${SHA.toUpperCase()}`).length, 1);
});

test("passes a full SHA with a version comment", () => {
	assert.deepEqual(check(`actions/checkout@${SHA} # v4`), []);
});

test("passes a local action", () => {
	assert.deepEqual(check("./local-action"), []);
});

test("passes a sub-path action pinned to a SHA", () => {
	assert.deepEqual(check(`github/codeql-action/init@${SHA}`), []);
});

test("passes a docker ref with a digest and flags one without", () => {
	assert.deepEqual(check(`docker://alpine@sha256:${"a".repeat(64)}`), []);
	assert.equal(check("docker://alpine:3.20").length, 1);
});

test("reads a uses: key that is not a list item", () => {
	assert.equal(findUnpinned("    uses: foo/bar@v1 # v1\n", "x.yml")[0].line, 1);
});
