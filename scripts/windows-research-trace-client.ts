import { createConnection } from "node:net";

type TraceEvent = { seq: number; kind: string; id: number; a: number; b: number; c: number; d: number };
type TraceRead = { status: "available"; pid: number; events: TraceEvent[]; cursor: number; overflow: boolean; dropped: number; bytes: number } | { status: "unavailable" | "invalid" | "busy" };
const kinds: Record<string, true> = {
	"received": true, "sequence": true, "win32": true, "normalized": true, "focus": true,
	"custom": true, "editor": true, "state": true, "assist-return": true, "completion-applied": true,
	"completion-return": true, "completion-stale-return": true, "navigation-return": true,
	"paste-return": true, "alt-return": true, "submit-entered": true, "submit-disabled": true,
	"unrelated-newline": true, "editor-return": true, "dictation-return": true,
	"callback-dispatch": true, "gate": true, "callback-assigned": true, "callback-entry": true, "login": true,
	"startup": true,
};
const integer = (x: unknown, max: number): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0 && x <= max;
const object = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

// Call at fixture observation boundaries; never use this operation to drive input or readiness.
// One instance belongs to one process/endpoint. Failures do not advance the cursor.
export class ResearchTraceClient {
	private cursor = 0;
	private pid: number | undefined;
	private busy = false;
	constructor(private readonly endpoint: string) {}

	async read(): Promise<TraceRead> {
		if (this.busy) return { status: "busy" };
		this.busy = true;
		const { promise, resolve } = Promise.withResolvers<TraceRead>();
		const socket = createConnection(this.endpoint);
		let buffer = "";
		let finished = false;
		const finish = (result: TraceRead) => {
			if (finished) return;
			finished = true;
			this.busy = false;
			clearTimeout(timer);
			socket.destroy();
			resolve(result);
		};
		const timer = setTimeout(() => finish({ status: "unavailable" }), 1000);
		socket.on("error", () => finish({ status: "unavailable" }));
		socket.on("close", () => finish({ status: "unavailable" }));
		socket.on("connect", () => socket.write(`${JSON.stringify({ op: "research-trace", cursor: this.cursor })}\n`));
		socket.on("data", chunk => {
			buffer += chunk.toString();
			if (Buffer.byteLength(buffer) > 65536) return finish({ status: "invalid" });
			const end = buffer.indexOf("\n");
			if (end < 0) return;
			let value: unknown;
			try { value = JSON.parse(buffer.slice(0, end)); } catch { return finish({ status: "invalid" }); }
			if (!object(value)) return finish({ status: "invalid" });
			if (value.ok !== true || value.available !== true) return finish({ status: "unavailable" });
			if (!integer(value.pid, 0x7fffffff) || value.pid === 0 || (this.pid !== undefined && value.pid !== this.pid) || !integer(value.cursor, 256) || value.cursor < this.cursor || typeof value.overflow !== "boolean" || !integer(value.dropped, Number.MAX_SAFE_INTEGER) || value.overflow !== (value.dropped > 0) || !integer(value.bytes, 32768) || !Array.isArray(value.events) || value.events.length !== value.cursor - this.cursor) return finish({ status: "invalid" });
			let seq = this.cursor;
			const events: TraceEvent[] = [];
			for (const e of value.events) {
				if (!object(e) || e.seq !== ++seq || typeof e.kind !== "string" || !Object.hasOwn(kinds, e.kind) || !integer(e.id, Number.MAX_SAFE_INTEGER) || !integer(e.a, 256) || !integer(e.b, 256) || !integer(e.c, 256) || !integer(e.d, 256)) return finish({ status: "invalid" });
				events.push({ seq: e.seq, kind: e.kind, id: e.id, a: e.a, b: e.b, c: e.c, d: e.d });
			}
			this.cursor = value.cursor;
			this.pid = value.pid;
			finish({ status: "available", pid: value.pid, events, cursor: value.cursor, overflow: value.overflow, dropped: value.dropped, bytes: value.bytes });
		});
		return await promise;
	}
}
