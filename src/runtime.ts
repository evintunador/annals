import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";

export interface RuntimeWriter {
  write(text: string): unknown;
}

interface RuntimeContext {
  stderr: RuntimeWriter;
  env: NodeJS.ProcessEnv;
}

const contexts = new AsyncLocalStorage<RuntimeContext>();

export function runWithRuntimeContext<T>(
  context: RuntimeContext,
  fn: () => Promise<T>,
): Promise<T> {
  return contexts.run(context, fn);
}

export function runtimeStderr(): RuntimeWriter {
  return contexts.getStore()?.stderr ?? process.stderr;
}

export function runtimeEnv(): NodeJS.ProcessEnv {
  return contexts.getStore()?.env ?? process.env;
}

export function runtimeHome(): string {
  return runtimeEnv().HOME || homedir();
}
