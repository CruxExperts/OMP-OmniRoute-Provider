import { timingSafeCompare } from "@/shared/utils/timingSafeCompare";
const MODEL_SYNC_INTERNAL_AUTH_HEADER = "x-model-sync-internal-auth";

const globalState = globalThis as typeof globalThis & {
  __omnirouteModelSyncInternalAuthToken?: string;
};

let internalAuthToken: string | null = null;

export function isModelSyncInternalRequest(request: { headers: Headers }): boolean {
  if (!internalAuthToken && globalState.__omnirouteModelSyncInternalAuthToken) {
    internalAuthToken = globalState.__omnirouteModelSyncInternalAuthToken;
  }
  const headerToken = request.headers.get(MODEL_SYNC_INTERNAL_AUTH_HEADER);
  return Boolean(
    headerToken && internalAuthToken && timingSafeCompare(headerToken, internalAuthToken)
  );
}
