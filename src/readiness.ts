import type { HealthSnapshot } from "./health.ts";

export type CredentialPresence = "unknown" | "present" | "missing" | "multiple" | "unsupported" | "unavailable";
export type ReadinessIssue = "config" | "config-conflict" | "corrupt-config" | "insecure-permissions" | "environment-partial" | "environment-invalid" | "credential-lookup" | "binding";

/** Safe facts only: no endpoint, credential, identity, path, or account data. */
export interface ReadinessFacts {
  source: "native" | "environment" | "legacy" | "unknown";
  environmentUrl: boolean;
  environmentKey: boolean;
  profileConfigured: boolean;
  pending: boolean;
  recoveryBlocked: boolean;
  credential: CredentialPresence;
  issue?: ReadinessIssue | undefined;
  health: Pick<HealthSnapshot, "state" | "modelCount" | "rawModelCount" | "stale">;
}

export function formatReadiness(facts: ReadinessFacts): string {
  const source = facts.source === "native" ? "native profile" : facts.source === "environment" ? "environment" : facts.source === "legacy" ? "legacy profile" : "unknown";
  const parts = [`source=${source}`];
  if (facts.source === "native" && (facts.environmentKey || facts.environmentUrl)) parts.push("runtime environment overrides ignored; native source never falls back");
  else if (facts.source === "environment" && facts.profileConfigured) parts.push("environment overrides the saved profile connection");
  if (facts.recoveryBlocked) parts.push("activation unconfirmed; complete verified setup or recovery before use");
  else if (facts.issue === "environment-partial") parts.push("environment connection requires both base URL and API key; supply both or select native setup");
  else if (facts.issue === "environment-invalid") parts.push("environment connection is invalid; correct its base URL or select native setup");
  else if (facts.issue === "config-conflict") parts.push("configuration transaction is busy or requires reconciliation; inspect the OMP profile configuration");
  else if (facts.issue === "corrupt-config") parts.push("configuration is invalid or unsupported; inspect and repair the OMP profile configuration");
  else if (facts.issue === "insecure-permissions") parts.push("configuration permissions are insecure; repair the OMP profile configuration permissions");
  else if (facts.issue === "config") parts.push("configuration unavailable or invalid; inspect and repair the OMP profile configuration");
  else if (facts.issue === "credential-lookup") parts.push("credential lookup failed; inspect OMP credential storage or sign in again");
  else if (facts.issue === "binding") parts.push("connection binding unavailable; inspect setup and retry");
  else if (facts.pending) parts.push("activation pending; use /omniroute recover in an interactive terminal or sign in again");
  else if (facts.credential === "missing") parts.push("runtime key missing; sign in again or complete the selected source");
  else if (facts.credential === "unavailable") parts.push("native credential list unavailable; inspect OMP credential storage or sign in again");
  else if (!facts.profileConfigured && facts.source !== "environment") parts.push("setup required; use /omniroute setup");
  else {
    const { state, modelCount, rawModelCount, stale } = facts.health;
    if (state === "checking") parts.push("checking live model catalog");
    else if (state === "ready") parts.push(`catalog ready; chat models=${modelCount}; live rows=${rawModelCount}`);
    else if (state === "no-models") parts.push(`catalog valid; no chat-compatible models; live rows=${rawModelCount}`);
    else if (state === "unauthorized") parts.push("catalog request unauthorized; check the selected credential or sign in again");
    else if (state === "offline") parts.push(stale ? `catalog offline; stale same-connection models=${modelCount}; retry /omniroute refresh` : "catalog offline; check the connection and retry /omniroute refresh");
    else if (state === "degraded") parts.push("catalog unavailable or invalid; inspect the connection and retry /omniroute refresh");
    else parts.push("connection not ready; inspect setup and retry /omniroute refresh");
  }
  if (facts.credential === "multiple") parts.push("multiple native credential rows; recovery requires exactly one; inspect OMP credentials");
  if (facts.credential === "unsupported") parts.push("native credential is not an eligible API key; sign in again");
  parts.push("catalog access does not independently verify the runtime key");
  return parts.join("; ");
}
