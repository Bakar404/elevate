// Fails when a workflow uses a remote action by a mutable ref (tag or branch)
// instead of a full 40-character commit SHA.
// Run: node scripts/ci/check-pinned-actions.mjs [dir]  (default .github/workflows)
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const USES = /^\s*(?:-\s+)?uses:\s*(.*)$/;
const SHA = /^[0-9a-f]{40}$/;

// Returns [{ file, line, uses }] for every `uses:` that is not pinned to a full SHA.
export function findUnpinned(text, filename) {
	const out = [];
	text.split(/\r?\n/).forEach((raw, i) => {
		const m = raw.match(USES);
		if (!m) return;
		const uses = m[1]
			.replace(/\s+#.*$/, "")
			.trim()
			.replace(/^(["'])(.*)\1$/, "$2");
		if (uses.startsWith("./")) return;
		if (uses.startsWith("docker://")) {
			if (uses.includes("@sha256:")) return;
		} else {
			const at = uses.lastIndexOf("@");
			if (at > 0 && SHA.test(uses.slice(at + 1))) return;
		}
		out.push({ file: filename, line: i + 1, uses });
	});
	return out;
}

function main() {
	const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
	const dir = resolve(process.argv[2] ?? join(root, ".github", "workflows"));
	const files = readdirSync(dir)
		.filter((f) => /\.ya?ml$/.test(f))
		.sort();
	const violations = files.flatMap((f) => findUnpinned(readFileSync(join(dir, f), "utf8"), relative(process.cwd(), join(dir, f)).replaceAll("\\", "/")));
	for (const v of violations) console.log(`${v.file}:${v.line}: ${v.uses}`);
	if (violations.length > 0) process.exit(1);
	console.log("All actions pinned to SHAs");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
