import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RepoInfo } from "./git.js";
import { resolveNamespace, type NamespaceConfig } from "./ledger.js";

/** A portable namespace descriptor. Executable hook paths are intentionally excluded. */
export type NamespaceProfile = Omit<NamespaceConfig, "hookInvocation">;
export type ProfileScope = "global" | "local";

interface ProfileFile {
  version: 1;
  profiles: Record<string, NamespaceProfile>;
}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_CLI_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function globalPath(): string {
  return join(homedir(), ".config", "annals", "profiles.json");
}

function localPath(repo: RepoInfo): string {
  return join(repo.commonDir, "annals", "profiles.json");
}

export function profilePath(repo: RepoInfo | null, scope: ProfileScope): string {
  if (scope === "global") return globalPath();
  if (!repo) throw new Error("a repository is required for a local profile");
  return localPath(repo);
}

export function validateProfileName(name: string): void {
  if (!PROFILE_NAME.test(name)) {
    throw new Error(
      `invalid profile name "${name}" (use 1-64 letters, digits, dots, underscores, or hyphens)`,
    );
  }
}

function requiredString(value: unknown, field: keyof NamespaceProfile): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`profile field ${field} must be a non-empty string`);
  }
  return value;
}

function safeRelativeDirectory(value: unknown, field: keyof NamespaceProfile): string {
  const checked = requiredString(value, field);
  const components = checked.split("/");
  if (
    checked.startsWith("/") ||
    checked.includes("\\") ||
    /[\0-\x1f\x7f]/.test(checked) ||
    components.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`profile field ${field} must be a contained relative directory`);
  }
  return checked;
}

function safeRefFragment(value: unknown, field: "name" | "incomingName"): string {
  const checked = requiredString(value, field);
  const components = checked.split("/");
  if (
    checked.startsWith("/") ||
    checked.endsWith("/") ||
    checked.endsWith(".") ||
    checked.includes("..") ||
    checked.includes("@{") ||
    /[\0-\x20\x7f~^:?*[\\]/.test(checked) ||
    components.some((part) => part === "" || part.startsWith(".") || part.endsWith(".lock"))
  ) {
    throw new Error(`profile field ${field} must form a valid refs/notes name`);
  }
  return checked;
}

/** Validate and copy a persisted profile without accepting executable fields. */
export function validateNamespaceProfile(value: unknown): NamespaceProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("profile must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if ("hookInvocation" in candidate) {
    throw new Error("profiles cannot contain hookInvocation; hook installation belongs to the owner CLI");
  }
  return {
    name: safeRefFragment(candidate.name, "name"),
    incomingName: safeRefFragment(candidate.incomingName, "incomingName"),
    internalEnvName: (() => {
      const checked = requiredString(candidate.internalEnvName, "internalEnvName");
      if (!ENV_NAME.test(checked)) throw new Error("profile field internalEnvName must be an environment variable name");
      return checked;
    })(),
    stateDirName: safeRelativeDirectory(candidate.stateDirName, "stateDirName"),
    configFile: (() => {
      const checked = requiredString(candidate.configFile, "configFile");
      if (
        checked === "." ||
        checked === ".." ||
        checked.includes("/") ||
        checked.includes("\\") ||
        /[\0-\x1f\x7f]/.test(checked)
      ) {
        throw new Error("profile field configFile must be one safe filename");
      }
      return checked;
    })(),
    userConfigDir: safeRelativeDirectory(candidate.userConfigDir, "userConfigDir"),
    cliName: (() => {
      const checked = requiredString(candidate.cliName, "cliName");
      if (!SAFE_CLI_NAME.test(checked)) throw new Error("profile field cliName must be a shell-safe command name");
      return checked;
    })(),
  };
}

/** Resolve defaults once, before persistence, so later loads never guess. */
export function createNamespaceProfile(opts: Partial<NamespaceProfile> & { name: string }): NamespaceProfile {
  const { hookInvocation: _hookInvocation, ...resolved } = resolveNamespace(opts);
  return validateNamespaceProfile(resolved);
}

async function readProfiles(path: string): Promise<ProfileFile> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("root must be an object");
    }
    const file = parsed as Record<string, unknown>;
    if (
      file.version !== 1 ||
      !file.profiles ||
      typeof file.profiles !== "object" ||
      Array.isArray(file.profiles)
    ) {
      throw new Error("expected version 1 and a profiles object");
    }
    const profiles: Record<string, NamespaceProfile> = Object.create(null) as Record<string, NamespaceProfile>;
    for (const [name, profile] of Object.entries(file.profiles as Record<string, unknown>)) {
      validateProfileName(name);
      profiles[name] = validateNamespaceProfile(profile);
    }
    return { version: 1, profiles };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { version: 1, profiles: Object.create(null) as Record<string, NamespaceProfile> };
    }
    throw new Error(`cannot read profiles at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function writeProfiles(path: string, file: ProfileFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

async function withProfileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() > deadline) await rm(lock, { recursive: true, force: true });
      else await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function saveNamespaceProfile(
  repo: RepoInfo | null,
  profileName: string,
  profile: NamespaceProfile,
  scope: ProfileScope = "global",
): Promise<void> {
  validateProfileName(profileName);
  const checked = validateNamespaceProfile(profile);
  const path = profilePath(repo, scope);
  await withProfileLock(path, async () => {
    const file = await readProfiles(path);
    file.profiles[profileName] = checked;
    await writeProfiles(path, file);
  });
}

export async function removeNamespaceProfile(
  repo: RepoInfo | null,
  profileName: string,
  scope: ProfileScope = "global",
): Promise<boolean> {
  validateProfileName(profileName);
  const path = profilePath(repo, scope);
  return withProfileLock(path, async () => {
    const file = await readProfiles(path);
    if (!Object.hasOwn(file.profiles, profileName)) return false;
    delete file.profiles[profileName];
    await writeProfiles(path, file);
    return true;
  });
}

/** Global profiles are defaults; a repository-local descriptor with the same name wins. */
export async function listNamespaceProfiles(repo: RepoInfo | null): Promise<Record<string, NamespaceProfile>> {
  const global = await readProfiles(globalPath());
  if (!repo) return global.profiles;
  const local = await readProfiles(localPath(repo));
  return Object.assign(
    Object.create(null) as Record<string, NamespaceProfile>,
    global.profiles,
    local.profiles,
  );
}

export async function loadNamespaceProfile(
  repo: RepoInfo | null,
  profileName: string,
): Promise<NamespaceProfile> {
  validateProfileName(profileName);
  const profiles = await listNamespaceProfiles(repo);
  if (!Object.hasOwn(profiles, profileName)) throw new Error(`unknown annals profile "${profileName}"`);
  return profiles[profileName]!;
}
