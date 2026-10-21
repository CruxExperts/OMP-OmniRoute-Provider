import { randomUUID } from "node:crypto";
import { loadConfig, updateConfig, type CredentialDomain, type CredentialReference } from "./config.ts";
import type { AuthStorage, StoredAuthCredential } from "@oh-my-pi/pi-ai";

export type CredentialStore = {
  credentials: Pick<AuthStorage["credentials"], "set" | "list" | "removeById">;
};
export interface CredentialBinding { endpoint: string; generation: number }
export interface OptionalCredential { value: string; kind: "apiKey" | "cookie" }

function rawKey(credential: unknown): string | undefined {
  if (!credential || typeof credential !== "object" || !("type" in credential) || credential.type !== "api_key" || !("key" in credential)) return undefined;
  return typeof credential.key === "string" && credential.key.length > 0 ? credential.key : undefined;
}
function matches(ref: CredentialBinding, binding: CredentialBinding): boolean {
  return ref.endpoint === binding.endpoint && ref.generation === binding.generation;
}

/** One instance per loaded extension. Optional secrets never enter configuration. */
export class OptionalCredentials {
  readonly #session = new Map<CredentialDomain, OptionalCredential & CredentialBinding>();
  readonly #epochs = new Map<CredentialDomain, number>();
  readonly #signals = new Map<CredentialDomain, AbortController>();
  readonly #observed = new Map<CredentialDomain, { credential?: OptionalCredential; endpoint: string; reference: string }>();
  #busy = false;

  getEpoch(domain: CredentialDomain): number { return this.#epochs.get(domain) ?? 0; }

  getSignal(domain: CredentialDomain): AbortSignal {
    let controller = this.#signals.get(domain);
    if (!controller) {
      controller = new AbortController();
      this.#signals.set(domain, controller);
    }
    return controller.signal;
  }

  #advance(domain: CredentialDomain): void {
    this.#signals.get(domain)?.abort();
    this.#signals.delete(domain);
    this.#epochs.set(domain, this.getEpoch(domain) + 1);
    this.#observed.delete(domain);
  }

  clear(): void {
    this.#advance("metadata");
    this.#advance("admin");
    this.#session.clear();
  }

  hasSession(domain: CredentialDomain, binding: CredentialBinding): boolean {
    const credential = this.#session.get(domain);
    return credential !== undefined && matches(credential, binding);
  }

  async resolve(domain: CredentialDomain, binding: CredentialBinding, store: CredentialStore | undefined, environment?: OptionalCredential): Promise<OptionalCredential | undefined> {
    const config = await loadConfig();
    let credential: OptionalCredential | undefined;
    let reference = "missing";
    if (!config.pending) {
      if (environment) {
        credential = { ...environment };
        reference = "environment";
      } else {
        const session = this.#session.get(domain);
        if (session && matches(session, binding)) {
          credential = { value: session.value, kind: session.kind };
          reference = "session";
        } else if (!session) {
          const ref = config.optionalCredentials?.[domain];
          if (ref?.state === "ready" && matches(ref, binding) && store) {
            const row = store.credentials.list(ref.providerKey).find(row => row.provider === ref.providerKey && row.id === ref.rowId);
            const value = rawKey(row?.credential);
            if (value) {
              credential = { value, kind: ref.kind };
              reference = `${ref.providerKey}:${ref.rowId}`;
            }
          }
        }
      }
    }
    const previous = this.#observed.get(domain);
    if (!previous || previous.endpoint !== binding.endpoint || previous.reference !== reference
      || previous.credential?.kind !== credential?.kind || previous.credential?.value !== credential?.value) {
      this.#advance(domain);
      this.#observed.set(domain, { endpoint: binding.endpoint, reference, ...(credential ? { credential: { ...credential } } : {}) });
    }
    return credential;
  }

  async save(domain: CredentialDomain, credential: OptionalCredential, binding: CredentialBinding, remember: boolean, store: CredentialStore): Promise<void> {
    if (this.#busy) throw new Error("credential operation already in progress");
    this.#busy = true;
    try {
      if (!credential.value.trim() || (domain === "metadata" && credential.kind !== "apiKey")) throw new Error("invalid optional credential");
      const config = await loadConfig();
      if (config.pending) throw new Error("finish runtime setup before optional credentials");
      if (config.optionalCredentials?.[domain]) throw new Error("forget the existing credential before replacing it");
      this.#advance(domain);
      if (!remember) { this.#session.set(domain, { ...credential, ...binding }); return; }
      const ref: CredentialReference = { domain, ...binding, kind: credential.kind, state: "pending", providerKey: `cruxomni-${domain}-${randomUUID()}` };
      const staged = await updateConfig(current => ({ ...current, optionalCredentials: { ...current.optionalCredentials, [domain]: ref } }), { expectedRevision: config.revision ?? null });
      let row: StoredAuthCredential | undefined;
      try {
        await store.credentials.set(ref.providerKey, { type: "api_key", key: credential.value });
        const rows = store.credentials.list(ref.providerKey).filter(item => item.provider === ref.providerKey);
        if (rows.length !== 1 || rawKey(rows[0]!.credential) !== credential.value) throw new Error("credential readback failed");
        row = rows[0]!;
        await updateConfig(current => ({ ...current, optionalCredentials: { ...current.optionalCredentials, [domain]: { ...ref, rowId: row!.id, state: "ready" } } }), { expectedRevision: staged.revision ?? null });
        this.#session.delete(domain);
      } catch {
        // Reconcile an uncertain persistence result by exact newly owned identity.
        // Retain the pending marker if storage or config cleanup cannot be proved.
        try {
          const owned = store.credentials.list(ref.providerKey).filter(item => item.provider === ref.providerKey);
          for (const item of owned) {
            if (!(await store.credentials.removeById(ref.providerKey, item.id))) throw new Error("credential cleanup incomplete");
          }
          if (store.credentials.list(ref.providerKey).length !== 0) throw new Error("credential cleanup uncertain");
          await updateConfig(current => {
            if (current.optionalCredentials?.[domain]?.providerKey !== ref.providerKey) throw new Error("credential ownership changed");
            const refs = { ...current.optionalCredentials }; delete refs[domain];
            return { ...current, optionalCredentials: refs };
          }, { expectedRevision: staged.revision ?? null });
        } catch { /* Pending reference is the recovery record, never usable as a key. */ }
        throw new Error("remembered credential was not activated; inspect setup recovery state");
      }
    } finally { this.#busy = false; }
  }

  async forget(domain: CredentialDomain, store: CredentialStore): Promise<void> {
    if (this.#busy) throw new Error("credential operation already in progress");
    this.#busy = true;
    this.#advance(domain);
    this.#session.delete(domain);
    try {
      const config = await loadConfig();
      const ref = config.optionalCredentials?.[domain];
      if (!ref) return;
      const revoked = await updateConfig(current => ({ ...current, optionalCredentials: { ...current.optionalCredentials, [domain]: { ...ref, state: "revoked" } } }), { expectedRevision: config.revision ?? null });
      const rows = store.credentials.list(ref.providerKey).filter(row => row.provider === ref.providerKey && (ref.rowId === undefined || row.id === ref.rowId));
      for (const row of rows) if (!(await store.credentials.removeById(ref.providerKey, row.id))) throw new Error("credential removal incomplete");
      if (store.credentials.list(ref.providerKey).some(row => ref.rowId === undefined || row.id === ref.rowId)) throw new Error("credential removal uncertain");
      await updateConfig(current => {
        const refs = { ...current.optionalCredentials }; delete refs[domain];
        return { ...current, optionalCredentials: refs };
      }, { expectedRevision: revoked.revision ?? null });
    } finally { this.#busy = false; }
  }
}
