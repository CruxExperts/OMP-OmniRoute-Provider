/* Replaces only the settings storage boundary; upstream readCache.ts remains intact. */
import { appendFileSync, readFileSync } from "node:fs";
const file = process.env.INGRESS_STATE_FILE;
const events = process.env.INGRESS_EVENT_FILE;
if (!file?.startsWith("/work/data/") || !events?.startsWith("/work/data/")) throw new Error("INGRESS_SANDBOX_PATH_REQUIRED");
const state = JSON.parse(readFileSync(file, "utf8")) as { settings?: Record<string, unknown>; savedMaxBodySizeMb?: number; failSettingsRead?: boolean };
if (!state.settings || typeof state.settings !== "object" || Array.isArray(state.settings)) throw new Error("INGRESS_INVALID_SETTINGS");
function event(name: string) { appendFileSync(events!, JSON.stringify({ event: name }) + "\n", { mode: 0o600 }); }
function unsupported(name: string): never { event(`unsupported:settings:${name}`); throw new Error(`INGRESS_UNSUPPORTED:settings:${name}`); }
export async function getSettings(): Promise<Record<string, unknown>> {
  event("settings:read");
  if (state.failSettingsRead) throw new Error("INGRESS_SETTINGS_BACKEND_ERROR");
  return structuredClone(state.settings!);
}
export function getSavedRequestBodyLimitMb(): number | undefined { event("settings:body-limit"); return state.savedMaxBodySizeMb; }
export function getPricing(): never { return unsupported("getPricing"); }
export function getLKGP(): never { return unsupported("getLKGP"); }
export function setLKGP(): never { return unsupported("setLKGP"); }
export function updateSettings(): never { return unsupported("updateSettings"); }
