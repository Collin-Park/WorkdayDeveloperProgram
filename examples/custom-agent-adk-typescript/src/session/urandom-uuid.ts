import { openSync, readSync } from "node:fs";
import { setIdProvider } from "@google/adk";

// An agent runs in a MicroVM started from a snapshot of the started process,
// so every new MicroVM starts with the same Math.random() state, and ADK's
// default event ids repeat. A conversation that moves to a new microVM then
// repeats earlier event ids, and the Router's upsert by event id overwrites
// earlier events.
//
// Node crypto is not a fix: OpenSSL keeps its generator state in process
// memory, so the snapshot repeats it once anything used crypto before the
// snapshot. The kernel reseeds on restore (VMGenID), so each call reads
// /dev/urandom with no buffer.

const bytes = Buffer.alloc(16);
let urandom: number | undefined;

// A v4 UUID from 16 bytes of /dev/urandom.
export function urandomUuid(): string {
  urandom ??= openSync("/dev/urandom", "r");
  readSync(urandom, bytes, 0, 16, null);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Sets ADK's id provider for the whole process. Calls `uuid` once first: if
// it throws, the provider is not set and this returns false, so the failure
// is not thrown later by every caller.
export function installUrandomIdProvider(uuid: () => string = urandomUuid): boolean {
  try {
    uuid();
  } catch {
    return false;
  }
  setIdProvider(uuid);
  return true;
}
