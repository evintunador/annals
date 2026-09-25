import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ignored = new Set([".git", "dist", "node_modules"]);

async function filesBelow(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(path)));
    else files.push(path);
  }
  return files;
}

const files = await filesBelow(root);
const markdown = files.filter((path) => extname(path) === ".md");
const failures = [];
const markdownText = new Map(
  await Promise.all(markdown.map(async (path) => [path, await readFile(path, "utf8")])),
);

function headingSlugs(text) {
  const counts = new Map();
  const slugs = new Set();
  for (const match of text.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const base = match[1]
      .replace(/<[^>]*>/g, "")
      .replace(/[`*_~]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
    const duplicate = counts.get(base) ?? 0;
    counts.set(base, duplicate + 1);
    slugs.add(duplicate === 0 ? base : `${base}-${duplicate}`);
  }
  return slugs;
}

const headings = new Map([...markdownText].map(([path, contents]) => [path, headingSlugs(contents)]));

for (const path of markdown) {
  const text = markdownText.get(path);
  const targets = [
    ...[...text.matchAll(/\[[^\]]+\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g)].map(
      (match) => match[1] ?? match[2],
    ),
    ...[...text.matchAll(/^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm)].map(
      (match) => match[1] ?? match[2],
    ),
  ];
  for (const link of targets) {
    if (/^(?:https?:|mailto:)/.test(link)) continue;
    const [target, fragment] = link.split("#", 2);
    const destination = target ? resolve(path, "..", decodeURIComponent(target)) : path;
    if (!files.includes(destination)) {
      failures.push(`${relative(root, path)}: broken link to ${link}`);
    } else if (fragment && destination.endsWith(".md") && !headings.get(destination)?.has(fragment)) {
      failures.push(`${relative(root, path)}: broken heading link to ${link}`);
    }
  }
}

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
for (const path of markdown) {
  const text = markdownText.get(path);
  for (const match of text.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
    if (!(match[1] in packageJson.scripts)) {
      failures.push(`${relative(root, path)}: npm run ${match[1]} is not a package script`);
    }
  }
}

const sourceFiles = files.filter((path) => {
  const local = relative(root, path);
  return local.startsWith(`src/`) && !local.startsWith(`src/test/`) && path.endsWith(".ts");
});
for (const path of sourceFiles) {
  const text = await readFile(path, "utf8");
  if (text.includes("WIP_TECHNICAL_DESIGN")) {
    failures.push(`${relative(root, path)}: references the removed WIP design`);
  }
  if (/\b(?:cledger|conversation-ledger|turnbridge)\b/i.test(text)) {
    failures.push(`${relative(root, path)}: uses downstream-specific terminology in generic source`);
  }
}

const readme = await readFile(join(root, "README.md"), "utf8");
for (const heading of ["## Install from source", "## Library quick start", "## CLI", "## Documentation"]) {
  if (!readme.includes(heading)) failures.push(`README.md: missing ${heading}`);
}

for (const flag of ["--no-scan", "--all", "--report", "transport-push"]) {
  if (!readme.includes(flag)) failures.push(`README.md: missing CLI documentation for ${flag}`);
}

const configDoc = await readFile(join(root, "docs", "configuration.md"), "utf8");
for (const key of [
  "enabled",
  "capture",
  "env",
  "knownSecrets",
  "patterns",
  "tier",
  "allowFingerprints",
  "warnEventBytes",
  "maxEventBytes",
  "hook",
  "strict",
  "fetchRefspec",
  "auto",
  "forge",
]) {
  if (!configDoc.includes(`\`${key}\``) && !configDoc.includes(`"${key}"`)) {
    failures.push(`docs/configuration.md: missing configuration key ${key}`);
  }
}

if (!packageJson.files.includes("docs")) {
  failures.push("package.json: docs must be included because the packaged README links to them");
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`documentation checks passed (${markdown.length} Markdown files)\n`);
