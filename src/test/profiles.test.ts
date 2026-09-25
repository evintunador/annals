import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  createNamespaceProfile,
  listNamespaceProfiles,
  loadNamespaceProfile,
  profilePath,
  removeNamespaceProfile,
  saveNamespaceProfile,
  validateNamespaceProfile,
} from "../profiles.js";
import { cleanupRepo, makeTempRepo } from "./helpers.js";

const CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));

test("profiles persist complete descriptors and repository-local values override global ones", async () => {
  const repo = await makeTempRepo();
  try {
    const global = createNamespaceProfile({ name: "example", cliName: "example-cli" });
    await saveNamespaceProfile(repo, "example", global, "global");
    assert.deepStrictEqual(await loadNamespaceProfile(repo, "example"), global);
    assert.equal(global.incomingName, "example-incoming");
    assert.equal(global.internalEnvName, "EXAMPLE_INTERNAL");

    const local = createNamespaceProfile({
      name: "example-local",
      incomingName: "legacy-incoming",
      cliName: "example-cli",
    });
    await saveNamespaceProfile(repo, "example", local, "local");
    assert.deepStrictEqual(await loadNamespaceProfile(repo, "example"), local);
    assert.deepStrictEqual(Object.keys(await listNamespaceProfiles(repo)), ["example"]);

    assert.equal(await removeNamespaceProfile(repo, "example", "local"), true);
    assert.deepStrictEqual(await loadNamespaceProfile(repo, "example"), global);
    assert.equal(await removeNamespaceProfile(repo, "missing", "local"), false);
  } finally {
    await cleanupRepo(repo);
  }
});

test("profile files reject arrays in place of the named profile map", async () => {
  const repo = await makeTempRepo();
  try {
    const path = profilePath(repo, "local");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{"version":1,"profiles":[]}\n');
    await assert.rejects(() => listNamespaceProfiles(repo), /expected version 1 and a profiles object/);
    await writeFile(path, '{"version":1,"profiles":null}\n');
    await assert.rejects(() => listNamespaceProfiles(repo), /expected version 1 and a profiles object/);
  } finally {
    await cleanupRepo(repo);
  }
});

test("concurrent profile saves preserve every update", async () => {
  const repo = await makeTempRepo();
  try {
    const names = ["one", "two", "three", "four"];
    await Promise.all(
      names.map((name) =>
        saveNamespaceProfile(repo, name, createNamespaceProfile({ name }), "local"),
      ),
    );
    const profiles = await listNamespaceProfiles(repo);
    for (const name of names) assert.equal(profiles[name]?.name, name);
  } finally {
    await cleanupRepo(repo);
  }
});

test("persisted profiles reject executable hook paths and incomplete descriptors", () => {
  assert.equal(createNamespaceProfile({ name: "annals" }).name, "annals");
  assert.throws(
    () => validateNamespaceProfile({ ...createNamespaceProfile({ name: "safe" }), hookInvocation: {} }),
    /cannot contain hookInvocation/,
  );
  assert.throws(() => validateNamespaceProfile({ name: "incomplete" }), /incomingName/);
  assert.throws(
    () => createNamespaceProfile({ name: "safe", stateDirName: "../outside" }),
    /contained relative directory/,
  );
  assert.throws(
    () => createNamespaceProfile({ name: "bad..ref" }),
    /valid refs\/notes name/,
  );
  const legacy = createNamespaceProfile({
    name: "team/records",
    incomingName: "team/records-incoming",
    stateDirName: ".legacy/state",
    configFile: ".legacy.json",
    userConfigDir: ".legacy/config",
    cliName: "legacy-records",
  });
  assert.equal(legacy.name, "team/records");
  assert.equal(legacy.stateDirName, ".legacy/state");
});

test("unknown Object prototype names never resolve as profiles", async () => {
  const repo = await makeTempRepo();
  try {
    await assert.rejects(() => loadNamespaceProfile(repo, "constructor"), /unknown annals profile/);
    await assert.rejects(() => loadNamespaceProfile(repo, "toString"), /unknown annals profile/);
  } finally {
    await cleanupRepo(repo);
  }
});

test("CLI creates and consumes a repository-local profile", async () => {
  const repo = await makeTempRepo();
  try {
    const added = spawnSync(
      process.execPath,
      [
        CLI_PATH,
        "profile",
        "add",
        "example",
        "--namespace",
        "example-app",
        "--incoming",
        "legacy-incoming",
        "--cli-name",
        "example-app",
        "--local",
      ],
      { cwd: repo.root, encoding: "utf8", env: process.env },
    );
    assert.equal(added.status, 0, added.stderr);

    const shown = spawnSync(process.execPath, [CLI_PATH, "profile", "show", "example"], {
      cwd: repo.root,
      encoding: "utf8",
      env: process.env,
    });
    assert.equal(shown.status, 0, shown.stderr);
    const profile = JSON.parse(shown.stdout) as Record<string, unknown>;
    assert.equal(profile.name, "example-app");
    assert.equal(profile.incomingName, "legacy-incoming");
    assert.equal(profile.cliName, "example-app");
    assert.equal("hookInvocation" in profile, false);

    const help = spawnSync(process.execPath, [CLI_PATH, "--profile", "example", "help"], {
      cwd: repo.root,
      encoding: "utf8",
      env: process.env,
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^usage: annals <command>/);
  } finally {
    await cleanupRepo(repo);
  }
});

test("CLI rejects an empty profile option instead of selecting the default namespace", () => {
  const result = spawnSync(process.execPath, [CLI_PATH, "--profile=", "help"], {
    cwd: process.env.HOME,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--profile requires a value/);
});
