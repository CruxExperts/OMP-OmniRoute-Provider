import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectedHealthIngressIdentities, validateA2aLifecycleObservation, validateAuthCsrfLifecycleObservation, validateDeprecatedProviderSweepObservation, validateHealthIngressEvidence, validateOidcLifecycleObservation, validateOidcResearchObservation } from "../scripts/generate-contracts.ts";
import type { OperationEvidenceBinding } from "../src/admin/eligibility.ts";

test("CSRF lifecycle requires exact source and independent matching cold and warm outcomes", () => {
  const result = { status: 200, issued: true, noStore: true, cookieMutation: false };
  const phase = (warm: boolean) => ({ databaseExistedBefore: warm, databaseAfterFirst: true, first: result, second: result, firstSettingsUnchanged: warm ? true : null, settingsUnchanged: true });
  const evidence = { status: "research-observed", qualification: false, boundary: "Pinned handler and native core in independent cold and warm processes; not central HTTP authorization or operation qualification.", inputSha256: {}, identity: { csrfClosure: { "src/app/api/auth/csrf/route.ts": "05ed2a77a15c322bdde3614a80b6057a788f99fcd221d90e2eb7a638561491a5", "src/server/authz/csrf.ts": "40db3c3e0696c4e1c4cd0a32a388cd9c6a9e845c5186863cfe090243debbec78", "src/shared/constants/dashboardCsrf.ts": "15abffd3529ec0b63a42360ae44c3afc745038410becea9a2f5b59dd3f02618b" } }, cold: phase(false), warm: phase(true) };
  expect(() => validateAuthCsrfLifecycleObservation(structuredClone(evidence), evidence)).not.toThrow();
  expect(() => validateAuthCsrfLifecycleObservation({ ...evidence, cold: { ...evidence.cold, settingsUnchanged: false } }, evidence)).toThrow();
  expect(() => validateAuthCsrfLifecycleObservation({ ...evidence, identity: {} }, evidence)).toThrow();
  expect(() => validateAuthCsrfLifecycleObservation({ ...evidence, privateField: "private" }, evidence)).toThrow();
  expect(() => validateAuthCsrfLifecycleObservation({ ...evidence, identity: { csrfClosure: { ...evidence.identity.csrfClosure, "src/server/authz/csrf.ts": "a".repeat(64) } } }, evidence)).toThrow();
});
const runner = resolve(import.meta.dir, "../scripts/pinned-ingress.py");
test("OIDC research evidence rejects missing and private fields", () => {
  const errors: Record<string, string> = { nonce: "id_token_invalid", "missing-nonce": "id_token_invalid", "token-missing-nonce": "id_token_invalid", signature: "id_token_invalid", issuer: "id_token_invalid", audience: "id_token_invalid", expired: "id_token_invalid", future: "id_token_invalid", subject: "subject_not_allowed", role: "role_not_allowed", "malformed-role": "role_not_allowed", exchange: "token_exchange", "exchange-network": "token_exchange", "bad-json": "token_response", "no-token": "no_id_token", "missing-code": "missing_code", "missing-state": "missing_code", "wrong-state": "invalid_state", rotation: "id_token_invalid", "rotation-recovery": "dashboard", "no-verifier": "dashboard", "discovery-fallback": "dashboard", success: "dashboard", secure: "dashboard", "missing-secret": "server_misconfigured" };
  const cases = Object.fromEntries(Object.entries(errors).map(([name, result]) => {
    const success = ["success", "secure", "rotation-recovery", "no-verifier", "discovery-fallback"].includes(name), early = ["missing-code", "missing-state", "wrong-state"].includes(name);
    return [name, { loginStatus: 307, loginPublic: true, loginCookiesValid: true, stateMatches: true, nonceMatches: true, challengeMatches: true, callbackStatus: 307, callbackPublic: true, result, stateCleared: !early, clearCookiesValid: success, sessionIssued: success, sessionValid: success, sessionAttributesValid: true, setupComplete: success || name === "missing-secret", exchangeCount: early ? 0 : 1, jwksRequests: ["nonce", "rotation-recovery"].includes(name) ? 1 : 0 }];
  }));
  const config = { loginStatus: 400, loginPublic: true, fixedError: true, noLoginCookies: true, callbackStatus: 307, callbackResult: "not_configured", callbackPublic: true };
  const configCases = { disabled: config, incomplete: config };
  expect(() => validateOidcResearchObservation({ cases, configCases })).not.toThrow();
  expect(() => validateOidcResearchObservation({ cases: { ...cases, success: { ...cases.success, private: "secret" } }, configCases })).toThrow();
  expect(() => validateOidcResearchObservation({ cases: { ...cases, rotation: { ...cases.rotation, result: "dashboard" } }, configCases })).toThrow();
});
test("OIDC settings lifecycle requires independently matching source-bound outcomes", () => {
  const phase = (warm: boolean) => ({ databaseExistedBefore: warm, databaseExistsAfter: true, setupBefore: warm, setupPersisted: true, settingsPersisted: true, callbackStatus: 307, callbackResult: warm ? "dashboard" : "server_misconfigured", sessionIssued: warm });
  const observation = { status: "research-observed", qualification: false, boundary: "local", inputSha256: {}, identity: { oidcCallbackSelectedSha256: "a".repeat(64), oidcClosure: { "src/app/api/auth/oidc/login/route.ts": "560cef9fab79b924c12f7adfffedac346431aaebe16a954f811f71da4c5d1ba6", "src/app/api/auth/oidc/callback/route.ts": "5f7b2a82d550b7190b5853f5b2485e8d7ebb32ff5194ff11f036d5fea7874a52" } }, cold: phase(false), warm: phase(true) };
  expect(() => validateOidcLifecycleObservation(structuredClone(observation), observation)).not.toThrow();
  expect(() => validateOidcLifecycleObservation({ ...observation, cold: { ...observation.cold, setupPersisted: false } }, observation)).toThrow();
});
test("A2A lifecycle observations require independent matching timer and source evidence", () => {
  const phase = (warm: boolean) => ({ databaseExistedBefore: warm, databaseExistsAfter: true, disabled: true, enabled: true, managerTimerCount: 1, activeTaskObserved: true, expiredTaskPersistedFailed: true, timerPurgedOldHistory: true });
  const independent = { status: "research-observed", qualification: false, inputSha256: {}, identity: { a2aClosure: { "src/app/api/a2a/status/route.ts": "d230afbd417035cd919d25853cf03e165392f83b1774739b780dd0000c8f6dc2", "src/lib/a2a/taskManager.ts": "b4fc6379c9cf4b1f3b40e2e9dfae86df77c631014121ed1fa8f87637cb606e4a", "src/lib/db/a2aTasks.ts": "19dbc63c5513f3dfc9b74534eb9805b8c8274d5391ef631110fe76d1b2b3a838" } }, cold: phase(false), warm: phase(true) };
  expect(() => validateA2aLifecycleObservation(structuredClone(independent), independent)).not.toThrow();
  expect(() => validateA2aLifecycleObservation({ ...independent, cold: { ...independent.cold, timerPurgedOldHistory: false } }, independent)).toThrow();
  expect(() => validateA2aLifecycleObservation({ ...independent, identity: {} }, independent)).toThrow();
});
test("MFA source response is closed before projection", async () => {
  // Load the exact JavaScript module copied into the isolated Node ingress worker.
  const path = resolve(import.meta.dir, "fixtures/pinned-ingress/mfa-response.mjs");
  const { projectMfaStatus } = await import(path);
  const source = { enabled: true, backupCodesRemaining: 2, enabledAt: "2025-01-01T00:00:00.000Z", recoverySwitchSet: false };
  expect(projectMfaStatus(source)).toEqual({ enabled: true, backupCodesRemaining: 2, recoverySwitchSet: false });
  for (const changed of [{ ...source, secret: "private" }, { ...source, lastTotpCounter: 42 }, { ...source, enabledAt: 9 }, { ...source, backupCodesRemaining: -1 }]) expect(() => projectMfaStatus(changed)).toThrow();
});
test("sweep evidence rejects private extras and out-of-range backup observations", () => {
  const scenarios = [true, false].map(success => ({ phase: success ? "sweep-success" : "sweep-failure", firstStatus: 200, secondStatus: 200, encryptedAfterFirst: success, encryptedAfterSecond: success, cacheInvalidated: success, nativeBackupCalls: 0, backupCountBefore: 0, backupCountAfter: 0 }));
  const independent = { status: "research-observed", qualification: false, boundary: "fixture", inputSha256: {}, identity: {}, scenarioArguments: [], scenarioEnvironment: {}, scenarios };
  const observed = structuredClone(independent);
  expect(() => validateDeprecatedProviderSweepObservation(observed, independent)).not.toThrow();
  expect(() => validateDeprecatedProviderSweepObservation({ ...observed, privateField: "private-fixture" }, independent)).toThrow();
  expect(() => validateDeprecatedProviderSweepObservation({ ...observed, scenarios: [{ ...scenarios[0], privateField: "private-fixture" }, scenarios[1]] }, independent)).toThrow();
  for (const field of ["nativeBackupCalls", "backupCountBefore", "backupCountAfter"] as const) {
    expect(() => validateDeprecatedProviderSweepObservation({ ...observed, scenarios: [{ ...scenarios[0], [field]: 100000 }, scenarios[1]] }, independent)).toThrow();
  }
  expect(() => validateDeprecatedProviderSweepObservation({ ...observed, scenarios: [{ ...scenarios[0], nativeBackupCalls: 1, backupCountAfter: 2 }, scenarios[1]] }, independent)).not.toThrow();
});


test("effective source rejects a changed capsule rather than falling back to the base", () => {
  const code = String.raw`
import importlib.util,json,pathlib,shutil,sys,tempfile
s=importlib.util.spec_from_file_location('ingress',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d)/'checkout'; (root/'scripts').mkdir(parents=True); (root/'provenance').mkdir()
 shutil.copy(m.ROOT/'scripts/prepare-upstream.py',root/'scripts/prepare-upstream.py')
 capsule='provenance/derivations/omniroute-3.8.53-startup/manifest.json'
 (root/capsule).parent.mkdir(parents=True); (root/capsule).write_bytes(b'tampered')
 pin=json.loads((m.ROOT/'provenance/upstreams.json').read_text())
 upstream=next(x for x in pin['upstreams'] if x['id']=='omniroute')
 upstream['qualification_source']={'kind':'signed-derivation','record':capsule,'sha256':'a'*64}
 (root/'provenance/upstreams.json').write_text(json.dumps(pin))
 try: m.effective_source(pathlib.Path(d)/'absent-archive',root,pathlib.Path(d)/'output')
 except ValueError as e: assert 'digest mismatch' in str(e)
 else: raise AssertionError('invalid capsule accepted')
 assert not (pathlib.Path(d)/'output').exists()
`;
  const result = spawnSync("python3", ["-c", code, runner], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});


test("read ingress rejects missing, contradictory, duplicate, and source-mismatched policy", () => {
  const root = resolve(import.meta.dir, "..");
  const manifest = JSON.parse(readFileSync(resolve(root, "test/fixtures/pinned-ingress/source-manifest.json"), "utf8")) as { commit: string; archiveSha256: string };
  const runtime = JSON.parse(readFileSync(resolve(root, "test/fixtures/pinned-ingress/runtime.json"), "utf8")) as { nodeVersion: string; nodeSha256: string };
  const identities = expectedHealthIngressIdentities("3.8.53", manifest.commit);
  const declarationPath = "test/pinned-ingress.test.ts.inputs.json";
  const declaration = JSON.parse(readFileSync(resolve(root, declarationPath), "utf8")) as { files: string[] };
  const sha256 = Object.fromEntries(["test/pinned-ingress.test.ts", declarationPath, ...declaration.files].map(path => [path, createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex")]));
  const publicCase = (name: string, bypass: string) => ({ name, input: { method: "GET", path: "/api/health", bypass, credential: "none", requireLogin: true, setupComplete: true }, observed: { status: 200, routeClass: "PUBLIC", successMarkerPresent: true, usageStampObserved: false } });
  const policies = ["/api/fallback/chains", "/api/providers/fixture-id/cc-alias", "/api/provider-nodes", "/api/model-capability-overrides", "/api/settings/cc-discovery-metrics", "/api/settings/reasoning-routing-rules", "/api/providers/deprecated"].map(path => ({ method: "GET", path, routeClass: "MANAGEMENT", anonymousStatus: 401, invalidCredentialStatus: 401, authorizedStatus: 200, readScopeStatus: 200, writeScopeStatus: 200, adminScopeStatus: 200 }));
  const reasoningHttp = { method: "GET", path: "/api/settings/reasoning-routing-rules", denied: { status: 401, routeClass: "MANAGEMENT" }, invalid: { status: 401, routeClass: "MANAGEMENT" }, failure: { status: 500, routeClass: "MANAGEMENT", contentType: null, bodyCategory: "empty", privateMarkerPresent: false }, allowed: { status: 200, routeClass: "MANAGEMENT", body: { rules: [] } }, cached: { status: 200, routeClass: "MANAGEMENT", body: { rules: [] } }, sqliteReadCount: 2, sqliteFaultCount: 1 };
  const deprecatedProviderHttp = { denied: { status: 401, routeClass: "MANAGEMENT" }, invalid: { status: 401, routeClass: "MANAGEMENT" }, failure: { status: 500, routeClass: "MANAGEMENT", privateMarkerPresent: false }, allowed: { status: 200, routeClass: "MANAGEMENT", body: { leftovers: [{ provider: "gemini-cli", migrateTo: "gemini", reason: "fixture", connectionIds: Array.from({ length: 105 }, (_, i) => `fixture-${i}`), names: Array.from({ length: 105 }, (_, i) => `name-${i}`) }] } } };
  const artifact = {
    schemaVersion: 1, classification: "research-only-not-qualification",
    source: { version: "3.8.53", commit: manifest.commit, archiveSha256: manifest.archiveSha256, addedSourceSha256: identities.addedSourceSha256, pingDeclarationSha256: identities.pingDeclarationSha256, sourceDerivation: identities.sourceDerivation, effectiveTreeSha256: identities.effectiveTreeSha256 },
    inputs: { sha256, nodeSha256: runtime.nodeSha256, runtime: { node: runtime.nodeVersion, next: "16.4.2", react: "19.2.8", "react-dom": "19.2.8" }, sourceOverlaySha256: identities.sourceOverlaySha256, executedOverlaySha256: identities.executedOverlaySha256 },
    isolation: { namespacesDistinct: true, memoryLimitEnforced: true, cpuLimitEnforced: true, privateLoopbackOnly: true, environmentAllowlisted: true },
    health: [{ method: "GET", path: "/api/health", status: 200, bodyKeys: ["status", "timestamp"], timestamp: "2026-01-01T00:00:00.000Z", cacheControl: "no-store" }],
    publicHealthHttp: { method: "GET", path: "/api/health", anonymous: true, status: 200, bodyKeys: ["status", "timestamp"], timestampFormatAndRequestWindowValid: true, cacheControl: "no-store, no-cache, must-revalidate", contentType: "application/json", routeClass: "PUBLIC", requestIdUuid: true, drain: { status: 503, code: "SERVICE_UNAVAILABLE", message: "Server is shutting down", requestIdUuid: true, correlationMatchesRequestId: true, retryAfter: "5", contentType: "application/json", routeClass: "PUBLIC", recoveryStatus: 200 }, cors: { configuredAllowedOrigin: "https://allowed.example", allowedOriginEchoed: true, unlistedOriginOmitted: true, credentialsOmitted: true } },
    sharedAuthentication: [publicCase("default-bypass-health", "source-default"), publicCase("disabled-bypass-health", "disabled")],
    publicHealthIpFilter: { enabled: true, mode: "blacklist", configReadObserved: true, forwardedAddressFallback: { deniedStatus: 403, error: "IP blacklisted", recoveryStatus: 200, routeClass: "PUBLIC", requestIdUuid: true, allowedOriginEchoed: true } },
    familyPolicy: policies,
    reasoningHttp,
    deprecatedProviderHttp,
    wellKnownHttp: ["agent-card.json", "agent.json"].map(name => ({ method: "GET", path: `/.well-known/${name}`, matcher: "not-matched", anonymous: true, status: 200, contentType: "application/json", cacheControl: "public, max-age=3600", routeClass: null, requestId: null, handlerMarker: name === "agent-card.json" ? "v1" : "legacy", staticSkillCount: 6 })),
  };
  const mediaBinding = { handlerSha256: "a".repeat(64), handlerGitBlobSha: "b".repeat(40) } as OperationEvidenceBinding;
  for (const media of [undefined, [], [{ operationId: "GET /api/fallback/chains", method: "GET", path: "/api/fallback/chains", status: 201, contentType: "application/json" }], [{ operationId: "GET /api/fallback/chains", method: "GET", path: "/api/fallback/chains", status: 200, contentType: "text/plain" }], [{ operationId: "GET /api/fallback/chains", method: "GET", path: "/api/fallback/chains", status: 200, contentType: "application/json", private: "secret" }]]) {
    const value = { ...artifact, supportedJsonHttp: media };
    const bytes = Buffer.from(JSON.stringify(value));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const path = `provenance/qualification/ingress-${digest}.json`;
    const absolute = resolve(root, path);
    writeFileSync(absolute, bytes, { flag: "wx" });
    try { expect(() => validateHealthIngressEvidence({ artifact: path, sha256: digest }, mediaBinding, "GET /api/fallback/chains", ["200"])).toThrow(); } finally { rmSync(absolute); }
  }
  const cases = [
    ["GET /api/fallback/chains", "src/app/api/fallback/chains/route.ts"],
    ["GET /api/providers/{id}/cc-alias", "src/app/api/providers/[id]/cc-alias/route.ts"],
    ["GET /api/provider-nodes", "src/app/api/provider-nodes/route.ts"],
    ["GET /api/model-capability-overrides", "src/app/api/model-capability-overrides/route.ts"],
    ["GET /api/settings/cc-discovery-metrics", "src/app/api/settings/cc-discovery-metrics/route.ts"],
    ["GET /api/settings/reasoning-routing-rules", "src/app/api/settings/reasoning-routing-rules/route.ts"],
    ["GET /api/providers/deprecated", "src/app/api/providers/deprecated/route.ts"],
  ] as const;
  function check(value: unknown, binding: OperationEvidenceBinding, operation: string, error?: RegExp | true) {
    const bytes = Buffer.from(JSON.stringify(value));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const path = `provenance/qualification/ingress-${digest}.json`;
    const absolute = resolve(root, path);
    writeFileSync(absolute, bytes, { flag: "wx" });
    try {
      const validate = () => validateHealthIngressEvidence({ artifact: path, sha256: digest }, binding, operation);
      if (error === true) expect(validate).toThrow(); else if (error) expect(validate).toThrow(error); else expect(validate).not.toThrow();
    } finally { rmSync(absolute); }
  }
  const a2aStatuses: Record<string, number> = { anonymous: 401, invalid: 403, session: 200, "key-read": 403, "key-write": 403, "key-admin": 200, "key-manage": 200, "oma-read": 200, "oma-write": 200, "oma-admin": 200 };
  const a2aStatusHttp = { matcherMatched: true, cases: Object.fromEntries(Object.entries(a2aStatuses).map(([name, status]) => [name, { status, routeClass: "MANAGEMENT", disabled: status === 200 ? true : null }])), enabled: { status: 200, routeClass: "MANAGEMENT", enabled: true, agentName: "OmniRoute AI Gateway", streaming: true, skillCount: 6 }, failure: { status: 500, routeClass: "MANAGEMENT", rawErrorPresent: true } };
  const a2aBinding = { handlerSha256: "d230afbd417035cd919d25853cf03e165392f83b1774739b780dd0000c8f6dc2", handlerGitBlobSha: "4072255a115bd068918763682203c8f909d986df", sourceDerivation: identities.sourceDerivation, effectiveTreeSha256: identities.effectiveTreeSha256 } as OperationEvidenceBinding;
  const closure = identities.a2aStatusClosure as { sources: Record<string, string>; executed: Record<string, string> };
  const a2aArtifact = { ...artifact, a2aStatusHttp, a2aStatusClosure: closure };
  check(a2aArtifact, a2aBinding, "GET /api/a2a/status");
  for (const file of ["src/lib/db/fixtureA2aCache.ts", "src/lib/db/fixtureA2aSettings.ts"]) {
    const missing = { ...closure.executed }; delete missing[file];
    check({ ...a2aArtifact, a2aStatusClosure: { ...closure, executed: missing } }, a2aBinding, "GET /api/a2a/status", /A2A closure mismatch/);
    check({ ...a2aArtifact, a2aStatusClosure: { ...closure, executed: { ...closure.executed, [file]: "0".repeat(64) } } }, a2aBinding, "GET /api/a2a/status", /A2A closure mismatch/);
  }
  const metricGet: Record<string, number> = { anonymous: 401, invalid: 403, session: 200, "key-read": 403, "key-write": 403, "key-manage": 200, "key-admin": 200, "oma-read": 200, "oma-write": 200, "oma-admin": 200 };
  const metricState = (visible: boolean, hidden: number) => ({ visible, hidden });
  const metricHttp = { auth: Object.fromEntries(Object.entries({ GET: metricGet, DELETE: { ...metricGet, "oma-read": 403 } }).map(([method, statuses]) => [method, Object.fromEntries(Object.entries(statuses).map(([name, status]) => [name, { status, routeClass: "MANAGEMENT" }]))])), hiddenOnlyGetNull: true, hiddenOnlyCount: 1, selectedProduction: 1, selectedShadow: 1, selectedHidden: 1, allNames: ["fixture-other", "fixture-selected"], emptyNames: ["fixture-other", "fixture-selected"], prototypeSelected: 1, prototypeInAll: false, seededStates: [metricState(true, 1), metricState(true, 1), metricState(false, 1), metricState(true, 0)], selectedAfterNull: true, unrelatedProduction: 1, unrelatedShadow: 1, unrelatedHidden: 1, selectedStates: [metricState(false, 0), metricState(true, 1), metricState(false, 1), metricState(true, 0)], afterEmptyDeleteNames: [], emptyStates: Array.from({ length: 4 }, () => metricState(false, 0)), afterGlobalNames: [], globalStates: Array.from({ length: 4 }, () => metricState(false, 0)) };
  const metricBinding = { handlerSha256: "e4757286e25c18ad075c5b948bb27cf1e7e3fcb2d01d8053c7d893af9a190416", handlerGitBlobSha: "9266bfc7ba5444f3b8685775d10ad72210050634", sourceDerivation: identities.sourceDerivation, effectiveTreeSha256: identities.effectiveTreeSha256 } as OperationEvidenceBinding;
  for (const method of ["GET", "DELETE"] as const) {
    const policy = { method, path: "/api/combos/metrics", routeClass: "MANAGEMENT", anonymousStatus: 401, invalidCredentialStatus: 401, authorizedStatus: 200, readScopeStatus: method === "GET" ? 200 : 403, writeScopeStatus: 200, adminScopeStatus: 200 };
    const evidence = { ...artifact, familyPolicy: [...policies, policy], comboMetricsHttp: metricHttp };
    check(evidence, metricBinding, `${method} /api/combos/metrics`);
    check({ ...evidence, comboMetricsHttp: { ...metricHttp, hiddenOnlyCount: 0 } }, metricBinding, `${method} /api/combos/metrics`, /combo metrics HTTP mismatch/);
    check({ ...evidence, comboMetricsHttp: undefined }, metricBinding, `${method} /api/combos/metrics`, true);
    check({ ...evidence, comboMetricsHttp: { ...metricHttp, globalStates: [] } }, metricBinding, `${method} /api/combos/metrics`, /combo metrics HTTP mismatch/);
  }
  for (const [index, [operation, route]] of cases.entries()) {
    const routeIdentity = (identities.addedSourceSha256 as Record<string, unknown>)[route];
    if (typeof routeIdentity !== "string" && (!routeIdentity || typeof routeIdentity !== "object" || !("originalSha256" in routeIdentity) || typeof routeIdentity.originalSha256 !== "string")) throw new Error("invalid route identity");
    const binding = { handlerSha256: typeof routeIdentity === "string" ? routeIdentity : routeIdentity.originalSha256, handlerGitBlobSha: "fd13070fad4b50034e2019cd1d75058d871f93cf", sourceDerivation: identities.sourceDerivation, effectiveTreeSha256: identities.effectiveTreeSha256 } as OperationEvidenceBinding;
    check(artifact, binding, operation);
    check({ ...artifact, familyPolicy: undefined }, binding, operation, /familyPolicy/);
    check({ ...artifact, familyPolicy: policies.filter((_, i) => i !== index) }, binding, operation, /family policy observation mismatch/);
    check({ ...artifact, familyPolicy: [...policies, policies[index]] }, binding, operation, /family policy observation mismatch/);
    for (const [key, value] of [["anonymousStatus", 200], ["invalidCredentialStatus", 200], ["authorizedStatus", 403], ["readScopeStatus", 403], ["writeScopeStatus", 403], ["adminScopeStatus", 403], ["routeClass", "PUBLIC"], ["path", "/api/wrong"], ["method", "PATCH"]] as const) {
      check({ ...artifact, familyPolicy: policies.map((policy, i) => i === index ? { ...policy, [key]: value } : policy) }, binding, operation, /family policy observation mismatch/);
    }
    check(artifact, { ...binding, handlerSha256: "0".repeat(64) }, operation, /source mismatch/);
    const corrupted = { ...artifact, source: { ...artifact.source, addedSourceSha256: { ...(identities.addedSourceSha256 as Record<string, unknown>), [route]: "0".repeat(64) } } };
    const bytes = Buffer.from(JSON.stringify(corrupted));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const path = `provenance/qualification/ingress-${digest}.json`;
    const absolute = resolve(root, path);
    writeFileSync(absolute, bytes, { flag: "wx" });
    try { expect(() => validateHealthIngressEvidence({ artifact: path, sha256: digest }, binding, operation)).toThrow(); }
    finally { rmSync(absolute); }
  }
  const deprecatedBinding = { handlerSha256: ((identities.addedSourceSha256 as Record<string, { originalSha256: string }>)["src/app/api/providers/deprecated/route.ts"]!).originalSha256, handlerGitBlobSha: "0".repeat(40), sourceDerivation: identities.sourceDerivation, effectiveTreeSha256: identities.effectiveTreeSha256 } as OperationEvidenceBinding;
  check({ ...artifact, deprecatedProviderHttp: undefined }, deprecatedBinding, "GET /api/providers/deprecated", /deprecated HTTP observation/);
  check({ ...artifact, deprecatedProviderHttp: { ...deprecatedProviderHttp, allowed: { ...deprecatedProviderHttp.allowed, body: { leftovers: [] } } } }, deprecatedBinding, "GET /api/providers/deprecated", /deprecated HTTP/);
  const historyBinding = { handlerSha256: "0c35eb4cffe05b36d66d725049e354fd70bab29e2fade1346760bf80c5e85d01", handlerGitBlobSha: "1b93277bd5560075f14b6453458445ea3ade6daa", sourceDerivation: identities.sourceDerivation, effectiveTreeSha256: identities.effectiveTreeSha256 } as OperationEvidenceBinding;
  check(artifact, historyBinding, "GET /api/a2a/tasks/history", true);
  check({ ...artifact, a2aHistoryHttp: { auth: {}, pages: [], invalid: [], failure: { status: 200, hasTasks: true } } }, historyBinding, "GET /api/a2a/tasks/history", true);
  check(artifact, { ...historyBinding, handlerGitBlobSha: "0".repeat(40) }, "GET /api/a2a/tasks/history", true);
  const analyticsBinding = { handlerSha256: "a29213937ad3210c5edb4a3bf07c4c3bd55d52dca45ff1a76a185e06527ecbf1", handlerGitBlobSha: "27fd7e8350f76a3e1a1429b69344c21ce350d9b5", sourceDerivation: identities.sourceDerivation, effectiveTreeSha256: identities.effectiveTreeSha256 } as OperationEvidenceBinding;
  const analyticsBody = { totalRequests: 5, variantBreakdown: { default: 2, fast: 2, smart: 1 }, topProviders: [{ provider: "alpha", count: 2 }, { provider: "beta", count: 1 }] };
  const analyticsStatuses: Record<string, number> = { anonymous: 401, invalid: 403, inference: 403, session: 200, oma: 200, manage: 200, admin: 200 };
  const analyticsHttp = { auth: Object.fromEntries(Object.entries(analyticsStatuses).map(([name, status]) => [name, { status, routeClass: "MANAGEMENT", body: status === 200 ? analyticsBody : null }])), beforeRows: 7, afterRows: 7, failure: { status: 200, routeClass: "MANAGEMENT", body: { totalRequests: 0, variantBreakdown: {}, topProviders: [] } } };
  const analyticsArtifact = { ...artifact, autoRoutingAnalyticsHttp: analyticsHttp };
  check(analyticsArtifact, analyticsBinding, "GET /api/analytics/auto-routing");
  check({ ...analyticsArtifact, autoRoutingAnalyticsHttp: { ...analyticsHttp, failure: { ...analyticsHttp.failure, status: 500 } } }, analyticsBinding, "GET /api/analytics/auto-routing", true);
  check(analyticsArtifact, { ...analyticsBinding, handlerGitBlobSha: "0".repeat(40) }, "GET /api/analytics/auto-routing", true);
  const compressionBinding = { handlerSha256: "4159741eb6a3a6f0529bf290d0ec2287c56ff604af7ffb7a1689f36353c40fd5", handlerGitBlobSha: "7006cac6eba75683d773afe1b1a1967607063e0f", sourceDerivation: identities.sourceDerivation, effectiveTreeSha256: identities.effectiveTreeSha256 } as OperationEvidenceBinding;
  const compressionHttp = { auth: Object.fromEntries(Object.entries(analyticsStatuses).map(([name, status]) => [name, { status, routeClass: "MANAGEMENT" }])), beforeColumns: 10, deniedColumns: 10, afterColumns: 28, periods: [[1, 30], [1, 30], [1, 30], [2, 50], [3, 60], [4, 65]].map(([totalRequests, totalTokensSaved]) => ({ status: 200, routeClass: "MANAGEMENT", totalRequests, totalTokensSaved, chartLength: 24, chartCount: 1 })), failure: { status: 500, routeClass: "MANAGEMENT", body: { error: "Internal server error" } } };
  const compressionArtifact = { ...artifact, compressionAnalyticsHttp: compressionHttp };
  check(compressionArtifact, compressionBinding, "GET /api/analytics/compression");
  check({ ...compressionArtifact, compressionAnalyticsHttp: { ...compressionHttp, afterColumns: 10 } }, compressionBinding, "GET /api/analytics/compression", true);
  check(compressionArtifact, { ...compressionBinding, handlerGitBlobSha: "0".repeat(40) }, "GET /api/analytics/compression", true);
  const diversityBinding = { handlerSha256: "5309a9f0b87006e3c613aa494c0364cf93f9c81d5c14bdde23865a858d1ba934", handlerGitBlobSha: "15005c7d702621c7eacd93b4b079099a4e1dca65", sourceDerivation: identities.sourceDerivation, effectiveTreeSha256: identities.effectiveTreeSha256 } as OperationEvidenceBinding;
  const diversityBody = { score: 1, totalRequests: 0, providers: {}, windowSize: 200, ttlMs: 3_600_000 };
  const diversityHttp = { auth: Object.fromEntries(Object.entries(analyticsStatuses).map(([name, status]) => [name, { status, routeClass: "MANAGEMENT", body: status === 200 ? diversityBody : null }])) };
  const diversityArtifact = { ...artifact, diversityHttp };
  check(diversityArtifact, diversityBinding, "GET /api/analytics/diversity");
  check({ ...diversityArtifact, diversityHttp: { auth: {} } }, diversityBinding, "GET /api/analytics/diversity", true);
  check(diversityArtifact, { ...diversityBinding, handlerGitBlobSha: "0".repeat(40) }, "GET /api/analytics/diversity", true);
  for (const [index, name] of ["agent-card.json", "agent.json"].entries()) {
    const operation = `GET /.well-known/${name}`;
    const route = `src/app/.well-known/${name}/route.ts`;
    const binding = { handlerSha256: (identities.addedSourceSha256 as Record<string, string>)[route], handlerGitBlobSha: "0".repeat(40), sourceDerivation: identities.sourceDerivation, effectiveTreeSha256: identities.effectiveTreeSha256 } as OperationEvidenceBinding;
    check(artifact, binding, operation);
    check({ ...artifact, wellKnownHttp: [] }, binding, operation, /card HTTP observation mismatch/);
    check({ ...artifact, wellKnownHttp: [...artifact.wellKnownHttp, artifact.wellKnownHttp[index]] }, binding, operation, /card HTTP observation mismatch/);
    for (const [field, value] of [["matcher", "matched"], ["anonymous", false], ["status", 401], ["routeClass", "PUBLIC"], ["requestId", "stamp"], ["handlerMarker", "wrong"], ["cacheControl", "no-store"]] as const) {
      check({ ...artifact, wellKnownHttp: artifact.wellKnownHttp.map((row, i) => i === index ? { ...row, [field]: value } : row) }, binding, operation, /card HTTP observation mismatch/);
    }
    check(artifact, { ...binding, handlerSha256: "0".repeat(64) }, operation, /card source mismatch/);
  }
  const operation = "GET /api/settings/reasoning-routing-rules";
  const route = "src/app/api/settings/reasoning-routing-rules/route.ts";
  const binding = { handlerSha256: "8607798ef6ffb9deed566cea0f25e7c9438be8eb090d1196240fab6a4f6d3018", handlerGitBlobSha: "fd13070fad4b50034e2019cd1d75058d871f93cf", sourceDerivation: identities.sourceDerivation, effectiveTreeSha256: identities.effectiveTreeSha256 } as OperationEvidenceBinding;
  check({ ...artifact, reasoningHttp: undefined }, binding, operation, /reasoning HTTP observation/);
  for (const [field, value] of [["method", "POST"], ["path", "/wrong"], ["sqliteReadCount", 1], ["sqliteFaultCount", 0], ["denied", { status: 200, routeClass: "MANAGEMENT" }], ["invalid", { status: 200, routeClass: "MANAGEMENT" }], ["allowed", { status: 500 }], ["cached", { status: 500 }]] as const) {
    check({ ...artifact, reasoningHttp: { ...reasoningHttp, [field]: value } }, binding, operation, /reasoning HTTP observation/);
  }
  for (const [field, value] of [["status", 503], ["routeClass", null], ["contentType", "text/plain"], ["bodyCategory", "text"], ["privateMarkerPresent", true]] as const) {
    check({ ...artifact, reasoningHttp: { ...reasoningHttp, failure: { ...reasoningHttp.failure, [field]: value } } }, binding, operation, /reasoning HTTP observation/);
  }
  check(artifact, { ...binding, handlerGitBlobSha: "0".repeat(40) }, operation, /reasoning source mismatch/);
  for (const key of ["originalSha256", "executedSha256", "wrapperSha256", "policySha256"]) {
    const changed = structuredClone(artifact);
    ((changed.source.addedSourceSha256 as Record<string, unknown>)[route] as Record<string, unknown>)[key] = "0".repeat(64);
    check(changed, binding, operation, /source mismatch|source identity mismatch/);
  }
}, 120_000);

test("ingress rejects an unapproved Node executable before starting the sandbox", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinned-ingress-"));
  try {
    const node = join(dir, "node");
    const archive = join(dir, "source.tar.gz");
    writeFileSync(node, "wrong runtime");
    writeFileSync(archive, "wrong source");
    const result = spawnSync("python3", [runner, "--node", node, "--source-archive", archive, "--dependency-dir", dir, "--output-dir", dir], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Node runtime mismatch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ingress rejects archive path traversal before materialization", () => {
  const code = `
import importlib.util,sys
spec=importlib.util.spec_from_file_location('ingress',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
for name in ('../escape', '/absolute', 'a/../../escape', 'a\\\\b'):
 try: module.safe_parts(name)
 except RuntimeError: continue
 raise AssertionError(name)
assert module.safe_parts('node_modules/example/package.json') == ('node_modules','example','package.json')
`;
  const result = spawnSync("python3", ["-c", code, runner], { encoding: "utf8" });
  expect(result.status).toBe(0);
});

test("reasoning HTTP export rejects missing fault, cache, privacy, and response evidence", () => {
  const code = String.raw`
import copy,importlib.util,sys
spec=importlib.util.spec_from_file_location('ingress',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
denial={'status':401,'routeClass':'MANAGEMENT'}
success={'status':200,'routeClass':'MANAGEMENT','body':{'rules':[]}}
row={'denied':denial,'invalid':denial,'failure':{'status':503,'routeClass':None,'contentType':'text/plain; charset=utf-8','bodyCategory':'text','privateMarkerPresent':False},'allowed':success,'cached':success}
events=[{'event':'reasoning:read'},{'event':'reasoning:fault'},{'event':'reasoning:read'}]
assert m.validate_reasoning_http(row,events)['failure']['status']==503
def reject(r,e):
 try: m.validate_reasoning_http(r,e)
 except (RuntimeError,KeyError): return
 raise AssertionError('invalid observation accepted')
for key,value in [('status',200),('privateMarkerPresent',True),('bodyCategory','unbounded'),('contentType','private\nstack'),('contentType','text/plain; diagnostic=INGRESS_PRIVATE_REASONING_FAULT')]:
 bad=copy.deepcopy(row); bad['failure'][key]=value; reject(bad,events)
bad=copy.deepcopy(row); del bad['cached']; reject(bad,events)
reject(row,events[:-1]); reject(row,[{'event':'reasoning:read'}]*2)
`;
  const result = spawnSync("python3", ["-c", code, runner], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test("policy controls replace only verified existing source files", () => {
  const code = String.raw`
import importlib.util,pathlib,sys,tempfile
spec=importlib.util.spec_from_file_location('ingress',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d); route=m.POLICY_SOURCES[0]; source=b'authenticated source'; control=b'control'
 m.put(root,route,source); path=root/route; expected=m.sha(source)
 def rejects(name,digest):
  try: m.replace_policy_control(root,name,digest,control)
  except RuntimeError: return
  raise AssertionError('invalid policy source accepted')
 rejects(route,'0'*64); assert path.read_bytes()==source
 path.write_bytes(b'tampered'); rejects(route,expected); assert path.read_bytes()==b'tampered'
 path.unlink(); rejects(route,expected)
 path.symlink_to(root/'missing'); rejects(route,expected); path.unlink()
 m.put(root,route,source)
 try: m.put(root,route,control)
 except RuntimeError: pass
 else: raise AssertionError('duplicate archive path accepted')
 rejects('src/app/api/unapproved/route.ts',expected); assert path.read_bytes()==source
 m.replace_policy_control(root,route,expected,control); assert path.read_bytes()==control
`;
  const result = spawnSync("python3", ["-c", code, runner], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test("dependency materialization enforces exact bytes and safe file identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinned-ingress-dependency-"));
  try {
    const code = `
import base64,hashlib,importlib.util,os,pathlib,sys
spec=importlib.util.spec_from_file_location('ingress',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
root=pathlib.Path(sys.argv[2]); data=b'approved'; path=root/(('a'*64)+'.tgz'); path.write_bytes(data)
item={'name':'example','file':path.name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'integrity':'sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode()}
assert module.verified_dependency(root,item)==data
path.write_bytes(b'tampered')
try: module.verified_dependency(root,item)
except RuntimeError as error: assert 'integrity mismatch' in str(error)
else: raise AssertionError('tampered dependency accepted')
path.unlink()
try: module.verified_dependency(root,item)
except RuntimeError as error: assert 'missing or wrong-size' in str(error)
else: raise AssertionError('missing dependency accepted')
item['file']='../escape.tgz'
try: module.verified_dependency(root,item)
except RuntimeError as error: assert 'invalid package file identity' in str(error)
else: raise AssertionError('escaped dependency accepted')
if os.name != 'nt':
 item['file']=path.name; target=root/'other'; target.write_bytes(data); path.symlink_to(target)
 try: module.verified_dependency(root,item)
 except RuntimeError as error: assert 'missing or wrong-size' in str(error)
 else: raise AssertionError('dependency symlink accepted')
`;
    const result = spawnSync("python3", ["-c", code, runner, dir], { encoding: "utf8" });
    expect(result.status).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("staging rejects unapproved URLs, pre-existing paths, and oversized downloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinned-ingress-stage-"));
  try {
    const code = `
import importlib.util,io,pathlib,sys
spec=importlib.util.spec_from_file_location('ingress',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
for url in ('http://registry.npmjs.org/a.tgz', 'https://registry.npmjs.org.evil.example/a', 'https://user@registry.npmjs.org/a'):
 try: module.validate_url(url, {'registry.npmjs.org'})
 except RuntimeError: continue
 raise AssertionError(url)
module.validate_url('https://registry.npmjs.org/pkg/-/pkg-1.tgz', {'registry.npmjs.org'})
root=pathlib.Path(sys.argv[2]);
for path,approval in ((root/'new','wrong'), (root,module.NODE_ARCHIVE_SHA)):
 try: module.stage(path, approval)
 except RuntimeError: continue
 raise AssertionError('unsafe stage accepted')
module.validate_bwrap=lambda value: value
module.preflight=lambda: None
sys.argv=['pinned-ingress.py','--stage-dir',str(root/'cli-new'),'--approve-node-archive-sha256','wrong']
try: module.main()
except RuntimeError as error: assert 'approval' in str(error).lower()
else: raise AssertionError('CLI accepted an unapproved Node archive')
class Response(io.BytesIO):
 def __enter__(self): return self
 def __exit__(self,*args): self.close()
class Opener:
 def open(self,*args,**kwargs): return Response(b'oversized')
module.urllib.request.build_opener=lambda *args: Opener()
try: module.download('https://registry.npmjs.org/pkg/-/pkg-1.tgz',root/'file',3)
except RuntimeError as error: assert 'byte limit' in str(error)
else: raise AssertionError('oversized download accepted')
`;
    const result = spawnSync("python3", ["-c", code, runner, dir], { encoding: "utf8" });
    expect(result.status).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bubblewrap acquisition preflight checks native packages on multiarch hosts", () => {
  const code = String.raw`
import importlib.util,sys,types
spec=importlib.util.spec_from_file_location('ingress',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.sys.platform='linux'; m.os.uname=lambda: types.SimpleNamespace(machine='x86_64'); m.os.access=lambda *args: True
installed={'libc6:amd64':'2.39', 'libcap2:amd64':'1:2.66', 'libselinux1:amd64':'3.5'}
minima={'libc6:amd64':'2.38', 'libcap2:amd64':'1:2.10', 'libselinux1:amd64':'3.1~'}
queries=[]; comparisons=[]; mode='ok'
def run(args, **kwargs):
 if args[0] == '/usr/bin/dpkg-query':
  package=args[-1]; queries.append(package)
  # An unqualified multiarch query can concatenate amd64 and i386 records.
  if ':' not in package: return types.SimpleNamespace(returncode=0, stdout='install ok installed\t2.39install ok installed\t2.39')
  if mode == 'missing' and package == 'libc6:amd64': return types.SimpleNamespace(returncode=1, stdout='')
  if mode == 'duplicate' and package == 'libc6:amd64': return types.SimpleNamespace(returncode=0, stdout='install ok installed\t2.39install ok installed\t2.39')
  return types.SimpleNamespace(returncode=0, stdout='install ok installed\t'+installed[package])
 assert args[0:2] == ['/usr/bin/dpkg','--compare-versions'] and args[3] == 'ge'
 comparisons.append((args[2],args[4])); return types.SimpleNamespace(returncode=1 if mode == 'old' else 0)
m.subprocess.run=run
m.acquisition_preflight()
assert queries == list(installed)
assert comparisons == [(installed[p],minima[p]) for p in installed]
for mode in ('missing','duplicate','old'):
 try: m.acquisition_preflight()
 except RuntimeError: pass
 else: raise AssertionError('accepted '+mode)
m.os.uname=lambda: types.SimpleNamespace(machine='aarch64')
try: m.acquisition_preflight()
except RuntimeError as e: assert 'Linux x86_64' in str(e)
else: raise AssertionError('accepted unknown architecture')
`;
  const result = spawnSync("python3", ["-c", code, runner], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test("bubblewrap staging rejects missing approval, unsafe paths, tampering, and oversized output", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinned-bwrap-"));
  try {
    const code = `
import importlib.util,io,pathlib,sys
spec=importlib.util.spec_from_file_location('ingress',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
root=pathlib.Path(sys.argv[2])
for path in (None, pathlib.Path('relative/bwrap'), root/'missing'):
 try: module.validate_bwrap(path)
 except RuntimeError: continue
 raise AssertionError('unsafe path accepted')
try: module.stage_bwrap(root/'new', 'wrong')
except RuntimeError as error: assert 'approval' in str(error)
else: raise AssertionError('missing approval accepted')
package=root/'bubblewrap.deb'; package.write_bytes(b'tampered')
try: module.bwrap_members(package)
except RuntimeError as error: assert 'identity mismatch' in str(error)
else: raise AssertionError('tampered package accepted')
module.acquisition_preflight=lambda: None
try: module.stage_bwrap(root, module.BWRAP_SHA)
except RuntimeError as error: assert 'already exists' in str(error)
else: raise AssertionError('existing stage accepted')
executable=root/'bwrap'; executable.write_bytes(b'tampered'); executable.chmod(0o755)
module.bwrap_members_original=module.bwrap_members
module.bwrap_members=lambda path: {'bwrap':b'approved','copyright':b'license'}
try: module.validate_bwrap(executable)
except RuntimeError as error: assert 'identity mismatch' in str(error)
else: raise AssertionError('tampered executable accepted')
class Proc:
 def __init__(self,*args,**kwargs): self.stdout=io.BytesIO(b'x'*(module.BWRAP_LIMIT+1)); self.done=False
 def poll(self): return 0 if self.done else None
 def kill(self): self.done=True
 def wait(self,timeout=None): self.done=True; return 0
module.subprocess.Popen=Proc
module.file_sha=lambda path: module.BWRAP_SHA
package.write_bytes(b'x'*56876)
try: module.bwrap_members_original(package)
except RuntimeError as error: assert 'byte limit' in str(error)
else: raise AssertionError('oversized archive accepted')
`;
    const result = spawnSync("python3", ["-c", code, runner, dir], { encoding: "utf8" });
    expect(result.status).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")("hosted AppArmor profile rejects unauthorized and unsafe attachment contexts", () => {
  const dir = mkdtempSync(join(tmpdir(), "ingress-profile-"));
  try {
    const code = `
import importlib.util,os,pathlib,sys,types
spec=importlib.util.spec_from_file_location('ingress',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.sys.platform='linux'; m.os.uname=lambda: types.SimpleNamespace(machine='x86_64')
root=pathlib.Path(sys.argv[2]); os.environ.update(CI='true',GITHUB_ACTIONS='true',GITHUB_EVENT_NAME='workflow_dispatch',RUNNER_ENVIRONMENT='github-hosted',RUNNER_OS='Linux',GITHUB_RUN_ID='123',GITHUB_RUN_ATTEMPT='1',RUNNER_TEMP=str(root))
os.environ.pop('PINNED_INGRESS_PUSH_CONSENT',None)
def rejected(f):
 try: f()
 except RuntimeError: return
 raise AssertionError('unsafe context accepted')
rejected(lambda: m.ci_profile_context(False))
for key,value in [('RUNNER_ENVIRONMENT','self-hosted'),('GITHUB_EVENT_NAME','push'),('GITHUB_RUN_ID','123*')]:
 old=os.environ[key]; os.environ[key]=value; rejected(lambda: m.ci_profile_context(True)); os.environ[key]=old
os.environ.update(GITHUB_EVENT_NAME='push',GITHUB_REPOSITORY='CruxExperts/OMP-OmniRoute-Provider',GITHUB_REF='refs/heads/main',PINNED_INGRESS_PUSH_CONSENT='14b5371b94572f6c9026888de35af0d48bfaafe10444dbdf9d26c9262496cb6c')
m.ci_profile_context(True)
os.environ['GITHUB_REF']='refs/heads/release/windows-recovery-20261110'; m.ci_profile_context(True)
for key,value in [('GITHUB_EVENT_NAME','pull_request'),('GITHUB_REPOSITORY','fork/OMP-OmniRoute-Provider'),('GITHUB_REF','refs/heads/other'),('PINNED_INGRESS_PUSH_CONSENT',''),('PINNED_INGRESS_PUSH_CONSENT','0'*64),('RUNNER_ENVIRONMENT','self-hosted')]:
 old=os.environ[key]; os.environ[key]=value; rejected(lambda: m.ci_profile_context(True)); os.environ[key]=old
os.environ['GITHUB_EVENT_NAME']='workflow_dispatch'
bad=root/'bad*path'; bad.mkdir(); os.environ['RUNNER_TEMP']=str(bad); rejected(lambda: m.ci_profile_context(True))
os.environ['RUNNER_TEMP']=str(root)
`;
    const result = spawnSync("python3", ["-c", code, runner, dir], { encoding: "utf8" });
    expect(result.status).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")("hosted AppArmor lifecycle refuses collisions and uncertain cleanup", () => {
  const dir = mkdtempSync(join(tmpdir(), "ingress-profile-"));
  try {
    const code = `
import importlib.util,os,pathlib,sys,types
spec=importlib.util.spec_from_file_location('ingress',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.sys.platform='linux'; m.os.uname=lambda: types.SimpleNamespace(machine='x86_64')
root=pathlib.Path(sys.argv[2]); os.environ.update(CI='true',GITHUB_ACTIONS='true',GITHUB_EVENT_NAME='workflow_dispatch',RUNNER_ENVIRONMENT='github-hosted',RUNNER_OS='Linux',GITHUB_RUN_ID='123',GITHUB_RUN_ATTEMPT='1',RUNNER_TEMP=str(root))
path,name,source,state=m.ci_profile_context(True); path.parent.mkdir(); path.write_bytes(b'test helper')
m.os.access=lambda *args: True
m.validate_bwrap=lambda p: p
loaded=[]
m.ci_profiles=lambda name: list(loaded)
def rejected(f):
 try: f()
 except RuntimeError: return
 raise AssertionError('unsafe lifecycle accepted')
access=m.os.access
m.os.access=lambda *args: False
rejected(lambda: m.ci_profile(True)); assert not state.exists()
m.os.access=access
loaded.append(name+' (unconfined)'); rejected(lambda: m.ci_profile(True)); assert not state.exists(); loaded.clear()
state.write_text('{}'); rejected(lambda: m.ci_profile(True,cleanup=True)); assert state.exists(); state.unlink()
def parser(args,**kwargs):
 if args[-1]=='-a': loaded.append(name+' (unconfined)')
 else: loaded.clear()
 return types.SimpleNamespace(returncode=0)
m.subprocess.run=parser
m.ci_profile(True); assert state.exists() and loaded
rejected(lambda: m.ci_profile(True))
m.ci_profile(True,cleanup=True); assert not state.exists() and not loaded
m.ci_profile(True); loaded.clear(); m.ci_profile(True,cleanup=True); assert not state.exists()
calls=[]
def timed_parser(args,**kwargs):
 calls.append(args[-1])
 if args[-1]=='-a':
  if install_before_timeout: loaded.append(name+' (unconfined)')
  raise m.subprocess.TimeoutExpired(args,30)
 loaded.clear()
 return types.SimpleNamespace(returncode=0)
m.subprocess.run=timed_parser
for install_before_timeout in (True,False):
 calls.clear()
 try: m.ci_profile(True)
 except m.subprocess.TimeoutExpired: pass
 else: raise AssertionError('load did not time out')
 assert state.exists() and bool(loaded)==install_before_timeout
 m.ci_profile(True,cleanup=True)
 assert not state.exists() and not loaded
 assert calls==(['-a','-R'] if install_before_timeout else ['-a'])
`;
    const result = spawnSync("python3", ["-c", code, runner, dir], { encoding: "utf8" });
    expect(result.status).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fixture database identity and feature flag reads stay bounded", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinned-ingress-flags-"));
  try {
    const source = readFileSync(resolve(import.meta.dir, "fixtures/pinned-ingress/backend/core.ts"), "utf8");
    const importLine = 'import { API_KEY_COLUMN_FALLBACKS } from "@/lib/db/apiKeyColumnFallbacks";';
    expect(source.split(importLine)).toHaveLength(2);
    const code = source.replace(importLine, "const API_KEY_COLUMN_FALLBACKS: { name: string }[] = [];")
      .replaceAll('"/work/data/"', JSON.stringify(`${dir}/`)) + `
const first = getDbInstance();
if (first !== getDbInstance()) throw new Error("database identity changed");
const query = first.prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?");
if (process.env.EXPECT_FAILURE === "1") {
  try { query.get("feature_flags", "sample"); throw new Error("read unexpectedly succeeded"); }
  catch (error) { if (!(error instanceof Error) || error.message !== "INGRESS_FEATURE_FLAG_BACKEND_ERROR") throw error; }
} else {
  if (query.get("feature_flags", "sample")?.value !== "enabled") throw new Error("override missing");
  if (query.get("feature_flags", "missing") !== undefined || query.get("feature_flags", "toString") !== undefined) throw new Error("unexpected override");
}
`;
    const script = join(dir, "core.ts"), state = join(dir, "state.json"), events = join(dir, "events.jsonl");
    writeFileSync(script, code);
    writeFileSync(events, "");
    for (const fail of [false, true]) {
      writeFileSync(state, JSON.stringify({ tokens: [], featureFlags: { sample: "enabled" }, failFeatureFlagRead: fail }));
      const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, INGRESS_STATE_FILE: state, INGRESS_EVENT_FILE: events, EXPECT_FAILURE: fail ? "1" : "0" } });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }
    expect(readFileSync(events, "utf8").trim().split("\n").map(line => JSON.parse(line).event)).toEqual(Array(4).fill("feature-flag:read"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source flag cache respects expiry, misses, explicit invalidation and database identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinned-ingress-cache-"));
  try {
    const source = readFileSync(resolve(import.meta.dir, "fixtures/pinned-ingress/extracted/feature-flag-cache.ts"), "utf8");
    const code = `
let now = 1000, reads = 0, fail = false;
Date.now = () => now;
const values: Record<string, string> = { flag: "one" };
function makeDb() { return { prepare(sql: string) { if (sql !== "SELECT value FROM key_value WHERE namespace = ? AND key = ?") throw new Error("unexpected query"); return { get(namespace: string, key: string) { if (namespace !== "feature_flags") throw new Error("unexpected namespace"); reads++; if (fail) throw new Error("backend failure"); return Object.hasOwn(values, key) ? { value: values[key] } : undefined; } }; } }; }
let db = makeDb(); function getDbInstance() { return db; }
` + source + `
if (getFeatureFlagOverride("flag") !== "one" || reads !== 1) throw new Error("initial read");
values.flag = "two";
if (getFeatureFlagOverride("flag") !== "one" || reads !== 1) throw new Error("cache miss");
now += 1000;
if (getFeatureFlagOverride("flag") !== "two" || reads !== 2) throw new Error("expiry");
if (getFeatureFlagOverride("missing") !== undefined || getFeatureFlagOverride("missing") !== undefined || reads !== 3) throw new Error("negative cache");
clearFeatureFlagOverrideCache("flag"); values.flag = "three";
if (getFeatureFlagOverride("flag") !== "three" || reads !== 4) throw new Error("invalidation");
db = makeDb(); if (getFeatureFlagOverride("flag") !== "three" || reads !== 5) throw new Error("database identity");
clearFeatureFlagOverrideCache(); fail = true;
try { getFeatureFlagOverride("flag"); throw new Error("failure swallowed"); } catch (error) { if (!(error instanceof Error) || error.message !== "backend failure") throw error; }
fail = false; if (getFeatureFlagOverride("flag") !== "three" || reads !== 7) throw new Error("failure cached");
`;
    const script = join(dir, "cache.ts"); writeFileSync(script, code);
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("read closure extraction rejects source and boundary drift before writing", () => {
  const code = String.raw`
import importlib.util, pathlib, sys, tempfile
s = importlib.util.spec_from_file_location('ingress', sys.argv[1]); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
api = '''let _schemaChecked = false;
async function deleteRedisAuthCacheEntry(
function markApiKeyUsed(
async function getModelPermissionCandidates(
function ensureApiKeysColumns(
export async function getApiKeys(
async function hashKey(
export async function createApiKey(
marker_create();
export async function regenerateApiKey(
export async function deleteApiKey( marker_delete();
/**
 * Revoke an API key by id.
export async function validateApiKey(
/**
 * Check if a model is allowed for a given API key
function clearPreparedStatementCache() { marker_reset(); }
'''
flags = '''const NAMESPACE = "feature_flags";
const CATALOG_RELEVANT_FEATURE_FLAGS =
export function getFeatureFlagOverrides()
/**
 * Persists (or replaces) an override
'''
cache = '''type CacheEntry<T> = { value: T };
const settingsCache = marker_cache;
/**
 * Cached wrapper for getSettings.
export async function getCachedSettings() { marker_settings(); }
export async function getCachedBodySizeSettings() { marker_body(); }
/**
 * Cached wrapper for getPricing.
const rawConnectionsCache = marker_raw;
/**
 * Cached wrapper for getRawProviderConnections.
const connectionByIdCache = marker_id;
/**
 * Cached wrapper for getProviderConnectionById.
let combosCacheVersion = 0;
/**
 * Current combo-cache version.
let modelCatalogCacheVersion = 0;
/**
 * Connection fields written by the chat path
export function invalidateDbCache() { marker_invalidate(); }
'''
encryption = '''import { createCipheriv, marker_crypto };
/** Connection object with potentially encrypted credential fields.
import fs from "fs";
import { mapProviderSpecificDataSecrets
function ensureSecretLoaded() { marker_secret(); if (fs.existsSync(envPath)) fs.readFileSync(envPath, "utf8"); }
/**
 * Loud production warning
export function looksEncrypted( marker_encrypt();
/**
 * #11500
'''
compliance = '''function getDb() { marker_db(); }
type AuditLogWriteEntry
const AUDIT_LOG_REQUIRED_COLUMNS: marker_schema;
type AuditLogQuery
type ApiKeyAuthTouchDbState = marker_audit;
/**
 * Query audit log entries.
'''
backup = '''let _lastBackupAt = 0;
function setStoredDbBackupInteger(
export function getDbBackupMaxFiles() { marker_retention(); }
/** Persist the operator-chosen age-based
export function getDbBackupRetentionDays() { marker_days(); }
function sleep(
export function backupDbFile( marker_backup();
// ──────────────── List Backups
'''
with tempfile.TemporaryDirectory() as tmp:
 app = pathlib.Path(tmp); contents = dict(zip(m.READ_CLOSURES, (api, flags, cache, encryption, compliance, backup)))
 manifest = {'selectedFiles': {}, 'additionalFiles': {}}
 for name, text in contents.items():
  path = app/name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(text)
  m.READ_CLOSURES[name] = m.sha(text.encode()); manifest['selectedFiles'][name] = {'sha256': m.sha(text.encode())}
 result = m.read_closures(app, manifest)
 assert b'marker_reset' in result[next(iter(contents))]
 assert b'marker_settings' in result['src/lib/db/readCache.ts'] and b'marker_body' in result['src/lib/db/readCache.ts']
 assert b'marker_create' in result['src/lib/db/apiKeys.ts'] and b'marker_delete' in result['src/lib/db/apiKeys.ts']
 assert b'marker_secret' in result['src/lib/db/encryption.ts'] and b'marker_encrypt' in result['src/lib/db/encryption.ts']
 assert b'marker_schema' in result['src/lib/compliance/index.ts'] and b'marker_audit' in result['src/lib/compliance/index.ts']
 assert b'marker_retention' in result['src/lib/db/backup.ts'] and b'marker_backup' in result['src/lib/db/backup.ts']
 flag_fixture = (m.FIXTURE/'extracted/feature-flag-cache.ts').read_text()
 prefix, marker, suffix = flag_fixture.partition('export function getFeatureFlagOverride(key: string)')
 flag_source = prefix + 'const unrelated = 1;\n' + marker + suffix
 m.verify_flag_cache_fixture(flag_source, flag_fixture)
 for altered in (flag_fixture.replace('OVERRIDE_CACHE_TTL_MS = 1000', 'OVERRIDE_CACHE_TTL_MS = 999'), flag_fixture + 'changed'):
  try: m.verify_flag_cache_fixture(flag_source, altered); raise AssertionError('fixture drift accepted')
  except RuntimeError: pass
 try: m.verify_flag_cache_fixture(flag_source + marker + suffix, flag_fixture); raise AssertionError('ambiguous fixture accepted')
 except RuntimeError: pass
 path = app/'src/lib/db/readCache.ts'; path.write_text(cache + 'drift')
 try: m.read_closures(app, manifest); raise AssertionError('source drift accepted')
 except RuntimeError: pass
 changed = cache.replace('const rawConnectionsCache =', 'const alteredCache ='); path.write_text(changed)
 m.READ_CLOSURES['src/lib/db/readCache.ts'] = m.sha(changed.encode()); manifest['selectedFiles']['src/lib/db/readCache.ts']['sha256'] = m.sha(changed.encode())
 try: m.read_closures(app, manifest); raise AssertionError('boundary drift accepted')
 except RuntimeError: pass
 changed = cache + '\nexport function invalidateDbCache() {}'; path.write_text(changed)
 m.READ_CLOSURES['src/lib/db/readCache.ts'] = m.sha(changed.encode()); manifest['selectedFiles']['src/lib/db/readCache.ts']['sha256'] = m.sha(changed.encode())
 try: m.read_closures(app, manifest); raise AssertionError('ambiguous suffix accepted')
 except RuntimeError: pass
`;
  const result = spawnSync("python3", ["-c", code, runner], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test("source overlays reject missing or mismatched originals and replacements before copying", () => {
  const code = String.raw`
import importlib.util, json, pathlib, sys, tempfile
s = importlib.util.spec_from_file_location('ingress', sys.argv[1]); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
with tempfile.TemporaryDirectory() as temp:
 root = pathlib.Path(temp); app = root/'app'; fixture = root/'fixture'; app.mkdir(); fixture.mkdir()
 mapping = json.loads((m.FIXTURE/'alias-map.json').read_text()); manifest = {'selectedFiles':{},'additionalFiles':{},'nextConfig':{}}
 config = b'config'; (app/'next.config.upstream.mjs').write_bytes(config); mapping['originalConfigSha256'] = m.sha(config); manifest['nextConfig']['sha256'] = m.sha(config)
 for alias in mapping['aliases']:
  original = b'export const value = 1;\n'; replacement = original if alias['kind'] == 'declaration-extraction' else b'fixture'
  source = app/alias['source']; target = fixture/alias['replacement']; source.parent.mkdir(parents=True, exist_ok=True); target.parent.mkdir(parents=True, exist_ok=True); source.write_bytes(original); target.write_bytes(replacement)
  alias['sourceSha256'] = m.sha(original); alias['replacementSha256'] = m.sha(replacement); manifest['selectedFiles'][alias['source']] = {'sha256':m.sha(original)}
 (fixture/'alias-map.json').write_text(json.dumps(mapping))
 def rejected():
  try: m.overlay_plan(app, fixture, manifest)
  except (RuntimeError, FileNotFoundError): return
  raise AssertionError('invalid overlay accepted')
 for alias in mapping['aliases']:
  for path in (app/alias['source'], fixture/alias['replacement']):
   original = path.read_bytes(); path.write_bytes(b'tampered'); rejected(); path.unlink(); rejected(); path.write_bytes(original)
 core = next(a for a in mapping['aliases'] if a['source'] == 'src/lib/db/core.ts')
 path = app/core['source']; base = path.read_bytes(); repaired = b'repaired core'; path.write_bytes(repaired)
 change = {'input_sha256':m.sha(base),'output_sha256':m.sha(repaired)}
 derived = m.overlay_plan(app,fixture,manifest,{core['source']:change})
 assert next(a for a in derived if a['source']==core['source'])['sourceSha256'] == m.sha(repaired)
 for invalid in ({**change,'input_sha256':'0'*64},{**change,'output_sha256':'0'*64}):
  try: m.overlay_plan(app,fixture,manifest,{core['source']:invalid})
  except RuntimeError: pass
  else: raise AssertionError('incorrect derivation identity accepted')
 path.write_bytes(base)
 aliases = m.overlay_plan(app, fixture, manifest)
 result = m.apply_overlays(app, fixture, aliases)
 assert len(result) == 6 and all(m.sha((app/a['source']).read_bytes()) == result[a['source']]['executedSha256'] for a in aliases)
`;
  const result = spawnSync("python3", ["-c", code, runner], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test("ingress failure evidence is bounded, source-bound, and excludes private data", () => {
  const code = String.raw`
import importlib.util, json, pathlib, subprocess, sys, tempfile
s = importlib.util.spec_from_file_location('ingress', sys.argv[1]); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
with tempfile.TemporaryDirectory() as temp:
 root = pathlib.Path(temp); output = root/'ingress-run'; output.mkdir()
 hashes = {'tracked': 'a'*64}; m.input_hashes = lambda: hashes
 state = output/'failure-state.json'
 state.write_text(json.dumps({'stage':'build','exceptionClass':'CalledProcessError','returnCode':-9}))
 (output/'build.private').write_text('private-canary /path/private-account token\nModule not found: cannot find module secret-package\nEROFS: read-only file system\n')
 assert m.worker_failure_state(output) == ('build','CalledProcessError',-9)
 m.write_failure(output, hashes, *m.worker_failure_state(output))
 artifact = json.loads((root/'failure.json').read_text())
 assert set(artifact) == {'schemaVersion','classification','stage','exceptionClass','exitCode','signal','sourceCommit','sourceArchiveSha256','nodeSha256','trackedInputsSha256','compilerSignals'}
 assert artifact['compilerSignals'] == ['module-not-found','read-only-output']
 (output/'build.private').write_text('private-canary unknown compiler failure')
 assert m.compiler_failure_signals(output) == []
 (output/'build.private').write_text('  42 | // permission denied or EACCES may occur\n> 43 | throw new Error("permission denied");\n')
 assert m.compiler_failure_signals(output) == []
 (output/'build.private').write_text('Error: EACCES: permission denied, open private-path\n')
 assert m.compiler_failure_signals(output) == ['permission-denied']
 (output/'build.private').unlink(); (output/'build.private').symlink_to(state)
 assert m.compiler_failure_signals(output) == []
 (output/'build.private').unlink()
 assert m.compiler_failure_signals(output) == []
 assert artifact['stage'] == 'build' and artifact['signal'] == 9 and artifact['exitCode'] is None
 assert artifact['sourceCommit'] == m.COMMIT and artifact['nodeSha256'] == m.NODE_SHA and artifact['sourceArchiveSha256'] == m.ARCHIVE_SHA
 assert artifact['trackedInputsSha256'] == m.sha(json.dumps(hashes, sort_keys=True, separators=(',', ':')).encode())
 assert m.failure_class(m.CandidateFailed(42)) == 'CalledProcessError' and m.failure_code(m.CandidateFailed(42)) == 42
 assert m.failure_class(RuntimeError('private-canary /path token')) == 'RuntimeError'
 assert 'private-canary' not in json.dumps(artifact) and '/path' not in json.dumps(artifact)
 for bad in ({'stage':'private-canary','exceptionClass':'RuntimeError','returnCode':1}, {'stage':'build','exceptionClass':'RuntimeError','returnCode':True}, {'stage':'build','exceptionClass':'private-canary','returnCode':1}):
  state.write_text(json.dumps(bad)); assert m.worker_failure_state(output) == ('preflight',None,None)
 try: m.write_failure(output, hashes, 'build', 'RuntimeError', 1)
 except FileExistsError: pass
 else: raise AssertionError('existing artifact overwritten')
 (root/'failure.json').unlink()
 (output/'cold-lifecycle.private').write_text('Error: Database health check already in progress\nprivate-canary /path token')
 m.write_failure(output, hashes, 'coldLifecycle', 'CalledProcessError', 1)
 lifecycle = json.loads((root/'failure.json').read_text())
 assert lifecycle['lifecyclePhase']=='cold' and lifecycle['lifecycleSignals']==['health-check-in-progress']
 assert 'private-canary' not in json.dumps(lifecycle) and '/path' not in json.dumps(lifecycle)
 (output/'app').mkdir(); (output/'app/package.json').write_text(json.dumps({'dependencies':{'sql.js':'1'}}))
 (output/'core-identity.json').write_text(json.dumps({'sourceFilesSha256':{'src/lib/db/core.ts':'a'*64,'../private/secret':'b'*64}}))
 (output/'lifecycle-progress.json').write_text(json.dumps({'phase':'cold','stage':'before-initialize'}))
 (output/'cold-lifecycle.private').write_text("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'sql.js' imported from /private/secret\nCannot find module '/work/app/src/lib/db/core.ts'\nCannot find module '/work/app/../private/secret'\nCannot find package 'private-canary'\nWarning: unsettled top-level await\n")
 assert m.lifecycle_failure_signals(output, 'coldLifecycle') == ['module-resolution','unsettled-top-level-await']
 diagnostics = m.lifecycle_diagnostics(output, 'coldLifecycle')
 assert diagnostics == {'checkpoint':'before-initialize','moduleErrors':['/work/app/src/lib/db/core.ts','sql.js'],'moduleErrorCodes':['ERR_MODULE_NOT_FOUND']}
 assert 'private' not in json.dumps(diagnostics)
 (root/'failure.json').unlink()
 m.write_failure(output, hashes, 'coldLifecycle', 'CalledProcessError', 13)
 exported = json.loads((root/'failure.json').read_text())
 assert exported['lifecycleDiagnostics'] == diagnostics and exported['exitCode'] == 13
 assert 'private' not in json.dumps(exported)
 assert m.lifecycle_diagnostics(output, 'warmLifecycle')['checkpoint'] is None
 (output/'lifecycle-progress.json').write_text(json.dumps({'phase':'cold','stage':'private-canary'}))
 assert m.lifecycle_diagnostics(output, 'coldLifecycle')['checkpoint'] is None
 (output/'lifecycle-progress.json').unlink(); (output/'lifecycle-progress.json').symlink_to(state)
 assert m.lifecycle_diagnostics(output, 'coldLifecycle')['checkpoint'] is None
 (output/'warm-lifecycle.private').write_text('ERR_MODULE_NOT_FOUND: /private/secret')
 assert m.lifecycle_failure_signals(output, 'warmLifecycle') == ['module-resolution']
 (output/'warm-lifecycle.private').unlink(); (output/'warm-lifecycle.private').symlink_to(state)
 assert m.lifecycle_failure_signals(output, 'warmLifecycle') == []
 (root/'failure.json').unlink(); hashes['changed'] = 'b'*64
 try: m.write_failure(output, {'tracked':'a'*64}, 'export', 'RuntimeError', None)
 except RuntimeError: pass
 else: raise AssertionError('changed source accepted')
 assert not (root/'failure.json').exists()
`;
  const result = spawnSync("python3", ["-c", code, runner], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test("ingress export rejects incomplete and contradictory observations and never copies private fields", () => {
  const code = String.raw`
import importlib.util, io, json, pathlib, sys, tarfile, tempfile
s = importlib.util.spec_from_file_location('ingress', sys.argv[1]); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
with tempfile.TemporaryDirectory() as temp:
 p = pathlib.Path(temp); (p / 'data').mkdir()
 def put(name, value): (p / name).write_text(json.dumps(value))
 hashes = m.input_hashes()
 fixture = p/'fixture'; (fixture/'backend').mkdir(parents=True)
 core = b'const db = {\n      const normalized = sql.replace(/\\s+/g, " ").trim();\n};\n'
 settings = b'export const fixture = true;\n'
 (fixture/'backend/core.ts').write_bytes(core); (fixture/'backend/settings.ts').write_bytes(settings)
 for name, data in [('backend/core.ts',core),('backend/settings.ts',settings)]: hashes['test/fixtures/pinned-ingress/'+name] = m.sha(data)
 declaration = b'export function pingDb(): boolean {\n  return true;\n}'
 aliases = json.loads((m.FIXTURE/'alias-map.json').read_text())['aliases']
 names = set(m.ROUTES) | set(m.POLICY_SOURCES) | set(m.COMBO_METRICS_CLOSURE) | set(m.READ_CLOSURES) | set(m.ACP_AUTH_SOURCES) | {m.ACP_ROUTE,m.ACP_REGISTRY,m.ACP_MANIFEST,m.ACP_PEER_STAMP,m.LIVE_ROUTE,m.REASONING_STORE,'src/lib/db/core.ts','src/lib/api/requireManagementAuth.ts','src/app/api/health/route.ts','src/proxy.ts'} | {a['source'] for a in aliases}
 names |= set(m.CONCURRENCY_OWNERS) | {m.VISIBILITY_PROXIES,'open-sse/services/rateLimitManager/bodyRetryPause.ts'}
 sources = {name: ('source:'+name).encode() for name in names}; sources['src/lib/db/core.ts'] = b'// source\n'+declaration+b'\n'
 sources[m.DEPRECATED_HELPER]=b'helper'; sources[m.DEPRECATED_REGISTRY]=b'registry'
 m.deprecated_ingress_source=lambda route,helper,registry:(route+b':executed',helper+b':executed',registry+b':executed')
 m.concurrency_route_bytes=lambda route: route+b':executed'
 m.concurrency_manager_bytes=lambda data:data+b':executed'
 m.concurrency_pause_bytes=lambda data:data+b':executed'
 m.visibility_route_bytes=lambda data:data+b':executed'
 m.visibility_proxies_bytes=lambda data:data+b':executed'
 sources[m.AUTH_SESSION] = b'session'; sources[m.AUTH_SHARED] = b'shared'
 sources[m.LOGIN_PASSWORD] = b'password'; sources[m.LOGIN_FLAGS] = b'flags'
 m.require_login_closure = lambda source, cache, flags: {m.REQUIRE_LOGIN:b'login-route-executed','src/lib/db/fixtureLoginSettings.ts':b'login-settings-executed','src/shared/utils/fixtureLoginFlags.ts':b'login-flags-executed'}
 for name in m.LOGIN_DEPENDENCIES: sources.setdefault(name, ('source:'+name).encode())
 for name in m.OIDC_CLOSURE: sources.setdefault(name, ('source:'+name).encode())
 for name in m.BATCH_SOURCES: sources.setdefault(name, ('source:'+name).encode())
 m.batch_graph=lambda source:{m.BATCH_LIST:b'list-executed',m.BATCH_ITEM:b'item-executed','src/lib/db/fixtureBatchCore.ts':b'core-executed','src/lib/db/fixtureBatchStore.ts':b'store-executed','src/lib/db/fixtureBatchFiles.ts':b'files-executed'}
 m.oidc_closure = lambda source, cache: {m.OIDC_LOGIN:b'oidc-login-executed',m.OIDC_CALLBACK:b'oidc-callback-executed','src/lib/db/fixtureOidcSettings.ts':b'oidc-settings-executed'}
 m.auth_status_closure = lambda source, cache: {m.AUTH_STATUS:b'route-executed',m.AUTH_SESSION:b'session-executed','src/lib/db/fixtureAuthStatusCache.ts':b'cache-executed','src/lib/db/fixtureAuthStatusSettings.ts':b'settings-executed'}
 m.mfa_status_closure = lambda source: {m.MFA_STATUS:b'mfa-route-executed','src/server/auth/fixtureDashboardMfaStatus.ts':b'mfa-dashboard-executed','src/lib/db/fixtureDashboardMfaStatus.ts':b'mfa-storage-executed','src/server/auth/fixtureMfaRouteSupport.ts':b'mfa-support-executed','src/lib/db/fixtureMfaStatusCore.ts':b'mfa-core-executed'}
 m.sso_config_closure = lambda source, cache: {m.SSO_CONFIG:b'sso-route-executed','src/server/authz/entra/fixtureSsoConfig.ts':b'sso-config-executed','src/lib/db/fixtureSsoCache.ts':b'sso-cache-executed','src/lib/db/fixtureSsoSettings.ts':b'sso-settings-executed'}
 m.a2a_status_closure = lambda source, cache: {'src/app/api/a2a/status/route.ts':b'a2a-route-executed','src/lib/db/fixtureA2aCache.ts':b'a2a-cache-executed','src/lib/db/fixtureA2aSettings.ts':b'a2a-settings-executed'}
 sources[m.ACP_REGISTRY] = b'import { execFileSync } from "child_process";\n'
 m.READ_CLOSURES = {name:m.sha(sources[name]) for name in m.READ_CLOSURES}
 m.read_closures = lambda app, manifest: {name:(app/name).read_bytes()+b':executed' for name in m.READ_CLOSURES}
 for alias in aliases:
  alias['sourceSha256'] = m.sha(sources[alias['source']]); alias['replacementSha256'] = hashes['test/fixtures/pinned-ingress/'+alias['replacement']]
 map_bytes = json.dumps({'aliases':aliases}).encode(); (fixture/'alias-map.json').write_bytes(map_bytes)
 hashes['test/fixtures/pinned-ingress/alias-map.json'] = m.sha(map_bytes)
 archive_path = p/'source.tar.gz'
 with tarfile.open(archive_path, 'w:gz') as archive:
  for name, data in sources.items():
   member = tarfile.TarInfo('OmniRoute-v3.8.53/'+name); member.size = len(data); archive.addfile(member, io.BytesIO(data))
 m.SOURCE = archive_path; m.ARCHIVE_SHA = m.sha(archive_path.read_bytes()); m.FIXTURE = fixture
 m.effective_source_identities = lambda archive: {'effectiveTreeSha256':'a'*64}
 m.approved_source = lambda: sources
 (fixture/'dependencies.json').write_bytes((pathlib.Path(sys.argv[1]).parent.parent/'test/fixtures/pinned-ingress/dependencies.json').read_bytes())
 manifest = {'selectedFiles':{'src/proxy.ts':{'sha256':m.sha(sources['src/proxy.ts'])}},'additionalFiles':{m.LIVE_ROUTE:{'sha256':m.sha(sources[m.LIVE_ROUTE])}}}
 manifest_bytes = json.dumps(manifest).encode(); (fixture/'source-manifest.json').write_bytes(manifest_bytes)
 hashes['test/fixtures/pinned-ingress/source-manifest.json'] = m.sha(manifest_bytes)
 expected_core = (b'import path from "node:path";\nlet sqlite: DatabaseSync | undefined;\n'
  b'const db = {\n      const normalized = sql.replace(/\\s+/g, " ").trim();\n'
  b'      if (normalized === "SELECT 1 AS ok" || (/^SELECT /i.test(normalized) && /\\bFROM usage_history\\b/i.test(normalized))) {\n'
  b'        event("sqlite:read");\n        sqlite ??= new DatabaseSync("/work/data/metrics.sqlite");\n'
  b'        return sqlite.prepare(sql);\n      }\n};\n\nexport const DB_BACKUPS_DIR = isCloud ? null : path.join(DATA_DIR, "db_backups");\n'+declaration+b'\n')
 expected_settings = settings+b'\nexport { getCacheMetrics, resetCacheMetrics } from "@/lib/db/settings/cacheMetrics";\n'
 material = {'archiveSha256': m.ARCHIVE_SHA, 'effectiveTreeSha256':'a'*64, 'webpackDeviation': False, 'bundler':'next-default', 'selectedSourceFiles': 509, 'configSupportSha256':{'src/proxy.ts':m.sha(sources['src/proxy.ts']),m.LIVE_ROUTE:m.sha(sources[m.LIVE_ROUTE])}}
 put('result.json', {'status':'research-observed', 'qualification':False, 'materialization':material})
 put('materialization.json', material)
 put('host-namespaces.json', {k:'host' for k in ('user','mnt','net','pid')})
 put('preflight.json', {'namespaces':{k:'sandbox' for k in ('user','mnt','net','pid')}, 'memoryMax':m.MEMORY, 'cpuAffinity':[0], 'network':'private-loopback-only', 'nodeSha256':m.NODE_SHA, 'environmentKeys':['PATH'], 'mountInfo':'private-canary'})
 identity_names = set(m.ROUTES) | set(m.POLICY_SOURCES) | set(m.COMBO_METRICS_CLOSURE) | {'src/lib/db/core.ts','src/lib/api/requireManagementAuth.ts','src/app/api/health/route.ts'}
 identity = {'sourceCommit':m.COMMIT,'sourceVersion':'3.8.53','archiveSha256':m.ARCHIVE_SHA,'nodeSha256':m.NODE_SHA,'runtime':{'node':'24.17.0','next':'16.4.2','react':'19.2.8','react-dom':'19.2.8'},'addedSourceSha256':{k:m.sha(sources[k]) for k in identity_names},'pingDeclarationSha256':m.sha(declaration),'runtimeInputSha256':{n:hashes['test/fixtures/pinned-ingress/'+n] for n in ('source-manifest.json','dependencies.json','runtime.json')}}
 identity['addedSourceSha256'].update({name:m.sha(sources[name]) for name in (m.ACP_ROUTE,m.ACP_MANIFEST,m.ACP_PEER_STAMP,*m.ACP_AUTH_SOURCES)})
 identity['addedSourceSha256'][m.ACP_REGISTRY] = {'originalSha256':m.sha(sources[m.ACP_REGISTRY]),'executedSha256':m.sha(m.acp_registry_bytes(sources[m.ACP_REGISTRY])),'processBoundarySha256':m.sha(m.acp_process_boundary()),'ownedProbeSha256':m.sha(m.ACP_PROBE)}
 identity['effectiveTreeSha256'] = 'a'*64
 identity['addedSourceSha256'][m.LIVE_ROUTE] = {'originalSha256':m.sha(sources[m.LIVE_ROUTE]),'executedSha256':m.sha(sources[m.LIVE_ROUTE])}
 reasoning_sha = m.sha(sources[m.REASONING_ROUTE])
 identity['addedSourceSha256'][m.REASONING_ROUTE] = {'originalSha256':reasoning_sha,'executedSha256':reasoning_sha,'wrapperSha256':m.sha(m.REASONING_WRAPPER),'policySha256':hashes['test/fixtures/pinned-ingress/routes/management.ts']}
 combo_sha=m.sha(sources[m.COMBO_METRICS_ROUTE])
 identity['addedSourceSha256'][m.COMBO_METRICS_ROUTE]={'originalSha256':combo_sha,'executedSha256':combo_sha,'wrapperSha256':m.sha(m.COMBO_METRICS_WRAPPER),'policySha256':hashes['test/fixtures/pinned-ingress/routes/management.ts']}
 identity['addedSourceSha256'][m.REASONING_STORE] = m.sha(sources[m.REASONING_STORE])
 dr,dh,dt=m.deprecated_ingress_source(sources[m.DEPRECATED_ROUTE],sources[m.DEPRECATED_HELPER],sources[m.DEPRECATED_REGISTRY])
 identity['addedSourceSha256'][m.DEPRECATED_ROUTE]={'originalSha256':m.sha(sources[m.DEPRECATED_ROUTE]),'executedSha256':m.sha(dr),'wrapperSha256':m.sha(m.REASONING_WRAPPER),'backendSha256':m.sha(m.DEPRECATED_BACKEND),'helperOriginalSha256':m.sha(sources[m.DEPRECATED_HELPER]),'helperExecutedSha256':m.sha(dh),'registryOriginalSha256':m.sha(sources[m.DEPRECATED_REGISTRY]),'registryExecutedSha256':m.sha(dt)}
 identity['proxyIdentity'] = {'originalSha256':m.sha(sources['src/proxy.ts']),'executedSha256':m.sha(sources['src/proxy.ts'])}
 for name in ('src/app/api/health/degradation/route.ts','src/domain/degradation.ts'):
  data = sources[name]; executed = b'import "./fixture-control";\n'+data if name.endswith('/route.ts') else data
  identity['addedSourceSha256'][name] = {'originalSha256':m.sha(data),'executedSha256':m.sha(executed)}
 identity['addedSourceSha256'].update({name:{'originalSha256':sha,'executedSha256':m.sha(sources[name]+b':executed')} for name,sha in m.READ_CLOSURES.items()})
 graph = m.auth_status_closure(sources,b'cache')
 identity['addedSourceSha256'][m.AUTH_STATUS] = {'originalSha256':m.sha(sources[m.AUTH_STATUS]),'executedSha256':m.sha(graph[m.AUTH_STATUS])}
 identity['authStatusClosure'] = {'sources':{name:m.sha(sources[name]) for name in (m.AUTH_STATUS,m.AUTH_SESSION,m.AUTH_SETTINGS,m.AUTH_SHARED)},'executed':{name:m.sha(data) for name,data in graph.items()}}
 mfa_graph = m.mfa_status_closure(sources)
 identity['addedSourceSha256'][m.MFA_STATUS] = {'originalSha256':m.sha(sources[m.MFA_STATUS]),'executedSha256':m.sha(mfa_graph[m.MFA_STATUS])}
 identity['mfaStatusClosure'] = {'sources':{name:m.sha(sources[name]) for name in (m.MFA_STATUS,m.MFA_DASHBOARD,m.MFA_STORAGE,m.MFA_SUPPORT)},'executed':{name:m.sha(data) for name,data in mfa_graph.items()}}
 sso_graph = m.sso_config_closure(sources,b'cache')
 identity['addedSourceSha256'][m.SSO_CONFIG] = {'originalSha256':m.sha(sources[m.SSO_CONFIG]),'executedSha256':m.sha(sso_graph[m.SSO_CONFIG])}
 identity['ssoConfigClosure'] = {'sources':{name:m.sha(sources[name]) for name in (m.SSO_CONFIG,m.SSO_ENTRA,m.AUTH_SETTINGS,m.AUTH_SHARED)},'executed':{name:m.sha(data) for name,data in sso_graph.items()}}
 login_graph = m.require_login_closure(sources,b'cache',b'flags')
 identity['addedSourceSha256'][m.REQUIRE_LOGIN] = {'originalSha256':m.sha(sources[m.REQUIRE_LOGIN]),'executedSha256':m.sha(login_graph[m.REQUIRE_LOGIN])}
 identity['requireLoginClosure'] = {'sources':{name:m.sha(sources[name]) for name in (m.REQUIRE_LOGIN,m.LOGIN_FLAGS,m.LOGIN_PASSWORD,m.LOGIN_RUNTIME,m.AUTH_SESSION,m.AUTH_SETTINGS,m.AUTH_SHARED,*m.LOGIN_DEPENDENCIES)},'executed':{name:m.sha(data) for name,data in login_graph.items()}}
 a2a_name = 'src/app/api/a2a/status/route.ts'; a2a_graph = m.a2a_status_closure(sources,b'cache')
 identity['addedSourceSha256'][a2a_name] = {'originalSha256':m.sha(sources[a2a_name]),'executedSha256':m.sha(a2a_graph[a2a_name])}
 identity['a2aStatusClosure'] = {'sources':{name:m.sha(sources[name]) for name in (a2a_name,m.AUTH_SETTINGS,m.AUTH_SHARED)},'executed':{name:m.sha(data) for name,data in a2a_graph.items()}}
 oidc_graph = m.oidc_closure(sources,b'cache')
 for name in (m.OIDC_LOGIN,m.OIDC_CALLBACK): identity['addedSourceSha256'][name] = {'originalSha256':m.sha(sources[name]),'executedSha256':m.sha(oidc_graph[name])}
 identity['oidcClosure'] = {'sources':{name:m.sha(sources[name]) for name in m.OIDC_CLOSURE},'executed':{name:m.sha(data) for name,data in oidc_graph.items()}}
 identity['batchHttpClosure']={'sources':{name:m.sha(sources[name]) for name in m.BATCH_SOURCES},'executed':{**{name:m.sha(sources[name]) for name in m.BATCH_SOURCES if name not in (m.BATCH_LIST,m.BATCH_ITEM,m.BATCH_STORE,'src/lib/db/files.ts','src/lib/db/apiKeys.ts','src/shared/utils/apiKey.ts')},**{name:m.sha(data) for name,data in m.batch_graph(sources).items()}}}
 identity['addedSourceSha256'][m.CONCURRENCY_ROUTE]={'originalSha256':m.sha(sources[m.CONCURRENCY_ROUTE]),'executedSha256':m.sha(m.concurrency_route_bytes(sources[m.CONCURRENCY_ROUTE])),'wrapperSha256':m.sha(m.CONCURRENCY_WRAPPER),'managerBoundarySha256':m.sha(m.CONCURRENCY_MANAGER)}
 identity['addedSourceSha256'][m.VISIBILITY_ROUTE]={'originalSha256':m.sha(sources[m.VISIBILITY_ROUTE]),'executedSha256':m.sha(m.visibility_route_bytes(sources[m.VISIBILITY_ROUTE])),'proxiesOriginalSha256':m.sha(sources[m.VISIBILITY_PROXIES]),'proxiesExecutedSha256':m.sha(m.visibility_proxies_bytes(sources[m.VISIBILITY_PROXIES]))}
 package=next(item for item in json.loads((fixture/'dependencies.json').read_text())['packages'] if item['location']=='node_modules/bottleneck')
 identity['concurrencyHttpClosure']={'sources':{name:m.sha(sources[name]) for name in m.CONCURRENCY_OWNERS},'managerExecutedSha256':m.sha(m.concurrency_manager_bytes(sources[m.CONCURRENCY_MANAGER_SOURCE])),'pauseOriginalSha256':m.sha(sources['open-sse/services/rateLimitManager/bodyRetryPause.ts']),'pauseExecutedSha256':m.sha(m.concurrency_pause_bytes(sources['open-sse/services/rateLimitManager/bodyRetryPause.ts'])),'package':package}
 identity['fixtureSha256'] = {k.removeprefix('test/fixtures/pinned-ingress/'):v for k,v in hashes.items() if k.startswith('test/fixtures/pinned-ingress/')}
 identity['fixtureSha256']['pinned-ingress-driver.mjs'] = hashes['scripts/pinned-ingress-driver.mjs']
 identity['fixtureSha256']['backend/core.ts'] = m.sha(expected_core)
 identity['fixtureSha256']['backend/settings.ts'] = m.sha(expected_settings)
 effective = {'backend/core.ts':m.sha(expected_core),'backend/settings.ts':m.sha(expected_settings)}
 identity['sourceOverlaySha256'] = {a['source']:{'originalSha256':a['sourceSha256'],'replacement':a['replacement'],'executedSha256':effective.get(a['replacement'],a['replacementSha256'])} for a in aliases}
 auth = {'fixture':'research-only','results':[]}
 for name, bypass, path, credential, status in m.AUTH_CASES:
  route = 'PUBLIC' if path == '/api/health' else 'MANAGEMENT'
  auth['results'].append({'name':name,'stateSha256':m.auth_state_sha(name,bypass),'response':{'status':status,'routeClass':route,'body': ('"status":"ok"' if route == 'PUBLIC' else 'management-handler-reached') if status == 200 else 'private-canary'},'events':[{'event':'access-token:usage-stamp','private':'private-canary'}] if name == 'access-allowed' else []})
 public = next(row for row in auth['results'] if row['name'] == 'disabled-bypass-health')
 public['requestEvents'] = [{'event':'ip-filter:read','private':'private-canary'}]
 def public_response(origin=None):
  return {'status':200,'routeClass':'PUBLIC','body':'{"status":"ok","timestamp":"2026-01-01T00:00:00.000Z"}','contentType':'application/json','cacheControl':'no-store, no-cache, must-revalidate','requestIdUuid':True,'started':1767225600000,'ended':1767225600001,'allowOrigin':origin,'vary':'Origin' if origin else None,'allowMethods':'GET, POST, PUT, DELETE, PATCH, OPTIONS','allowHeaders':'Content-Type, Authorization, x-api-key, anthropic-version, x-omniroute-connection, X-OmniRoute-Lease-Owner, X-OmniRoute-Lease-Generation, x-internal-test, accept','allowCredentials':None}
 public['response'] = public_response()
 public['draining'] = {'during':{'status':503,'routeClass':'PUBLIC','contentType':'application/json','retryAfter':'5','requestIdUuid':True,'correlationMatchesRequestId':True,'body':json.dumps({'error':{'code':'SERVICE_UNAVAILABLE','message':'Server is shutting down','correlation_id_present':True},'errorKeys':['code','correlation_id','message'],'bodyKeys':['error']})},'after':public_response()}
 public['cors'] = {'allowed':public_response('https://allowed.example'),'unlisted':public_response()}
 public['forwardedIp'] = {'denied':{**public_response('https://allowed.example'),'status':403,'body':'{"error":"IP blacklisted"}'},'recovered':public_response('https://allowed.example')}
 health = lambda ping: {'status':200,'cacheControl':'no-store','body':{'status':'ok','timestamp':'2026-01-01T00:00:00.000Z',**({'latencyMs':1} if ping else {})}}
 totals = {'totalRequests':3,'requestsWithCacheControl':2,'totalInputTokens':300,'totalCachedTokens':150,'totalCacheCreationTokens':10,'byProvider':{'alpha':{'totalRequests':2}},'byStrategy':{'direct':{'cachedTokens':50}},'extra':'private-canary'}
 metrics = lambda method: {'case':method+' /api/settings/cache-metrics','denied':{'status':401},'invalid':{'status':403},'allowed':{'status':200,'body':totals},'usageRowsAfter':3}
 rows = [{'case':'public GET /api/health','response':health(False)},{'case':'public GET /api/health/ping','response':health(True)},metrics('GET'),metrics('DELETE'),{'case':'GET cache-metrics missing usage_history','response':{'status':200,'body':{'totalRequests':0,'totalCachedTokens':0,'byProvider':{}}}},{'case':'drain-transition GET /api/health','draining':{'status':503},'recovered':{'status':200}}]
 timestamp = '2026-01-01T00:00:00.000Z'
 empty_summary = {'full':0,'reduced':0,'minimal':0,'default':0}
 populated_summary = {'full':1,'reduced':1,'minimal':0,'default':1}
 features = [{'feature':name,'level':level,'capability':capability,'reason':reason,'since':timestamp} for name,level,capability,reason in [('fixture-default','default','Safe default','Error: primary unavailable → Error: fallback unavailable'),('fixture-reduced','reduced','Reduced capability','primary unavailable'),('fixture-full','full','Full capability','')]]
 body = {'active':True,'summary':populated_summary,'features':features}
 response = lambda value: {'status':200,'routeClass':'MANAGEMENT','body':value}
 recovered_features = [{'feature':name,'level':'full','capability':'Full capability','reason':'','since':timestamp} for name in ('fixture-full','fixture-reduced','fixture-default')]
 degradation = {'case':'GET /api/health/degradation','denied':{'status':401,'routeClass':'MANAGEMENT'},'invalid':{'status':401,'routeClass':'MANAGEMENT'},'empty':response({'active':False,'summary':empty_summary,'features':[]}),'populated':response(body),'summary':response({'summary':populated_summary,'isDegraded':True}),'falseSummary':response(body),'capitalSummary':response(body),'recovery':response({'active':False,'summary':{'full':3,'reduced':0,'minimal':0,'default':0},'features':recovered_features})}
 rows.append(degradation)
 skill = {'id':'config-codex-cli','category':'config','area':'config-codex-cli','rawUrl':'https://raw.githubusercontent.com/cheaper-inference/OmniRoute/refs/heads/main/skills/config-codex-cli/SKILL.md','githubUrl':'https://github.com/cheaper-inference/OmniRoute/blob/main/skills/config-codex-cli/SKILL.md'}
 skills = {'case':'GET /api/agent-skills','denied':{'status':401,'routeClass':'MANAGEMENT'},'invalid':{'status':401,'routeClass':'MANAGEMENT'},'allowed':response({'count':1,'skills':[skill]})}
 rows.append(skills)
 for path,value in [('/api/agent-skills/config-codex-cli',skill),('/api/agent-skills/coverage',{'api':{'have':0,'total':23},'cli':{'have':0,'total':21},'config':{'have':0,'total':1},'totalSkills':0})]:
  rows.append({'case':'GET '+path,'denied':{'status':401,'routeClass':'MANAGEMENT'},'invalid':{'status':401,'routeClass':'MANAGEMENT'},'allowed':response(value)})
 for method,path in [('GET','/api/model-combo-mappings'),('POST','/api/model-combo-mappings'),('GET','/api/model-combo-mappings/fixture-id'),('PUT','/api/model-combo-mappings/fixture-id'),('DELETE','/api/model-combo-mappings/fixture-id')]:
  rows.append({'case':method+' '+path,'denied':{'status':401,'routeClass':'MANAGEMENT'},'invalid':{'status':401,'routeClass':'MANAGEMENT'},'allowed':response({'fixture':'management-handler-reached'})})
 family_methods = {
  '/api/combos': ('GET','POST'), '/api/combos/fixture-id': ('GET','PUT','PATCH','DELETE'),
  '/api/combos/auto': ('GET',), '/api/combos/builder/options': ('GET',), '/api/combos/metrics': ('GET','DELETE'),
  '/api/combos/export': ('GET',), '/api/combos/import': ('POST',), '/api/combos/duplicate': ('POST',),
  '/api/combos/reorder': ('POST',), '/api/combos/test': ('POST',), '/api/fallback/chains': ('GET','POST','DELETE'),
  '/api/model-capability-overrides': ('GET','PATCH','DELETE'), '/api/provider-nodes': ('GET','POST'),
  '/api/providers': ('GET','POST','PATCH','DELETE'), '/api/providers/fixture-id/cc-alias': ('GET','PUT'),
  '/api/providers/fixture-id/interception-rules': ('GET','PUT','DELETE'), '/api/providers/fixture-id/param-filters': ('GET','PUT','DELETE'),
  '/api/keys': ('GET',), '/api/keys/fixture-id': ('GET',), '/api/settings/proxies/assignments': ('GET',), '/api/models': ('GET',),
  '/api/settings': ('GET',), '/api/settings/proxies': ('GET',), '/api/settings/cc-discovery-metrics': ('GET',), '/api/settings/reasoning-routing-rules': ('GET',),
  '/api/providers/deprecated': ('GET',),
 }
 for path,methods in family_methods.items():
  for method in methods:
   mutation = method != 'GET'; admin = mutation and (path == '/api/providers' or path.startswith('/api/providers/'))
   observed = lambda status: {'status':status,'routeClass':'MANAGEMENT',**({'body':{'fixture':'management-handler-reached'}} if status == 200 else {})}
   rows.append({'case':method+' '+path,'denied':observed(401),'invalid':observed(401),'allowed':observed(200),'readScope':observed(403 if mutation else 200),'writeScope':observed(403 if admin else 200),'adminScope':observed(200)})
 live = {'status':200,'body':'ok\n','contentType':'text/plain; charset=utf-8','cacheControl':'no-store','contentLength':'3','routeClass':None}
 ingress = {'identity':identity,'results':rows,'events':[{'event':'sqlite:read','extra':'private-canary'},{'event':'degradation:populate'},{'event':'degradation:recover'}], 'livenessMatcherMatched':False, 'liveness':{name:dict(live) for name in ('anonymous','invalidCredential','session')}, 'livenessHead':{name:{**live,'body':''} for name in ('anonymous','invalidCredential','session')}}
 a2a_statuses = {'anonymous':401,'invalid':403,'session':200,'key-read':403,'key-write':403,'key-admin':200,'key-manage':200,'oma-read':200,'oma-write':200,'oma-admin':200}
 ingress['a2aHttp'] = {'matcherMatched':True,'cases':{name:{'status':status,'routeClass':'MANAGEMENT','disabled':True if status == 200 else None} for name,status in a2a_statuses.items()},'enabled':{'status':200,'routeClass':'MANAGEMENT','enabled':True,'agentName':'OmniRoute AI Gateway','streaming':True,'skillCount':6},'failure':{'status':500,'routeClass':'MANAGEMENT','rawErrorPresent':True}}
 ingress['wellKnown'] = [{'path':'/.well-known/'+name,'matcherMatched':False,'response':{'status':200,'routeClass':None,'requestId':None,'contentType':'application/json','cacheControl':'public, max-age=3600','body':{'name':'OmniRoute AI Gateway','version':'3.8.53','url':'http://localhost:43179/a2a','skills':[{}]*6, **({'supportedInterfaces':[{}]} if name == 'agent-card.json' else {'authentication':{'schemes':['api-key']}})}}} for name in ('agent-card.json','agent.json')]
 ingress['reasoningHttp'] = {'denied':{'status':401,'routeClass':'MANAGEMENT'},'invalid':{'status':401,'routeClass':'MANAGEMENT'},'failure':{'status':503,'routeClass':None,'contentType':'text/plain','bodyCategory':'text','privateMarkerPresent':False},'allowed':response({'rules':[]}),'cached':response({'rules':[]})}
 ingress['deprecatedHttp']={'denied':{'status':401,'routeClass':'MANAGEMENT'},'invalid':{'status':401,'routeClass':'MANAGEMENT'},'failure':{'status':500,'routeClass':'MANAGEMENT','privateMarkerPresent':False},'allowed':{'status':200,'routeClass':'MANAGEMENT','body':{'leftovers':[{'provider':'gemini-cli','migrateTo':'gemini','reason':'fixture','connectionIds':[f'fixture-{i}' for i in range(105)],'names':[f'name-{i}' for i in range(105)]}]}}}
 acp_status = {'anonymous':401,'invalid':403,'session':200,'key-read':403,'key-write':403,'key-admin':200,'key-manage':200,'oma-read':401,'oma-write':401,'oma-admin':401}
 acp_cases = {name:{'status':status,'routeClass':'MANAGEMENT','owned':{'installed':True,'version':'7.8.9'} if status == 200 else None} for name,status in acp_status.items()}
 ingress['acpHttp'] = {'cases':acp_cases,'unstampedSessionStatus':403,'probeCount':3,'processPlatform':'linux'}
 status_expected = {'anonymous':False,'invalid':False,'expired':False,'tampered':False,'valid':True,'cachedRevocation':True,'revoked':False,'passwordChanged':False,'settingsFailure':False}
 ingress['authStatusHttp'] = {'cases':{name:{'status':200,'routeClass':'PUBLIC','authenticated':value} for name,value in status_expected.items()},'invalidSettingsReads':0,'onboardingBefore':[],'onboardingAfter':[{'key':'requireLogin','value':'true'},{'key':'setupComplete','value':'true'}]}
 csrf_statuses={'anonymous':401,'invalid':403,'inference':403,'session':200,'session2':200,'manage':200,'admin':200,'oma':200,'omaRead':403,'omaWrite':403,'disabled':200,'missingSecret':200,'backendFailure':503}
 ingress['csrfHttp']={'cases':{name:{'status':status,'routeClass':'MANAGEMENT','issued':(name in ('session','session2')) if status==200 else None,'hmacBound':True if name in ('session','session2') else None,'expiryValid':True if name in ('session','session2') else None,'shapeValid':True if status==200 else None,'sessionDistinct':True if name=='session2' else None,'noStore':status==200,'json':True,'cookieMutation':False} for name,status in csrf_statuses.items()}}
 sso_enabled={'enabled':True,'authorityHost':'https://login.example.test','tenantId':'tenant.example','clientId':'fixture-client','audience':'api://fixture-audience','issuer':'https://login.example.test/tenant.example/v2.0','scope':'api://fixture-audience/.default'}
 ingress['ssoConfigHttp']={'cases':{name:{'status':200,'routeClass':'PUBLIC','contentType':'application/json','body':sso_enabled if name=='enabled' else {'enabled':False},'privateMarkerPresent':False} for name in ('anonymous','invalid','cached','enabled','incomplete','failure')}}
 login_base={'authenticated':False,'requireLogin':True,'hasPassword':True,'setupComplete':True,'oidcEnabled':False,'oidcDisablePasswordLogin':False,'nodeVersion':'v24.17.0','nodeCompatible':True}
 login_bodies={'anonymous':login_base,'invalid':login_base,'valid':{**login_base,'authenticated':True},'configured':{**login_base,'oidcEnabled':True,'oidcDisablePasswordLogin':True},'failure':login_base}
 ingress['requireLoginHttp']={'cases':{name:{'status':200,'routeClass':'PUBLIC','contentType':'application/json','body':body,'privateMarkerPresent':False} for name,body in login_bodies.items()},'onboardingBefore':[],'onboardingAfter':[{'key':'requireLogin','value':'true'},{'key':'setupComplete','value':'true'}]}
 history_auth={'anonymous':(401,None),'invalid':(403,None),'inference':(403,None),'session':(200,['five','four','three','two','one']),'oma':(200,['five','four','three','two','one']),'manage':(200,['five','four','two','one']),'admin':(200,['five','three','one'])}
 history_pages=[(['five','four'],5,2,0),(['three','two'],5,2,2),(['one'],5,2,4),([],5,2,8),(['five','four','three','two','one'],5,500,0),(['four'],1,100,0)]
 ingress['a2aHistoryHttp']={'auth':{name:{'status':status,'routeClass':'MANAGEMENT','ids':ids} for name,(status,ids) in history_auth.items()},'pages':[{'status':200,'ids':ids,'total':total,'limit':limit,'offset':offset} for ids,total,limit,offset in history_pages],'invalid':[400]*5,'failure':{'status':500,'routeClass':'MANAGEMENT','hasTasks':False}}
 visibility_status={'anonymous':401,'invalid':403,'inference':403,'writeKey':403,'session':200,'oma':200,'omaWrite':200,'omaAdmin':200,'manage':200,'admin':200}
 visibility_cases={'global':(200,1,'global',False,None),'provider':(200,1,'provider',False,None),'account':(200,1,'account',False,None),'combo':(200,1,'combo',False,None),'key':(200,1,'account',False,None),'proxy':(200,1,None,False,None),'unknownProxy':(200,1,None,True,None),'unknownScope':(200,0,'unknown',None,None),'missing':(400,None,None,None,None),'missingId':(400,None,None,None,None),'pauseMissing':(400,None,None,None,None),'pauses':(200,None,None,None,0),'nonOpencode':(200,None,None,None,0)}
 ingress['proxyVisibilityHttp']={'auth':{name:{'status':status,'routeClass':'MANAGEMENT'} for name,status in visibility_status.items()},'cases':{name:{'status':status,'routeClass':'MANAGEMENT','total':total,'scope':scope,'opaque':opaque,'pauses':pauses} for name,(status,total,scope,opaque,pauses) in visibility_cases.items()},'failure':{'status':500,'routeClass':'MANAGEMENT'}}
 analytics_body={'totalRequests':5,'variantBreakdown':{'default':2,'fast':2,'smart':1},'topProviders':[{'provider':'alpha','count':2},{'provider':'beta','count':1}]}
 analytics_status={'anonymous':401,'invalid':403,'inference':403,'session':200,'oma':200,'manage':200,'admin':200}
 ingress['analyticsHttp']={'auth':{name:{'status':status,'routeClass':'MANAGEMENT','body':analytics_body if status==200 else None} for name,status in analytics_status.items()},'beforeRows':7,'afterRows':7,'failure':{'status':200,'routeClass':'MANAGEMENT','body':{'totalRequests':0,'variantBreakdown':{},'topProviders':[]}}}
 ingress['compressionHttp']={'auth':{name:{'status':status,'routeClass':'MANAGEMENT'} for name,status in analytics_status.items()},'beforeColumns':10,'deniedColumns':10,'afterColumns':28,'periods':[{'status':200,'routeClass':'MANAGEMENT','totalRequests':count,'totalTokensSaved':saved,'chartLength':24,'chartCount':1} for count,saved in ((1,30),(1,30),(1,30),(2,50),(3,60),(4,65))],'failure':{'status':500,'routeClass':'MANAGEMENT','body':{'error':'Internal server error'}}}
 diversity_body={'score':1,'totalRequests':0,'providers':{},'windowSize':200,'ttlMs':3600000}
 ingress['diversityHttp']={'auth':{name:{'status':status,'routeClass':'MANAGEMENT','body':diversity_body if status==200 else None} for name,status in analytics_status.items()}}
 def concurrency_row(status,count=0):
  return {'status':status,'routeClass':'MANAGEMENT','cacheControl':'private, no-store' if status==200 else None,'contentType':'application/json' if status==200 else None,'counts':{'rateLimits':count,'comboQueues':count,'semaphores':count} if status==200 else None,'shape':True if status==200 else None}
 ingress['concurrencyHttp']={'auth':{name:concurrency_row(status) for name,status in visibility_status.items()},'empty':concurrency_row(200),'populated':concurrency_row(200,1),'unchanged':True,'failure':{'status':500,'routeClass':'MANAGEMENT','cacheControl':None,'contentType':None,'json':False,'privateMarkerPresent':False}}
 def batch_row(id,created=100): return {'id':id,'status':'completed','requestCountsTotal':3,'requestCountsCompleted':2,'requestCountsFailed':1,'createdAt':created,**{key:None for key in ('inProgressAt','expiresAt','finalizingAt','completedAt','failedAt','expiredAt','cancellingAt','cancelledAt')}}
 def batch_response(status,rows=None): return {'status':status,'routeClass':'MANAGEMENT','contentType':'application/json','cacheControl':None,'rowCount':len(rows) if rows is not None else None,'rows':rows if rows is not None else None,'error':None,'rawPrivatePresent':bool(rows)}
 z=[batch_row('batch_z%03d'%i) for i in range(102,-1,-1)]
 ingress['batchHttp']={'central':{'anonymous':batch_response(401),'invalid':batch_response(403),'owner':batch_response(403),'session':batch_response(200,z[:2]),'manage':batch_response(200,z[:2]),'invalidSession':batch_response(401)},'owner':{'owner':batch_response(200,z[:2]),'foreign':batch_response(200,[batch_row('batch_b',30)]),'default':{'transport':'probe-body-limit-65536'},'overCap':{'transport':'probe-body-limit-65536'},'zero':batch_response(200,[]),'invalid':batch_response(400)},'detail':{name:batch_response(500) for name in ('own','foreign','missing','nullOwner','invalidSession')}}
 refused_default=ingress['batchHttp']['owner']['default']
 ingress['batchHttp']['owner']['default']=batch_response(200,z[:100]); m.validate_batch_http(ingress['batchHttp']); ingress['batchHttp']['owner']['default']=refused_default
 oidc_errors={'nonce':'id_token_invalid','missing-nonce':'id_token_invalid','token-missing-nonce':'id_token_invalid','signature':'id_token_invalid','issuer':'id_token_invalid','audience':'id_token_invalid','expired':'id_token_invalid','future':'id_token_invalid','subject':'subject_not_allowed','role':'role_not_allowed','malformed-role':'role_not_allowed','exchange':'token_exchange','exchange-network':'token_exchange','bad-json':'token_response','no-token':'no_id_token','missing-code':'missing_code','missing-state':'missing_code','wrong-state':'invalid_state','rotation':'id_token_invalid','rotation-recovery':'dashboard','no-verifier':'dashboard','discovery-fallback':'dashboard','success':'dashboard','secure':'dashboard','missing-secret':'server_misconfigured'}
 config_case={'loginStatus':400,'loginPublic':True,'fixedError':True,'noLoginCookies':True,'callbackStatus':307,'callbackResult':'not_configured','callbackPublic':True}
 ingress['oidcHttp']={'cases':{},'configCases':{'disabled':config_case,'incomplete':config_case}}
 for name,result in oidc_errors.items():
  success=name in ('success','secure','rotation-recovery','no-verifier','discovery-fallback'); early=name in ('missing-code','missing-state','wrong-state')
  ingress['oidcHttp']['cases'][name]={'loginStatus':307,'loginPublic':True,'loginCookiesValid':True,'stateMatches':True,'nonceMatches':True,'challengeMatches':True,'callbackStatus':307,'callbackPublic':True,'result':result,'stateCleared':not early,'clearCookiesValid':success,'sessionIssued':success,'sessionValid':success,'sessionAttributesValid':True,'setupComplete':success or name=='missing-secret','exchangeCount':0 if early else 1,'jwksRequests':1 if name in ('nonce','rotation-recovery') else 0}
 metric_status={'anonymous':401,'invalid':403,'session':200,'key-read':403,'key-write':403,'key-manage':200,'key-admin':200,'oma-read':200,'oma-write':200,'oma-admin':200}
 state=lambda visible,hidden:{'visible':visible,'hidden':hidden}
 ingress['metricsHttp']={'auth':{method:{name:{'status':status,'routeClass':'MANAGEMENT'} for name,status in statuses.items()} for method,statuses in [('GET',metric_status),('DELETE',{**metric_status,'oma-read':403})]},'hiddenOnlyGetNull':True,'hiddenOnlyCount':1,'selectedProduction':1,'selectedShadow':1,'selectedHidden':1,'allNames':['fixture-other','fixture-selected'],'emptyNames':['fixture-other','fixture-selected'],'prototypeSelected':1,'prototypeInAll':False,'seededStates':[state(True,1),state(True,1),state(False,1),state(True,0)],'selectedAfterNull':True,'unrelatedProduction':1,'unrelatedShadow':1,'unrelatedHidden':1,'selectedStates':[state(False,0),state(True,1),state(False,1),state(True,0)],'afterEmptyDeleteNames':[],'emptyStates':[state(False,0) for _ in range(4)],'afterGlobalNames':[],'globalStates':[state(False,0) for _ in range(4)]}
 ingress['mfaStatusHttp'] = {'cases':{name:{'status':200,'routeClass':'MANAGEMENT','cacheControl':'no-store','body':{'enabled':False,'backupCodesRemaining':0,'recoverySwitchSet':False}} for name in ('anonymous','invalid','session','key-read','key-write','key-admin','key-manage','oma-read','oma-write','oma-admin')},'failure':{'status':500,'routeClass':'MANAGEMENT','cacheControl':'no-store','privateMarkerPresent':False}}
 mfa_statuses={'anonymous':401,'invalid':403,'session':200,'key-read':403,'key-write':403,'key-admin':200,'key-manage':200,'oma-read':403,'oma-write':403,'oma-admin':200}
 for name,status in mfa_statuses.items():
  ingress['mfaStatusHttp']['cases'][name]['status']=status
  if status != 200: ingress['mfaStatusHttp']['cases'][name]['body']=None; ingress['mfaStatusHttp']['cases'][name]['cacheControl']=None
  ingress['mfaStatusHttp']['cases'][name]['contentType']='application/json' if status == 200 else None
 ingress['mfaStatusHttp']['enrolled']={'status':200,'routeClass':'MANAGEMENT','cacheControl':'no-store','contentType':'application/json','body':{'enabled':True,'backupCodesRemaining':1,'recoverySwitchSet':False},'privateMarkerPresent':False,'rowUnchanged':True}
 ingress['events'].extend([{'event':'reasoning:read'},{'event':'reasoning:fault'},{'event':'reasoning:read'}])
 put('data/observations.json',auth); put('data/pinned-ingress-observations.json',ingress)
 m.export_observations(p, hashes)
 exported = json.loads((p/'export/observed-outcomes.json').read_text())
 assert 'private-canary' not in json.dumps(exported) and len(exported['sharedAuthentication']) == 12
 assert exported['health'][0]['bodyKeys'] == ['status','timestamp'] and exported['drain']['statuses'] == [503,200]
 assert exported['comboMetricsHttp'] == ingress['metricsHttp'] and isinstance(exported['comboMetricsHttp'],dict)
 assert [(row['method'],row['path']) for row in exported['cacheMetrics']] == [('GET','/api/settings/cache-metrics'),('DELETE','/api/settings/cache-metrics')]
 assert exported['publicHealthHttp']['drain']['correlationMatchesRequestId'] is True and exported['publicHealthHttp']['cors']['unlistedOriginOmitted'] is True
 assert exported['publicLivenessHttp'] == {'method':'GET','path':'/livez','matcher':'not-matched','proxyIdentity':identity['proxyIdentity'],'cases':ingress['liveness']}
 assert exported['publicLivenessHeadHttp'] == {'method':'HEAD','path':'/livez','matcher':'not-matched','proxyIdentity':identity['proxyIdentity'],'cases':{name:{'status':200,'body':'','contentType':'text/plain; charset=utf-8','cacheControl':'no-store','contentLength':'3','routeClass':None} for name in ('anonymous','invalidCredential','session')}}
 assert len(exported['wellKnownHttp']) == 2 and all(row['matcher'] == 'not-matched' and row['anonymous'] and row['requestId'] is None for row in exported['wellKnownHttp'])
 assert exported['publicHealthIpFilter'] == {'enabled':True,'mode':'blacklist','configReadObserved':True,'forwardedAddressFallback':{'deniedStatus':403,'error':'IP blacklisted','recoveryStatus':200,'routeClass':'PUBLIC','requestIdUuid':True,'allowedOriginEchoed':True}}
 assert exported['degradation']['handlerFailure'] == 'unobserved' and exported['degradation']['populated']['levels'] == ['default','reduced','full']
 assert exported['agentSkills']['ids'] == ['config-codex-cli'] and exported['agentSkills']['invalidCredentialStatus'] == 401
 assert [item['path'] for item in exported['agentSkillsReads']] == ['/api/agent-skills/config-codex-cli','/api/agent-skills/coverage']
 assert len(exported['modelComboMappingPolicy']) == 5 and exported['modelComboMappingPolicy'][1]['method'] == 'POST'
 family = {item['method']+' '+item['path']:item for item in exported['familyPolicy']}
 assert family['POST /api/providers']['readScopeStatus'] == 403 and family['POST /api/providers']['writeScopeStatus'] == 403 and family['POST /api/providers']['adminScopeStatus'] == 200
 assert family['POST /api/provider-nodes']['readScopeStatus'] == 403 and family['POST /api/provider-nodes']['writeScopeStatus'] == 200
 assert family['GET /api/providers']['readScopeStatus'] == 200
 for path in ('/api/settings','/api/settings/proxies','/api/settings/cc-discovery-metrics','/api/settings/reasoning-routing-rules'):
  assert family['GET '+path] == {'method':'GET','path':path,'routeClass':'MANAGEMENT','anonymousStatus':401,'invalidCredentialStatus':401,'authorizedStatus':200,'readScopeStatus':200,'writeScopeStatus':200,'adminScopeStatus':200}
 assert all(key not in exported for key in ('comboPolicy','modelCapabilityOverridesPolicy','readPolicy'))
 assert '198.51.100.' not in json.dumps(exported)
 assert 'started' not in json.dumps(exported['publicHealthHttp']) and 'correlation_id' not in json.dumps(exported['publicHealthHttp'])
 assert exported['inputs']['executedOverlaySha256'] == {'backend/core.ts':m.sha(expected_core),'backend/settings.ts':m.sha(expected_settings)}
 assert exported['inputs']['sourceOverlaySha256'] == identity['sourceOverlaySha256']
 assert exported['source']['addedSourceSha256'][m.REASONING_STORE] == m.sha(sources[m.REASONING_STORE])
 assert exported['source']['addedSourceSha256'][m.REASONING_ROUTE] == identity['addedSourceSha256'][m.REASONING_ROUTE]
 assert exported['reasoningHttp']['failure'] == ingress['reasoningHttp']['failure']
 csrf_exported=json.loads((p/'export/csrf-observed-outcomes.json').read_text()); assert csrf_exported['csrfHttp']==ingress['csrfHttp']; assert csrf_exported['supportedJsonHttp']==[{'operationId':'GET /api/auth/csrf','method':'GET','path':'/api/auth/csrf','status':200,'contentType':'application/json'}]
 assert exported['authStatusHttp'] == ingress['authStatusHttp']
 assert exported['acpAgentsHttp'] == ingress['acpHttp']
 (p/'export/csrf-observed-outcomes.json').unlink(); (p/'export/observed-outcomes.json').unlink(); (p/'export').rmdir()
 def rejected():
  try: m.export_observations(p, hashes)
  except (RuntimeError, KeyError, ValueError, TypeError): return
  raise AssertionError('invalid evidence accepted')
 ingress['oidcHttp']['cases']['success']['sessionValid']=False; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['oidcHttp']['cases']['success']['sessionValid']=True
 ingress['oidcHttp']['cases']['success']['privateCanary']='fixture-private'; put('data/pinned-ingress-observations.json',ingress); rejected(); del ingress['oidcHttp']['cases']['success']['privateCanary']
 ingress['a2aHttp']['cases']['key-read']['status']=200; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['a2aHttp']['cases']['key-read']['status']=403
 ingress['a2aHttp']['enabled']['enabled']=False; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['a2aHttp']['enabled']['enabled']=True
 identity['a2aStatusClosure']['executed'][a2a_name]='b'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); identity['a2aStatusClosure']['executed'][a2a_name]=m.sha(a2a_graph[a2a_name])
 original=ingress.pop('a2aHistoryHttp'); put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['a2aHistoryHttp']=original
 original=ingress['a2aHistoryHttp']['pages'][0]['total']; ingress['a2aHistoryHttp']['pages'][0]['total']=0; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['a2aHistoryHttp']['pages'][0]['total']=original
 original=ingress['a2aHistoryHttp']['auth']['inference']['status']; ingress['a2aHistoryHttp']['auth']['inference']['status']=200; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['a2aHistoryHttp']['auth']['inference']['status']=original
 original=ingress.pop('proxyVisibilityHttp'); put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['proxyVisibilityHttp']=original
 original=ingress['proxyVisibilityHttp']['cases']['key']['scope']; ingress['proxyVisibilityHttp']['cases']['key']['scope']='key'; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['proxyVisibilityHttp']['cases']['key']['scope']=original
 ingress['proxyVisibilityHttp']['privateCanary']='fixture-private-credential'; put('data/pinned-ingress-observations.json',ingress); rejected(); del ingress['proxyVisibilityHttp']['privateCanary']
 original=ingress.pop('analyticsHttp'); put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['analyticsHttp']=original
 original=ingress['analyticsHttp']['failure']['status']; ingress['analyticsHttp']['failure']['status']=500; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['analyticsHttp']['failure']['status']=original
 original=ingress.pop('diversityHttp'); put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['diversityHttp']=original
 original=ingress['diversityHttp']['auth']['session']['status']; ingress['diversityHttp']['auth']['session']['status']=401; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['diversityHttp']['auth']['session']['status']=original
 original=ingress.pop('concurrencyHttp'); put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['concurrencyHttp']=original
 ingress['concurrencyHttp']['populated']['counts']['rateLimits']=True; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['concurrencyHttp']['populated']['counts']['rateLimits']=1
 ingress['concurrencyHttp']['populated']['counts']['wrongFamily']=1; put('data/pinned-ingress-observations.json',ingress); rejected(); del ingress['concurrencyHttp']['populated']['counts']['wrongFamily']
 ingress['concurrencyHttp']['private']='fixture-private'; put('data/pinned-ingress-observations.json',ingress); rejected(); del ingress['concurrencyHttp']['private']
 ingress['concurrencyHttp']['failure']['status']=200; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['concurrencyHttp']['failure']['status']=500
 original=ingress['batchHttp']['owner']['owner']['rows'].pop(); put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['batchHttp']['owner']['owner']['rows'].append(original)
 ingress['batchHttp']['owner']['foreign']['rows'][0]['apiKeyId']='private'; put('data/pinned-ingress-observations.json',ingress); rejected(); del ingress['batchHttp']['owner']['foreign']['rows'][0]['apiKeyId']
 original=ingress['batchHttp']['owner']['owner']['routeClass']; ingress['batchHttp']['owner']['owner']['routeClass']='PUBLIC'; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['batchHttp']['owner']['owner']['routeClass']=original
 original=ingress['batchHttp']['owner']['foreign']['rows'][0]['id']; ingress['batchHttp']['owner']['foreign']['rows'][0]['id']='batch_a1'; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['batchHttp']['owner']['foreign']['rows'][0]['id']=original
 ingress['batchHttp']['owner']['owner']['private']='private'; put('data/pinned-ingress-observations.json',ingress); rejected(); del ingress['batchHttp']['owner']['owner']['private']
 ingress['batchHttp']['owner']['overCap']['transport']='complete'; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['batchHttp']['owner']['overCap']['transport']='probe-body-limit-65536'
 ingress['batchHttp']['detail']['own']['status']=200; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['batchHttp']['detail']['own']['status']=500
 original=identity['batchHttpClosure']['executed'][m.BATCH_LIST]; identity['batchHttpClosure']['executed'][m.BATCH_LIST]='b'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); identity['batchHttpClosure']['executed'][m.BATCH_LIST]=original
 original=identity['batchHttpClosure']['sources'][m.BATCH_LIST]; identity['batchHttpClosure']['sources'][m.BATCH_LIST]='b'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); identity['batchHttpClosure']['sources'][m.BATCH_LIST]=original
 identity['batchHttpClosure']['executed']['src/lib/db/apiKeys.ts']=identity['batchHttpClosure']['sources']['src/lib/db/apiKeys.ts']; put('data/pinned-ingress-observations.json',ingress); rejected(); del identity['batchHttpClosure']['executed']['src/lib/db/apiKeys.ts']
 original=identity['concurrencyHttpClosure']['sources'][m.CONCURRENCY_ROUTE]; identity['concurrencyHttpClosure']['sources'][m.CONCURRENCY_ROUTE]='b'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); identity['concurrencyHttpClosure']['sources'][m.CONCURRENCY_ROUTE]=original
 original=ingress.pop('csrfHttp'); put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['csrfHttp']=original
 for field in ('hmacBound','expiryValid','shapeValid','noStore'):
  original=ingress['csrfHttp']['cases']['session'][field]; ingress['csrfHttp']['cases']['session'][field]=False; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['csrfHttp']['cases']['session'][field]=original
 ingress['csrfHttp']['cases']['session']['cookieMutation']=True; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['csrfHttp']['cases']['session']['cookieMutation']=False
 ingress['csrfHttp']['cases']['session']['privateCanary']='private'; put('data/pinned-ingress-observations.json',ingress); rejected(); del ingress['csrfHttp']['cases']['session']['privateCanary']
 original=ingress['csrfHttp']['cases']['session2']['sessionDistinct']; ingress['csrfHttp']['cases']['session2']['sessionDistinct']=False; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['csrfHttp']['cases']['session2']['sessionDistinct']=original
 original=ingress['csrfHttp']['cases']['backendFailure']['status']; ingress['csrfHttp']['cases']['backendFailure']['status']=200; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['csrfHttp']['cases']['backendFailure']['status']=original
 for name in ('omaRead','omaWrite'):
  ingress['csrfHttp']['cases'][name]['status']=200; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['csrfHttp']['cases'][name]['status']=403
 original=identity['addedSourceSha256']['src/app/api/auth/csrf/route.ts']; identity['addedSourceSha256']['src/app/api/auth/csrf/route.ts']='a'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); identity['addedSourceSha256']['src/app/api/auth/csrf/route.ts']=original
 original=ingress['requireLoginHttp']['cases']['configured']['body']['oidcDisablePasswordLogin']; ingress['requireLoginHttp']['cases']['configured']['body']['oidcDisablePasswordLogin']=False; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['requireLoginHttp']['cases']['configured']['body']['oidcDisablePasswordLogin']=original
 original=identity['requireLoginClosure']['executed'][m.REQUIRE_LOGIN]; identity['requireLoginClosure']['executed'][m.REQUIRE_LOGIN]='a'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); identity['requireLoginClosure']['executed'][m.REQUIRE_LOGIN]=original
 original = ingress['ssoConfigHttp']['cases']['enabled']['body']; ingress['ssoConfigHttp']['cases']['enabled']['body']={'enabled':False}; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['ssoConfigHttp']['cases']['enabled']['body']=original
 original = identity['ssoConfigClosure']['executed'][m.SSO_CONFIG]; identity['ssoConfigClosure']['executed'][m.SSO_CONFIG]='a'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); identity['ssoConfigClosure']['executed'][m.SSO_CONFIG]=original
 original = ingress['mfaStatusHttp']['enrolled']['rowUnchanged']; ingress['mfaStatusHttp']['enrolled']['rowUnchanged'] = False; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['mfaStatusHttp']['enrolled']['rowUnchanged'] = original
 ingress['mfaStatusHttp']['cases']['anonymous']['cacheControl']={'private':'secret'}; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['mfaStatusHttp']['cases']['anonymous']['cacheControl']=None
 ingress['mfaStatusHttp']['cases']['key-manage']['contentType']='text/plain'; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['mfaStatusHttp']['cases']['key-manage']['contentType']='application/json'
 original = identity['mfaStatusClosure']['executed'][m.MFA_STATUS]; identity['mfaStatusClosure']['executed'][m.MFA_STATUS] = 'a'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); identity['mfaStatusClosure']['executed'][m.MFA_STATUS] = original
 original = ingress['authStatusHttp']['cases']['revoked']['authenticated']; ingress['authStatusHttp']['cases']['revoked']['authenticated'] = True; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['authStatusHttp']['cases']['revoked']['authenticated'] = original
 ingress['authStatusHttp']['invalidSettingsReads'] = 1; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['authStatusHttp']['invalidSettingsReads'] = 0
 original = identity['authStatusClosure']['executed'][m.AUTH_SESSION]; identity['authStatusClosure']['executed'][m.AUTH_SESSION] = 'a'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); identity['authStatusClosure']['executed'][m.AUTH_SESSION] = original
 original = ingress.pop('acpHttp'); put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['acpHttp'] = original
 original = acp_cases.pop('key-manage'); put('data/pinned-ingress-observations.json',ingress); rejected(); acp_cases['key-manage'] = original
 original = acp_cases['invalid']['status']; acp_cases['invalid']['status'] = 401; put('data/pinned-ingress-observations.json',ingress); rejected(); acp_cases['invalid']['status'] = original
 original = acp_cases['key-read']['status']; acp_cases['key-read']['status'] = 200; put('data/pinned-ingress-observations.json',ingress); rejected(); acp_cases['key-read']['status'] = original
 original = acp_cases['oma-admin']['status']; acp_cases['oma-admin']['status'] = 200; put('data/pinned-ingress-observations.json',ingress); rejected(); acp_cases['oma-admin']['status'] = original
 original = identity['addedSourceSha256'].pop(m.ACP_ROUTE); put('data/pinned-ingress-observations.json',ingress); rejected(); identity['addedSourceSha256'][m.ACP_ROUTE] = original
 for name in ('originalSha256','executedSha256','processBoundarySha256','ownedProbeSha256'):
  original = identity['addedSourceSha256'][m.ACP_REGISTRY][name]; identity['addedSourceSha256'][m.ACP_REGISTRY][name] = 'a'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); identity['addedSourceSha256'][m.ACP_REGISTRY][name] = original
 original = ingress['acpHttp']['probeCount']; ingress['acpHttp']['probeCount'] = 0; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['acpHttp']['probeCount'] = original
 original = ingress['acpHttp']['unstampedSessionStatus']; ingress['acpHttp']['unstampedSessionStatus'] = 200; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['acpHttp']['unstampedSessionStatus'] = original
 original = identity['addedSourceSha256'].pop(m.REASONING_STORE); put('data/pinned-ingress-observations.json',ingress); rejected(); identity['addedSourceSha256'][m.REASONING_STORE] = original
 original = identity['addedSourceSha256'][m.REASONING_STORE]; identity['addedSourceSha256'][m.REASONING_STORE] = 'a'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); identity['addedSourceSha256'][m.REASONING_STORE] = original
 discovery = next(row for row in rows if row['case'] == 'GET /api/settings/cc-discovery-metrics')
 for name, bad in [('denied',200),('invalid',200),('allowed',403),('readScope',403),('writeScope',403),('adminScope',403)]:
  original = discovery[name]['status']; discovery[name]['status'] = bad; put('data/pinned-ingress-observations.json',ingress); rejected(); discovery[name]['status'] = original
  original = discovery.pop(name); put('data/pinned-ingress-observations.json',ingress); rejected(); discovery[name] = original
 rows.remove(discovery); put('data/pinned-ingress-observations.json',ingress); rejected(); rows.append(discovery)
 rows.append(discovery); put('data/pinned-ingress-observations.json',ingress); rejected(); rows.pop()
 original=ingress.pop('metricsHttp'); put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['metricsHttp']=original
 ingress['metricsHttp']=exported['cacheMetrics']; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['metricsHttp']=original
 ingress['metricsHttp']['extra']='unexpected'; put('data/pinned-ingress-observations.json',ingress); rejected(); del ingress['metricsHttp']['extra']
 ingress['metricsHttp']['auth']['GET']['session']['extra']='unexpected'; put('data/pinned-ingress-observations.json',ingress); rejected(); del ingress['metricsHttp']['auth']['GET']['session']['extra']
 ingress['metricsHttp']['hiddenOnlyCount']=True; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['metricsHttp']['hiddenOnlyCount']=1
 for key in list(ingress['metricsHttp']):
  original=ingress['metricsHttp'].pop(key); put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['metricsHttp'][key]=original
 original=ingress['metricsHttp']['globalStates'][2]['hidden']; ingress['metricsHttp']['globalStates'][2]['hidden']=1; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['metricsHttp']['globalStates'][2]['hidden']=original
 original=identity['addedSourceSha256'][m.COMBO_METRICS_ROUTE]['wrapperSha256']; identity['addedSourceSha256'][m.COMBO_METRICS_ROUTE]['wrapperSha256']='a'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); identity['addedSourceSha256'][m.COMBO_METRICS_ROUTE]['wrapperSha256']=original
 source_name = 'src/app/api/settings/cc-discovery-metrics/route.ts'; original = identity['addedSourceSha256'].pop(source_name)
 put('data/pinned-ingress-observations.json',ingress); rejected(); identity['addedSourceSha256'][source_name] = 'a'*64
 put('data/pinned-ingress-observations.json',ingress); rejected(); identity['addedSourceSha256'][source_name] = original
 for name in ('anonymous','invalidCredential','session'):
  for key,bad in [('status',401),('body','wrong'),('contentType','application/json'),('cacheControl','public'),('contentLength','2'),('routeClass','PUBLIC')]:
   original = ingress['liveness'][name][key]; ingress['liveness'][name][key] = bad; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['liveness'][name][key] = original
  original = ingress['liveness'].pop(name); put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['liveness'][name] = original
 for name in ('anonymous','invalidCredential','session'):
  for key,bad in [('status',401),('body','ok\n'),('contentType','application/json'),('cacheControl','public'),('contentLength','2'),('routeClass','PUBLIC')]:
   original = ingress['livenessHead'][name][key]; ingress['livenessHead'][name][key] = bad; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['livenessHead'][name][key] = original
   original = ingress['livenessHead'][name].pop(key); put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['livenessHead'][name][key] = original
  original = ingress['livenessHead'].pop(name); put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['livenessHead'][name] = original
 ingress['livenessHead']['unexpected'] = dict(live); put('data/pinned-ingress-observations.json',ingress); rejected(); del ingress['livenessHead']['unexpected']
 original = ingress.pop('livenessHead'); put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['livenessHead'] = original
 ingress['livenessMatcherMatched'] = True; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['livenessMatcherMatched'] = False
 for name in ('originalSha256','executedSha256'):
  original = identity['addedSourceSha256'][m.LIVE_ROUTE][name]; identity['addedSourceSha256'][m.LIVE_ROUTE][name] = 'a'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); identity['addedSourceSha256'][m.LIVE_ROUTE][name] = original
  original = identity['proxyIdentity'][name]; identity['proxyIdentity'][name] = 'a'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); identity['proxyIdentity'][name] = original
 source_name = m.ROUTES[0]; original = identity['addedSourceSha256'][source_name]
 identity['addedSourceSha256'][source_name] = 'a'*64; put('data/pinned-ingress-observations.json',ingress); rejected()
 identity['addedSourceSha256'][source_name] = original
 original = identity['pingDeclarationSha256']; identity['pingDeclarationSha256'] = 'b'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); identity['pingDeclarationSha256'] = original
 for name in ('backend/core.ts','backend/settings.ts'):
  original = identity['fixtureSha256'].pop(name); put('data/pinned-ingress-observations.json',ingress); rejected()
  identity['fixtureSha256'][name] = 'a'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); identity['fixtureSha256'][name] = original
 for name in list(identity['sourceOverlaySha256']):
  original = identity['sourceOverlaySha256'].pop(name); put('data/pinned-ingress-observations.json',ingress); rejected()
  identity['sourceOverlaySha256'][name] = {**original, 'executedSha256':'a'*64}; put('data/pinned-ingress-observations.json',ingress); rejected(); identity['sourceOverlaySha256'][name] = original
 put('data/pinned-ingress-observations.json',ingress)
 for name in ('access-invalid','access-expired','access-revoked'):
  row = next(row for row in auth['results'] if row['name'] == name)
  row['events'].append({'event':'access-token:usage-stamp'}); put('data/observations.json',auth); rejected(); row['events'].clear()
  row['response']['body'] = 'management-handler-reached'; put('data/observations.json',auth); rejected(); row['response']['body'] = 'private-canary'
 put('data/observations.json',auth)
 for bad in ([], [{'event':'ip-filter:wrong'}]):
  original = public['requestEvents']; public['requestEvents'] = bad; put('data/observations.json',auth); rejected(); public['requestEvents'] = original
 original = public.pop('requestEvents'); put('data/observations.json',auth); rejected(); public['requestEvents'] = original
 original = public['stateSha256']; public['stateSha256'] = 'a'*64; put('data/observations.json',auth); rejected(); public['stateSha256'] = original
 during = public['draining']['during']
 for key, bad in [('body','{"error":{"code":"wrong"}}'),('retryAfter','4'),('contentType','text/plain'),('routeClass','MANAGEMENT'),('correlationMatchesRequestId',False),('requestIdUuid',False)]:
  original = during[key]; during[key] = bad; put('data/observations.json',auth); rejected(); during[key] = original
 for key, bad in [('body','{"status":"ok","timestamp":"2025-01-01T00:00:00.000Z"}'),('cacheControl','public'),('contentType','text/plain')]:
  original = public['response'][key]; public['response'][key] = bad; put('data/observations.json',auth); rejected(); public['response'][key] = original
 original = public['cors']['unlisted']['allowOrigin']; public['cors']['unlisted']['allowOrigin'] = 'https://unlisted.example'; put('data/observations.json',auth); rejected(); public['cors']['unlisted']['allowOrigin'] = original
 original = public['cors'].pop('allowed'); put('data/observations.json',auth); rejected(); public['cors']['allowed'] = original
 forwarded = public['forwardedIp']
 for name in ('denied','recovered'):
  original = forwarded.pop(name); put('data/observations.json',auth); rejected(); forwarded[name] = original
 for name, changes in [('denied',[('status',401),('body','{"error":"IP not in whitelist"}'),('body','{"error":"Access denied"}'),('body','{"error":"IP blacklisted","extra":true}'),('contentType','text/plain'),('routeClass','MANAGEMENT'),('requestIdUuid',False),('allowOrigin',None),('allowCredentials','true'),('vary',None)]),('recovered',[('status',403),('body','{"error":"IP blacklisted"}'),('routeClass','MANAGEMENT'),('requestIdUuid',False),('allowOrigin',None),('allowMethods','GET')])]:
  response = forwarded[name]
  for key, bad in changes:
   original = response[key]; response[key] = bad; put('data/observations.json',auth); rejected(); response[key] = original
   original = response.pop(key); put('data/observations.json',auth); rejected(); response[key] = original
 original = public.pop('forwardedIp'); put('data/observations.json',auth); rejected(); public['forwardedIp'] = original
 put('data/observations.json',auth)
 ingress['results'] = rows[:-1]; put('data/pinned-ingress-observations.json',ingress); rejected()
 ingress['results'] = rows; rows[5]['recovered']['status'] = 503; put('data/pinned-ingress-observations.json',ingress); rejected()
 rows[5]['recovered']['status'] = 200
 rows.append(rows[-1]); put('data/pinned-ingress-observations.json',ingress); rejected(); rows.pop()
 for mapping in rows[8:]:
  for endpoint,key,bad in [('denied','status',200),('invalid','status',200),('allowed','status',403),('denied','routeClass','PUBLIC'),('invalid','routeClass','PUBLIC'),('allowed','routeClass','PUBLIC')]:
   original = mapping[endpoint][key]; mapping[endpoint][key] = bad; put('data/pinned-ingress-observations.json',ingress); rejected(); mapping[endpoint][key] = original
  original = mapping['case']; mapping['case'] = 'GET /api/wrong'; put('data/pinned-ingress-observations.json',ingress); rejected(); mapping['case'] = original
 for row in rows[10:]:
  original = row['allowed']['body']; row['allowed']['body'] = {'fixture':'wrong'}; put('data/pinned-ingress-observations.json',ingress); rejected(); row['allowed']['body'] = original
 for row in rows[15:]:
  for branch in ('readScope','writeScope','adminScope'):
   original = row.pop(branch); put('data/pinned-ingress-observations.json',ingress); rejected(); row[branch] = original
   original = row[branch]['status']; row[branch]['status'] = 401; put('data/pinned-ingress-observations.json',ingress); rejected(); row[branch]['status'] = original
   original = row[branch]['routeClass']; row[branch]['routeClass'] = 'PUBLIC'; put('data/pinned-ingress-observations.json',ingress); rejected(); row[branch]['routeClass'] = original
 for name in m.POLICY_SOURCES:
  original = identity['addedSourceSha256'][name]; identity['addedSourceSha256'][name] = 'a'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); identity['addedSourceSha256'][name] = original
 original = degradation['summary']['body']; degradation['summary']['body'] = body; put('data/pinned-ingress-observations.json',ingress); rejected(); degradation['summary']['body'] = original
 for name in ('falseSummary','capitalSummary'):
  original = degradation[name]['body']; degradation[name]['body'] = {'summary':populated_summary,'isDegraded':True}; put('data/pinned-ingress-observations.json',ingress); rejected(); degradation[name]['body'] = original
 original = ingress['events']; ingress['events'] = original[:-1]; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['events'] = original
 original = degradation['invalid']['status']; degradation['invalid']['status'] = 200; put('data/pinned-ingress-observations.json',ingress); rejected(); degradation['invalid']['status'] = original
 original = degradation['denied']['routeClass']; degradation['denied']['routeClass'] = 'PUBLIC'; put('data/pinned-ingress-observations.json',ingress); rejected(); degradation['denied']['routeClass'] = original
 original = degradation['recovery']['body']['features'][1]['level']; degradation['recovery']['body']['features'][1]['level'] = 'reduced'; put('data/pinned-ingress-observations.json',ingress); rejected(); degradation['recovery']['body']['features'][1]['level'] = original
 for endpoint, key, bad in [('denied','status',200),('invalid','status',200),('allowed','routeClass','PUBLIC')]:
  original = skills[endpoint][key]; skills[endpoint][key] = bad; put('data/pinned-ingress-observations.json',ingress); rejected(); skills[endpoint][key] = original
 original = skill['id']; skill['id'] = 'wrong'; put('data/pinned-ingress-observations.json',ingress); rejected(); skill['id'] = original
 route_identity = identity['addedSourceSha256']['src/app/api/health/degradation/route.ts']
 for key in ('originalSha256','executedSha256'):
  original = route_identity[key]; route_identity[key] = 'a'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); route_identity[key] = original
 domain_identity = identity['addedSourceSha256']['src/domain/degradation.ts']
 for key in ('originalSha256','executedSha256'):
  original = domain_identity[key]; domain_identity[key] = 'a'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); domain_identity[key] = original
 put('data/pinned-ingress-observations.json',ingress)
 auth['results'][0]['response']['status'] = 500; put('data/observations.json',auth); rejected()
 (p/'data/observations.json').write_text('{'); rejected()
 (p/'data/observations.json').unlink(); rejected()
`;
  const result = spawnSync("python3", ["-c", code, runner], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
}, 120_000);

test("real-core export validates lifecycle and excludes private database values", () => {
  const code = String.raw`
import importlib.util,json,pathlib,sys,tempfile
spec=importlib.util.spec_from_file_location('ingress',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
 m.effective_source_identities=lambda archive:{'effectiveTreeSha256':'b'*64}
 p=pathlib.Path(d); h='a'*64
 corpus=json.loads((m.ROOT/'provenance/route-sources.json').read_text())['root']['sourceCorpus']['files']
 source={entry['path']:entry['sha256'] for entry in corpus if entry['path'].startswith('src/lib/db/migrations/') and entry['path'].endswith('.sql')}
 assert len(source)==222
 source.update({'src/lib/db/healthCheckWorker.ts':h,'scripts/build/colocate-standalone.mjs':h,'src/lib/db/core.ts':h})
 source.update({name:h for name in (m.MFA_STATUS,m.MFA_DASHBOARD,m.MFA_STORAGE,m.MFA_SUPPORT)})
 source.update({name:h for name in (m.SSO_CONFIG,m.SSO_ENTRA,m.AUTH_SETTINGS,m.AUTH_SHARED,'src/lib/db/readCache.ts')})
 source.update({name:h for name in (m.REQUIRE_LOGIN,m.LOGIN_PASSWORD,m.LOGIN_RUNTIME,m.LOGIN_FLAGS,m.AUTH_SESSION,*m.LOGIN_DEPENDENCIES)})
 a2a_sources=('src/app/api/a2a/status/route.ts','src/lib/a2a/taskManager.ts','src/lib/db/a2aTasks.ts','src/lib/events/eventBus.ts','src/lib/db/readCache.ts',m.AUTH_SETTINGS,m.AUTH_SHARED,'src/app/.well-known/agent.json/route.ts','src/lib/a2a/agentCardMetadata.ts','src/lib/conductor/fleetSkills.ts','src/lib/wellKnown.ts','src/shared/constants/appConfig.ts')
 source.update({name:h for name in a2a_sources})
 source.update({name:h for name in m.VISIBILITY_CLOSURE})
 analytics_sources=('src/app/api/analytics/auto-routing/route.ts','src/lib/db/usageLogs.ts','src/lib/db/logicalCallSql.ts','src/lib/db/core.ts','src/lib/api/requireManagementAuth.ts')
 source.update({name:h for name in analytics_sources})
 compression_sources=(*m.COMPRESSION_SOURCES,'src/lib/db/core.ts','src/lib/api/requireManagementAuth.ts')
 source.update({name:h for name in compression_sources if name not in source})
 source.update({name:h for name in m.DIVERSITY_CLOSURE if name not in source})
 source.update({name:h for name in m.CSRF_CLOSURE if name not in source})
 source.update({name:h for name in m.OIDC_CLOSURE if name not in source})
 source.update({name:h for name in m.COMBO_METRICS_CLOSURE if name not in source})
 source.update({name:h for name in m.CONCURRENCY_OWNERS if name not in source})
 source.update({name:h for name in m.BATCH_SOURCES if name not in source})
 migrations={k:v for k,v in source.items() if k.endswith('.sql')}
 identity={'sourceArchiveSha256':m.ARCHIVE_SHA,'nodeSha256':m.NODE_SHA,'sourceFilesSha256':source,'migrationSqlSha256':migrations,'workerSourceSha256':h,'productionRecipeSha256':h,'workerBuildArguments':['--bundle','--platform=node','--packages=external','--format=esm'],'workerOutputSha256':h,'runnerSourceSha256':h,'runnerArguments':['/runtime/node','--import','tsx/esm','/work/app/src/lib/db/pinnedLifecycleFixture.mjs'],'private':'private-canary'}
 identity['effectiveTreeSha256']='b'*64
 identity['mfaClosure']={'sources':{name:h for name in (m.MFA_STATUS,m.MFA_DASHBOARD,m.MFA_STORAGE,m.MFA_SUPPORT)},'selectedSha256':h}
 identity['ssoClosure']={name:source[name] for name in (m.SSO_CONFIG,m.SSO_ENTRA,m.AUTH_SETTINGS,m.AUTH_SHARED,'src/lib/db/readCache.ts')}
 identity['loginClosure']={'sources':{name:source[name] for name in (m.REQUIRE_LOGIN,m.LOGIN_PASSWORD,m.LOGIN_RUNTIME,m.LOGIN_FLAGS,m.AUTH_SETTINGS,m.AUTH_SHARED,m.AUTH_SESSION,'src/lib/db/readCache.ts',*m.LOGIN_DEPENDENCIES)},'selectedSha256':h}
 identity['a2aClosure']={name:source[name] for name in a2a_sources}
 identity['visibilityClosure']={name:source[name] for name in m.VISIBILITY_CLOSURE}
 identity['analyticsClosure']={name:source[name] for name in analytics_sources}
 m.approved_source=lambda: {m.OIDC_CALLBACK:b'import { cookies } from "next/headers";'}
 identity['oidcCallbackSelectedSha256']=m.sha(b'import { cookies } from "./pinnedLifecycleCookies";')
 identity['compressionClosure']={name:source[name] for name in compression_sources}
 identity['diversityClosure']={name:source[name] for name in m.DIVERSITY_CLOSURE}
 identity['concurrencyClosure']={name:source[name] for name in m.CONCURRENCY_OWNERS}
 identity['csrfClosure']={name:source[name] for name in m.CSRF_CLOSURE}
 identity['oidcClosure']={name:source[name] for name in m.OIDC_CLOSURE}
 identity['comboMetricsClosure']={name:source[name] for name in m.COMBO_METRICS_CLOSURE}
 identity['batchClosure']={'sources':{name:source[name] for name in (*m.BATCH_SOURCES,'src/lib/db/core.ts')},'executed':{name:source[name] for name in (*m.BATCH_SOURCES,'src/lib/db/core.ts') if name != m.BATCH_ITEM}}
 db={'name':'storage.sqlite','kind':'file','size':1}
 base={'driver':'node:sqlite','ping':True,'healthWorker':True,'healthy':True,'settingsMarker':'cold-written','tables':['_omniroute_migrations','db_meta'],'migrations':[{'version':'001','name':'initial_schema'}],'after':[db], 'meta':[{'key':'secret','value':'private-canary'}]}
 cold={**base,'phase':'cold','before':[],'runtimeSettingApplied':True}; warm={**base,'phase':'warm','before':[db],'runtimeSettingApplied':False}
 authcold={'invalidRejected':True,'validAccepted':True,'databaseExistedBefore':False,'onboardingBefore':'absent','onboardingAfter':'persisted','invalidNoDatabase':True}
 authwarm={'invalidRejected':True,'validAccepted':True,'databaseExistedBefore':True,'onboardingBefore':'persisted','onboardingAfter':'persisted','cachedRevocation':True,'revocationAfterExpiry':True,'passwordCutoffAfterExpiry':True}
 for phase in ('cold-lifecycle','warm-lifecycle','auth-cold','auth-warm','mfa-cold','mfa-warm','sso-cold','sso-warm','login-cold','login-warm','history-cold','history-warm','analytics-cold','analytics-warm','diversity-cold','diversity-warm'): (p/(phase+'.private')).write_text('normal output\n')
 def put(name,value): (p/name).write_text(json.dumps(value))
 for phase in ('cold','warm'):
  (p/('batch-'+phase+'.private')).write_text('normal output\n')
  rows=[{'idValid':True,'status':'completed','createdAt':20}]
  put('batch-'+phase+'.json',{'databaseExistedBefore':phase=='warm','databaseExistsAfter':True,'driver':'node:sqlite','first':rows if phase=='warm' else [],'populated':rows,'rows':1})
  (p/('oidc-'+phase+'.private')).write_text('normal output\n')
  put('oidc-'+phase+'.json',{'databaseExistedBefore':phase=='warm','databaseExistsAfter':True,'setupBefore':phase=='warm','setupPersisted':True,'settingsPersisted':True,'callbackStatus':307,'callbackResult':'dashboard' if phase=='warm' else 'server_misconfigured','sessionIssued':phase=='warm'})
  (p/('a2a-'+phase+'.private')).write_text('normal output\n')
  put('a2a-'+phase+'.json',{'databaseExistedBefore':phase=='warm','databaseExistsAfter':True,'disabled':True,'enabled':True,'managerTimerCount':1,'activeTaskObserved':True,'expiredTaskPersistedFailed':True,'timerPurgedOldHistory':True})
  (p/('visibility-'+phase+'.private')).write_text('normal output\n')
  put('visibility-'+phase+'.json',{'databaseExistedBefore':phase=='warm','databaseExistsAfter':True,'initialTotal':2 if phase=='warm' else 0,'ranked':True,'flagDisabled':True,'expiredBefore':1,'expiredAfter':0,'activePauseCount':1})
  (p/('compression-'+phase+'.private')).write_text('normal output\n')
  put('compression-'+phase+'.json',{'databaseExistedBefore':phase=='warm','databaseExistsAfter':True,'beforeColumns':28 if phase=='warm' else 10,'afterColumns':28,'finalColumns':28,'first':{'status':200,'totalRequests':1 if phase=='warm' else 0,'chartLength':24},'populated':{'status':200,'totalRequests':1,'chartLength':24},'rows':1})
  (p/('csrf-'+phase+'.private')).write_text('normal output\n')
  csrf_result={'status':200,'issued':True,'noStore':True,'cookieMutation':False}
  put('csrf-'+phase+'.json',{'databaseExistedBefore':phase=='warm','databaseAfterFirst':True,'first':csrf_result,'second':csrf_result,'firstSettingsUnchanged':True if phase=='warm' else None,'settingsUnchanged':True})
 put('auth-cold.json',authcold); put('auth-warm.json',authwarm)
 sso_enabled={'enabled':True,'authorityHost':'https://login.example.test','tenantId':'tenant.example','clientId':'fixture-client','audience':'api://fixture-audience','issuer':'https://login.example.test/tenant.example/v2.0','scope':'api://fixture-audience/.default'}
 put('sso-cold.json',{'databaseExistedBefore':False,'databaseExistsAfter':True,'onboardingBefore':'absent','onboardingPersisted':True,'first':{'status':200,'body':{'enabled':False}},'cached':None,'refreshed':None})
 put('sso-warm.json',{'databaseExistedBefore':True,'databaseExistsAfter':True,'onboardingBefore':'persisted','onboardingPersisted':True,'first':{'status':200,'body':sso_enabled},'cached':True,'refreshed':False})
 login_body={'authenticated':False,'requireLogin':True,'hasPassword':True,'setupComplete':True,'oidcEnabled':False,'oidcDisablePasswordLogin':False,'nodeVersion':'v24.17.0','nodeCompatible':True}
 for phase in ('cold','warm'): put('login-'+phase+'.json',{'databaseExistedBefore':phase=='warm','databaseExistsAfter':True,'onboardingBefore':'persisted' if phase=='warm' else 'absent','onboardingPersisted':True,'status':200,'body':login_body})
 for phase in ('cold','warm'): put('history-'+phase+'.json',{'databaseExistedBefore':phase=='warm','databaseExistsAfter':True,'status':200,'body':{'tasks':[],'total':0,'limit':100,'offset':0},'rows':0,'onboardingPersisted':True})
 zero={'totalRequests':0,'variantBreakdown':{},'topProviders':[]}; populated={'totalRequests':1,'variantBreakdown':{'fast':1},'topProviders':[{'provider':'alpha','count':1}]}
 for phase in ('cold','warm'): put('analytics-'+phase+'.json',{'databaseExistedBefore':phase=='warm','databaseExistsAfter':True,'first':{'status':200,'body':zero if phase=='cold' else populated},'populated':{'status':200,'body':populated},'failure':{'status':200,'body':zero},'rows':1})
 for phase in ('cold','warm'): put('diversity-'+phase+'.json',{'databaseExistedBefore':phase=='warm','databaseAfterRoute':phase=='warm','databaseAfterSettings':True,'first':0,'populated':1,'unchanged':True})
 for phase in ('cold','warm'): put('concurrency-'+phase+'.json',{'databaseExistedBefore':phase=='warm','databaseAfterAuth':True,'driver':'node:sqlite','empty':{'rateLimits':0,'comboQueues':0,'semaphores':0},'populated':{'rateLimits':1,'comboQueues':1,'semaphores':1},'unchanged':True})
 mfa_base={'databaseExistsAfter':True,'beforeFileCount':0,'afterFileCount':1,'enabled':False,'backupCodesRemaining':0,'recoverySwitchSet':False,'mfaRows':0}
 mfacold={**mfa_base,'databaseExistedBefore':False,'corruptEnabled':None,'corruptCount':None,'rowUnchanged':None}
 mfawarm={**mfa_base,'databaseExistedBefore':True,'corruptEnabled':True,'corruptCount':1,'rowUnchanged':True}
 put('mfa-cold.json',mfacold); put('mfa-warm.json',mfawarm)
 def reject():
  try: m.export_core_lifecycle(p,{})
  except (RuntimeError,ValueError,KeyError,TypeError): return
  raise AssertionError('invalid lifecycle accepted')
 (p/'cold-lifecycle.private').write_text('[HOT_RELOAD] Failed to apply runtime settings\n')
 put('cold-lifecycle.json',cold); put('warm-lifecycle.json',warm); put('core-identity.json',identity); reject()
 (p/'cold-lifecycle.private').write_text('normal output\n')
 put('cold-lifecycle.json',cold); put('warm-lifecycle.json',warm); put('core-identity.json',identity)
 oidc_cold=json.loads((p/'oidc-cold.json').read_text()); oidc_cold['setupPersisted']=False; put('oidc-cold.json',oidc_cold); reject(); oidc_cold['setupPersisted']=True; put('oidc-cold.json',oidc_cold)
 original=identity['oidcClosure'][m.OIDC_CALLBACK]; identity['oidcClosure'][m.OIDC_CALLBACK]='b'*64; put('core-identity.json',identity); reject(); identity['oidcClosure'][m.OIDC_CALLBACK]=original; put('core-identity.json',identity)
 a2a_cold=json.loads((p/'a2a-cold.json').read_text()); a2a_cold['timerPurgedOldHistory']=False; put('a2a-cold.json',a2a_cold); reject(); a2a_cold['timerPurgedOldHistory']=True; put('a2a-cold.json',a2a_cold)
 original=identity['a2aClosure']['src/lib/a2a/taskManager.ts']; identity['a2aClosure']['src/lib/a2a/taskManager.ts']='b'*64; put('core-identity.json',identity); reject(); identity['a2aClosure']['src/lib/a2a/taskManager.ts']=original; put('core-identity.json',identity)
 sso_warm=json.loads((p/'sso-warm.json').read_text()); sso_warm['cached']=False; put('sso-warm.json',sso_warm); reject(); sso_warm['cached']=True; put('sso-warm.json',sso_warm)
 login_cold=json.loads((p/'login-cold.json').read_text()); login_cold['onboardingPersisted']=False; put('login-cold.json',login_cold); reject(); login_cold['onboardingPersisted']=True; put('login-cold.json',login_cold)
 history_cold=json.loads((p/'history-cold.json').read_text()); history_cold['onboardingPersisted']=False; put('history-cold.json',history_cold); reject(); history_cold['onboardingPersisted']=True; put('history-cold.json',history_cold)
 visibility_cold=json.loads((p/'visibility-cold.json').read_text()); visibility_cold['activePauseCount']=0; put('visibility-cold.json',visibility_cold); reject(); visibility_cold['activePauseCount']=1; put('visibility-cold.json',visibility_cold)
 original=identity['visibilityClosure']['src/lib/db/proxies/rotation.ts']; identity['visibilityClosure']['src/lib/db/proxies/rotation.ts']='b'*64; put('core-identity.json',identity); reject(); identity['visibilityClosure']['src/lib/db/proxies/rotation.ts']=original; put('core-identity.json',identity)
 analytics_cold=json.loads((p/'analytics-cold.json').read_text()); analytics_cold['failure']['status']=500; put('analytics-cold.json',analytics_cold); reject(); analytics_cold['failure']['status']=200; put('analytics-cold.json',analytics_cold)
 compression_cold=json.loads((p/'compression-cold.json').read_text()); compression_cold['afterColumns']=10; put('compression-cold.json',compression_cold); reject(); compression_cold['afterColumns']=28; put('compression-cold.json',compression_cold)
 diversity_cold=json.loads((p/'diversity-cold.json').read_text()); diversity_cold['unchanged']=False; put('diversity-cold.json',diversity_cold); reject(); diversity_cold['unchanged']=True; put('diversity-cold.json',diversity_cold)
 csrf_cold=json.loads((p/'csrf-cold.json').read_text()); csrf_cold['settingsUnchanged']=False; put('csrf-cold.json',csrf_cold); reject(); csrf_cold['settingsUnchanged']=True; put('csrf-cold.json',csrf_cold)
 diversity_cold['databaseAfterRoute']=True; put('diversity-cold.json',diversity_cold); reject(); diversity_cold['databaseAfterRoute']=False; put('diversity-cold.json',diversity_cold)
 original=identity['diversityClosure']['open-sse/services/comboMetrics.ts']; identity['diversityClosure']['open-sse/services/comboMetrics.ts']='b'*64; put('core-identity.json',identity); reject(); identity['diversityClosure']['open-sse/services/comboMetrics.ts']=original; put('core-identity.json',identity)
 batchcold=json.loads((p/'batch-cold.json').read_text()); batchcold['rows']=0; put('batch-cold.json',batchcold); reject(); batchcold['rows']=1; put('batch-cold.json',batchcold)
 original=identity['batchClosure']['executed'][m.BATCH_LIST]; identity['batchClosure']['executed'][m.BATCH_LIST]='b'*64; put('core-identity.json',identity); reject(); identity['batchClosure']['executed'][m.BATCH_LIST]=original; put('core-identity.json',identity)
 original=identity.pop('concurrencyClosure'); put('core-identity.json',identity); reject(); identity['concurrencyClosure']=original; put('core-identity.json',identity)
 original=identity['concurrencyClosure'][m.CONCURRENCY_ROUTE]; identity['concurrencyClosure'][m.CONCURRENCY_ROUTE]='b'*64; put('core-identity.json',identity); reject(); identity['concurrencyClosure'][m.CONCURRENCY_ROUTE]=original; put('core-identity.json',identity)
 original=identity['loginClosure']['sources'][m.REQUIRE_LOGIN]; identity['loginClosure']['sources'][m.REQUIRE_LOGIN]='b'*64; put('core-identity.json',identity); reject(); identity['loginClosure']['sources'][m.REQUIRE_LOGIN]=original; put('core-identity.json',identity)
 original=identity['ssoClosure'][m.SSO_CONFIG]; identity['ssoClosure'][m.SSO_CONFIG]='b'*64; put('core-identity.json',identity); reject(); identity['ssoClosure'][m.SSO_CONFIG]=original; put('core-identity.json',identity)
 warm['migrations']=[{'version':'002','name':'other'}]; put('warm-lifecycle.json',warm); reject()
 warm['migrations']=cold['migrations']; warm['healthWorker']=False; put('warm-lifecycle.json',warm); reject()
 warm['healthWorker']=True; warm['before']=[]; put('warm-lifecycle.json',warm); reject()
 warm['before']=[db]; put('warm-lifecycle.json',warm)
 identity['workerOutputSha256']='private-canary'; put('core-identity.json',identity); reject()
 identity['workerOutputSha256']=h; identity['runnerArguments']=['/runtime/node','bundled.mjs']; put('core-identity.json',identity); reject()
 identity['runnerArguments']=['/runtime/node','--import','tsx/esm','/work/app/src/lib/db/pinnedLifecycleFixture.mjs']; identity['runnerOutputSha256']=h; put('core-identity.json',identity); reject()
 del identity['runnerOutputSha256']; cold['runtimeSettingApplied']=False; put('cold-lifecycle.json',cold); put('core-identity.json',identity); reject()
 cold['runtimeSettingApplied']=True; put('cold-lifecycle.json',cold)
 log=p/'lifecycle.private'; log.write_text('normal output\n'); m.validate_lifecycle_log(log)
 log.write_text('[HOT_RELOAD] Failed to apply runtime settings after update\n')
 try: m.validate_lifecycle_log(log)
 except RuntimeError: pass
 else: raise AssertionError('runtime reload warning accepted')
 log.write_bytes(b'x'*(2*1024**2+1))
 try: m.validate_lifecycle_log(log)
 except RuntimeError: pass
 else: raise AssertionError('oversized lifecycle log accepted')
 identity['workerOutputSha256']=h; put('core-identity.json',identity)
 success={'status':200,'body':{'success':True}}
 def reply(body): return {'status':200,'body':body}
 provider={'phase':'cold','results':[
  {'route':'interception-rules','before':reply({}),'applied':success,'after':reply({'interceptSearch':True}),'deleted':success,'restored':reply({})},
  {'route':'param-filters','before':reply({'block':[],'allow':[],'autoLearn':False}),'applied':success,'after':reply({'block':['temperature'],'allow':[],'autoLearn':False}),'deleted':success,'restored':reply({'block':[],'allow':[],'autoLearn':False})},
  {'route':'cc-alias','before':reply({'provider':None,'models':{}}),'applied':success,'after':reply({'provider':'on','models':{}})}]}
 pwarm=reply({'provider':'on','models':{}})
 collection={'getStatus':200,'patchStatus':200,'patchCount':1,'patchedActive':True,'deleteStatus':200,'deleteCount':1,'deletedAbsent':True,'nodeGetStatus':200,'nodeCount':0}
 node={'status':201,'persisted':True,'prefix':'native-fixture-node'}
 cases=[('GET /api/keys',200),('GET /api/keys/{id}',200),('GET /api/settings/proxies/assignments',200),('GET /api/v1/management/proxies/assignments',200),('GET /api/v1/management/proxies/assignments',400),('GET /api/models',200),('GET /api/models',400),('POST /api/combos',201),('GET /api/settings/proxies/assignments',200),('GET /api/v1/management/proxies/assignments',200),('POST /api/combos',201),('PATCH /api/combos/{id}',200),('PUT /api/combos/{id}',200),('GET /api/combos/{id}',200),('GET /api/combos',200),('POST /api/combos/reorder',200),('GET /api/combos/export',200),('POST /api/combos/import',200),('POST /api/combos/import',400),('DELETE /api/combos/{id}',200),('GET /api/settings/proxies/assignments',200),('GET /api/keys/{id}',200),('POST /api/combos/import',200),('GET /api/combos/auto',200),('GET /api/combos/builder/options',200),('POST /api/combos/duplicate',201),('GET /api/combos/metrics',200),('DELETE /api/combos/metrics',200),('POST /api/combos/duplicate',422),('POST /api/combos/test',404)]
 metrics_index=cases.index(('GET /api/combos/metrics',200))
 cases[metrics_index:metrics_index+2]=[(method+' /api/combos/metrics',200) for method in ('GET','GET','GET','DELETE','GET','GET','DELETE','GET')]
 coldmetrics={'hiddenOnlyGetNull':True,'hiddenOnlyOwnerCount':1,'selectedProduction':1,'selectedShadow':1,'selectedHidden':1,'allNames':2,'selectedResetAbsent':True,'unrelatedProduction':1,'unrelatedShadow':1,'unrelatedHidden':1,'globalResetAbsent':True,'restartSeedProduction':1,'restartSeedShadow':1,'restartSeedHidden':1,'cleanupTimerObservable':False}
 warmmetrics={'freshProcessProductionAndShadowAbsent':True,'freshProcessHiddenCount':0,'cleanupTimerObservable':False}
 combo={'phase':'cold','driver':'node:sqlite','observations':[{'operation':op,'status':status,'mediaType':'application/json'} for op,status in cases],'grantAfterDelete':['combo/*'],'deletedAbsent':True,'importedPersisted':True,'exportSecretAbsent':True,'metricsLifecycle':coldmetrics}
 cwarm={'phase':'warm','driver':'node:sqlite','importedPersisted':True,'deletedAbsent':True,'metricsLifecycle':warmmetrics}
 for name,value in [('provider-lifecycle.json',provider),('provider-warm.json',pwarm),('provider-collection-lifecycle.json',collection),('provider-node-create.json',node),('cold-combo-lifecycle.json',combo),('warm-combo-lifecycle.json',cwarm)]: put(name,value)
 sweeps=[{'phase':phase,'firstStatus':200,'secondStatus':200,'encryptedAfterFirst':success,'encryptedAfterSecond':success,'cacheInvalidated':success,'nativeBackupCalls':0,'backupCountBefore':0,'backupCountAfter':0} for phase,success in [('sweep-success',True),('sweep-failure',False)]]
 for value in sweeps: put(value['phase']+'.json',value)
 def reject_without_export():
  reject()
  assert not (p/'export').exists(), 'invalid observation left partial success artifacts'
 provider['results'][0]['after']['body']={}; put('provider-lifecycle.json',provider); reject_without_export()
 provider['results'][0]['after']['body']={'interceptSearch':True}; put('provider-lifecycle.json',provider)
 put('provider-warm.json',reply({'provider':None,'models':{}})); reject_without_export(); put('provider-warm.json',pwarm)
 collection['deletedAbsent']=False; put('provider-collection-lifecycle.json',collection); reject_without_export(); collection['deletedAbsent']=True; put('provider-collection-lifecycle.json',collection)
 node['persisted']=False; put('provider-node-create.json',node); reject_without_export(); node['persisted']=True; put('provider-node-create.json',node)
 combo['observations'][0]['status']=500; put('cold-combo-lifecycle.json',combo); reject_without_export(); combo['observations'][0]['status']=200; put('cold-combo-lifecycle.json',combo)
 removed=combo['observations'].pop(metrics_index); put('cold-combo-lifecycle.json',combo); reject_without_export(); combo['observations'].insert(metrics_index,removed); put('cold-combo-lifecycle.json',combo)
 coldmetrics['unrelatedHidden']=0; put('cold-combo-lifecycle.json',combo); reject_without_export(); coldmetrics['unrelatedHidden']=1; put('cold-combo-lifecycle.json',combo)
 removed=coldmetrics.pop('hiddenOnlyOwnerCount'); put('cold-combo-lifecycle.json',combo); reject_without_export(); coldmetrics['hiddenOnlyOwnerCount']=removed; put('cold-combo-lifecycle.json',combo)
 warmmetrics['freshProcessHiddenCount']=False; put('warm-combo-lifecycle.json',cwarm); reject_without_export(); warmmetrics['freshProcessHiddenCount']=0; put('warm-combo-lifecycle.json',cwarm)
 closure=identity['comboMetricsClosure']; identity['comboMetricsClosure']={**closure,m.COMBO_METRICS_CLOSURE[0]:'c'*64}; put('core-identity.json',identity); reject_without_export(); identity['comboMetricsClosure']=closure; put('core-identity.json',identity)
 cwarm['importedPersisted']=False; put('warm-combo-lifecycle.json',cwarm); reject_without_export(); cwarm['importedPersisted']=True; put('warm-combo-lifecycle.json',cwarm)
 (p/'provider-node-create.json').unlink(); reject_without_export(); put('provider-node-create.json',node)
 sweeps[1]['encryptedAfterSecond']=True; put('sweep-failure.json',sweeps[1]); reject_without_export(); sweeps[1]['encryptedAfterSecond']=False; put('sweep-failure.json',sweeps[1])
 authwarm['databaseExistedBefore']=False; put('auth-warm.json',authwarm); reject_without_export(); authwarm['databaseExistedBefore']=True; put('auth-warm.json',authwarm)
 concurrency_cold=json.loads((p/'concurrency-cold.json').read_text()); concurrency_cold['populated']['rateLimits']=0; put('concurrency-cold.json',concurrency_cold); reject_without_export(); concurrency_cold['populated']['rateLimits']=1; put('concurrency-cold.json',concurrency_cold)
 m.export_core_lifecycle(p,{})
 result=json.loads((p/'export/core-lifecycle.json').read_text())
 assert 'private-canary' not in json.dumps(result) and result['qualification'] is False
 assert result['cold']['databaseExistedBefore'] is False and result['warm']['databaseExistedBefore'] is True
 assert result['authStatus']=={'cold':authcold,'warm':authwarm}
 assert result['diversity']=={phase:{'databaseExistedBefore':phase=='warm','databaseAfterRoute':phase=='warm','databaseAfterSettings':True,'first':0,'populated':1,'unchanged':True} for phase in ('cold','warm')}
 concurrency=json.loads((p/'export/concurrency-lifecycle.json').read_text())
 assert set(concurrency)=={'status','qualification','boundary','inputSha256','identity','cold','warm'} and concurrency['status']=='research-observed' and concurrency['qualification'] is False and 'private-canary' not in json.dumps(concurrency)
 assert concurrency['identity']['concurrencyClosure']==identity['concurrencyClosure'] and all(concurrency[phase]==json.loads((p/('concurrency-'+phase+'.json')).read_text()) for phase in ('cold','warm'))
 batch=json.loads((p/'export/batch-lifecycle.json').read_text()); assert batch['identity']['batchClosure']==identity['batchClosure'] and batch['qualification'] is False and batch['cold']['rows']==1
 assert result['ssoConfig']['cold']['onboardingBefore']=='absent' and result['ssoConfig']['warm']['onboardingBefore']=='persisted' and result['ssoConfig']['warm']['cached'] is True and result['ssoConfig']['warm']['refreshed'] is False
 assert result['identity']['migrationSqlCount']==222 and result['cold']['migrationCount']==1
 assert result['identity']['runnerArguments']==identity['runnerArguments'] and 'runnerOutputSha256' not in result['identity']
 assert result['cold']['runtimeSettingApplied'] is True and result['warm']['runtimeSettingApplied'] is False
 assert result['cold']['hotReloadFailure'] is False and result['warm']['hotReloadFailure'] is False
 assert result['cold']['tableSha256']==result['warm']['tableSha256'] and result['cold']['migrationSha256']==result['warm']['migrationSha256']
 assert result['isolation']=={'network':'private-loopback-only','capabilities':'dropped','source':'read-only','processes':'separate-cold-warm','startupRegressions':'passed'}
 for name in ('provider-lifecycle.json','provider-collection-lifecycle.json','provider-node-create.json','combo-lifecycle.json','deprecated-provider-sweep.json','csrf-lifecycle.json'):
  artifact=json.loads((p/'export'/name).read_text())
  assert artifact['qualification'] is False and 'private-canary' not in json.dumps(artifact)
`;
  const result = spawnSync("python3", ["-c", code, runner], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
