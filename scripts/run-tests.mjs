import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const testRoot = join(root, "dist", "test");

async function testFilesBelow(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await testFilesBelow(path)));
    else if (entry.name.endsWith(".test.js")) files.push(path);
  }
  return files;
}

const tests = (await testFilesBelow(testRoot)).sort();
if (tests.length === 0) {
  process.stderr.write(`no compiled tests found below ${testRoot}\n`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...tests], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
