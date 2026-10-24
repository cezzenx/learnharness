import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { EffortLevel, Options, Query, SDKMessage, SDKUserMessage, ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PATHS } from "../../../config.ts";
import packageMetadata from "../../../package.json" with { type: "json" };
import { cancelledCallResult, createToolServer, MCP_SERVER_NAME, MCP_TOOL_PREFIX, toCallToolResult } from "./mcp-tools.ts";
import { baseCallId, type SessionConfig, type UserBlock } from "./transcript.ts";

/**
 * Live Claude Code sessions (docs/claude-code-provider.md).
 *
 * One session per app conversation (`sessionId`: the chat id for teaching
 * turns, a fresh UUID per subagent run). A session is one Claude Code
 * process driven through the Agent SDK in streaming-input mode. It stays
 * alive between the app's requests so tool calls and quiz answers resume
 * the same conversation, and is shut down after IDLE_MS without use.
 */

export const IDLE_MS = 30 * 60_000;
/** Parked tool calls (an open quiz) may wait this long inside Claude Code. */
const TOOL_CALL_TIMEOUT_MS = 24 * 60 * 60_000;

/** Note appended to the app's system prompt so tool names line up. */
export const TOOL_NAME_NOTE = `\n\n(Tool naming: each tool named in these instructions is available to you as \`${MCP_TOOL_PREFIX}<name>\`, e.g. \`${MCP_TOOL_PREFIX}quiz\` for \`quiz\`.)`;

// ---------------------------------------------------------------------------
// Process environment and binary
// ---------------------------------------------------------------------------

/**
 * The environment for the Claude Code process. Anything that would make it
 * bill an API key or another backend instead of the signed-in subscription
 * is removed, as are the app's own secrets.
 */
export function claudeCodeEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = {};
	for (const [name, value] of Object.entries(env)) {
		if (/^ANTHROPIC_/.test(name)) continue;
		if (/^CLAUDE_CODE_USE_/.test(name)) continue;
		if (/^LH_/.test(name)) continue;
		if (name === "CLAUDECODE" || name === "CLAUDE_CODE_ENTRYPOINT" || name === "ELECTRON_RUN_AS_NODE") continue;
		out[name] = value;
	}
	out.DISABLE_AUTO_COMPACT = "1";
	out.ENABLE_TOOL_SEARCH = "false";
	out.CLAUDE_AGENT_SDK_CLIENT_APP = `learnharness/${packageMetadata.version}`;
	return out;
}

let binaryLookup: Promise<string | undefined> | undefined;

/** The installed `claude` on PATH, else undefined (the SDK then uses its bundled binary). */
export function resolveClaudeBinary(): Promise<string | undefined> {
	if (!binaryLookup) {
		binaryLookup = (async () => {
			try {
				const finder = process.platform === "win32" ? "where" : "which";
				const { stdout } = await promisify(execFile)(finder, ["claude"], { windowsHide: true, timeout: 5000 });
				const found = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
				// On Windows prefer the native .exe over npm's .cmd shim.
				return found.find((p) => /\.exe$/i.test(p)) ?? (process.platform === "win32" ? undefined : found[0]);
			} catch {
				return undefined;
			}
		})();
	}
	return binaryLookup;
}

/** Test seam: pin the binary lookup result (undefined = bundled), or `null` to look it up again. */
export function setClaudeBinaryOverride(binary: string | undefined | null): void {
	binaryLookup = binary === null ? undefined : Promise.resolve(binary);
}

/** A private, empty working directory, so no project files or settings leak in. */
function sessionCwd(): string {
	const dir = path.join(PATHS.data ?? os.tmpdir(), "claude-code-cwd");
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** App thinking level → Claude Code thinking + effort. */
export function thinkingOptions(level: string, supported?: readonly EffortLevel[]): { thinking: ThinkingConfig; effort?: EffortLevel } {
	if (level === "off") return { thinking: { type: "disabled" } };
	const wanted: EffortLevel = level === "minimal" || level === "low" ? "low" : level === "medium" ? "medium" : level === "high" ? "high" : level === "xhigh" ? "xhigh" : level === "max" ? "max" : "medium";
	let effort: EffortLevel | undefined = wanted;
	if (supported && !supported.includes(wanted)) {
		const order: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
		effort = [...supported].sort((a, b) => Math.abs(order.indexOf(a) - order.indexOf(wanted)) - Math.abs(order.indexOf(b) - order.indexOf(wanted)))[0];
	}
	return { thinking: { type: "adaptive", display: "summarized" }, effort };
}

/** The SDK options shared by every Claude Code process this app starts. */
export function baseOptions(binary: string | undefined, env: Record<string, string | undefined>): Options {
	return {
		...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
		cwd: sessionCwd(),
		tools: [],
		settingSources: [],
		strictMcpConfig: true,
		persistSession: false,
		verbatimPrompts: true,
		env: claudeCodeEnv(env),
	};
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Starts the SDK query (test seam: swapped for a fake). */
export type QueryFactory = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

let queryFactory: QueryFactory | undefined;
export function setQueryFactory(factory: QueryFactory | undefined): void { queryFactory = factory; }
async function startQuery(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Promise<Query> {
	if (queryFactory) return queryFactory(params);
	const { query } = await import("@anthropic-ai/claude-agent-sdk");
	return query(params);
}

/** A push-driven async iterable of user messages (the session's stdin). */
class InputQueue implements AsyncIterable<SDKUserMessage> {
	private items: SDKUserMessage[] = [];
	private wake: (() => void) | undefined;
	private done = false;
	push(message: SDKUserMessage): void { this.items.push(message); this.wake?.(); }
	close(): void { this.done = true; this.wake?.(); }
	async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		while (true) {
			while (this.items.length) yield this.items.shift()!;
			if (this.done) return;
			await new Promise<void>((resolve) => { this.wake = resolve; });
			this.wake = undefined;
		}
	}
}

export class ClaudeCodeSession {
	readonly config: SessionConfig;
	/** Fingerprints of the conversation the process has seen (transcript.ts). */
	seen: string[] = [];
	/** Tool calls handed to the app, waiting for its results (base ids). */
	readonly awaiting = new Set<string>();
	/** True while an app request is reading this session. */
	busy = false;
	closed = false;
	closeReason = "";

	private readonly input = new InputQueue();
	private readonly query: Promise<Query>;
	private readonly events: SDKMessage[] = [];
	private eventWaiter: (() => void) | undefined;
	/** MCP calls parked inside Claude Code, by tool-use id. */
	private readonly parked = new Map<string, (result: CallToolResult) => void>();
	/** Results the app delivered before Claude Code asked for them. */
	private readonly ready = new Map<string, CallToolResult>();
	private idleTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(readonly id: string, config: SessionConfig, options: Options, private readonly onClosed: (session: ClaudeCodeSession) => void) {
		this.config = config;
		const server = createToolServer(config.tools, (toolUseId, name, args) => this.onToolCall(toolUseId, name, args));
		const { thinking, effort } = thinkingOptions(config.level);
		this.query = startQuery({
			prompt: this.input,
			options: {
				...options,
				model: config.modelId,
				systemPrompt: config.systemPrompt + TOOL_NAME_NOTE,
				thinking,
				...(effort ? { effort } : {}),
				mcpServers: { [MCP_SERVER_NAME]: { type: "sdk", name: MCP_SERVER_NAME, instance: server, timeout: TOOL_CALL_TIMEOUT_MS } },
				allowedTools: [`${MCP_TOOL_PREFIX}*`],
				permissionMode: "dontAsk",
				includePartialMessages: true,
			},
		});
		void this.pump();
	}

	private async pump(): Promise<void> {
		try {
			const q = await this.query;
			for await (const message of q) {
				this.events.push(message);
				this.eventWaiter?.();
			}
			this.close("Claude Code ended the session");
		} catch (err) {
			this.close(err instanceof Error ? err.message : String(err));
		}
	}

	private onToolCall(toolUseId: string | undefined, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
		void name; void args;
		if (this.closed) return Promise.resolve(cancelledCallResult(this.closeReason));
		if (!toolUseId) return Promise.resolve(cancelledCallResult("missing tool-use id"));
		const ready = this.ready.get(toolUseId);
		if (ready) {
			this.ready.delete(toolUseId);
			return Promise.resolve(ready);
		}
		return new Promise((resolve) => this.parked.set(toolUseId, resolve));
	}

	/** Hand the app's tool results to the calls Claude Code is waiting on. */
	deliver(results: readonly ToolResultMessage[]): void {
		for (const result of results) {
			const id = baseCallId(result.toolCallId);
			this.awaiting.delete(id);
			const value = toCallToolResult(result);
			const resolve = this.parked.get(id);
			if (resolve) {
				this.parked.delete(id);
				resolve(value);
			} else {
				this.ready.set(id, value);
			}
		}
	}

	/** Send a user message (starts a turn, or folds into the running one). */
	send(blocks: UserBlock[]): void {
		this.input.push({ type: "user", message: { role: "user", content: blocks }, parent_tool_use_id: null } as SDKUserMessage);
	}

	/** Next message from Claude Code; rejects when the session closes or the signal aborts. */
	async next(signal?: AbortSignal): Promise<SDKMessage> {
		while (true) {
			const message = this.events.shift();
			if (message) return message;
			if (this.closed) throw new Error(this.closeReason || "Claude Code session closed");
			if (signal?.aborted) throw new Error("aborted");
			await new Promise<void>((resolve) => {
				const onAbort = () => resolve();
				signal?.addEventListener("abort", onAbort, { once: true });
				this.eventWaiter = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
			});
			this.eventWaiter = undefined;
		}
	}

	/** Stop the current Claude turn (an app-side abort). */
	async interrupt(): Promise<void> {
		try { await (await this.query).interrupt(); } catch { /* the session is restarted on the next call anyway */ }
	}

	/** Mark the start / end of an app request (drives the idle timer). */
	begin(): void {
		this.busy = true;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}
	end(): void {
		this.busy = false;
		if (this.closed) return;
		this.idleTimer = setTimeout(() => this.close("idle"), IDLE_MS);
		this.idleTimer.unref?.();
	}

	close(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		this.closeReason = reason;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		for (const resolve of this.parked.values()) resolve(cancelledCallResult(reason));
		this.parked.clear();
		this.input.close();
		this.eventWaiter?.();
		void this.query.then((q) => q.close(), () => {});
		this.onClosed(this);
	}
}

interface Registry { sessions: Map<string, ClaudeCodeSession>; exitHook: boolean }
const registryKey = Symbol.for("lh.claude-code.sessions");

/** Process-wide registry (survives Next dev hot reloads, like the ChatGPT bridge). */
function registry(): Registry {
	const global = globalThis as typeof globalThis & { [registryKey]?: Registry };
	if (!global[registryKey]) {
		const state: Registry = { sessions: new Map(), exitHook: false };
		global[registryKey] = state;
	}
	const state = global[registryKey];
	if (!state.exitHook) {
		state.exitHook = true;
		process.once("exit", () => closeAllClaudeCodeSessions("app exit"));
	}
	return state;
}

export function getClaudeCodeSession(id: string): ClaudeCodeSession | undefined {
	const session = registry().sessions.get(id);
	return session && !session.closed ? session : undefined;
}

/** Start a new session for `id`, closing any previous one. */
export async function startClaudeCodeSession(id: string, config: SessionConfig): Promise<ClaudeCodeSession> {
	const state = registry();
	state.sessions.get(id)?.close("restarted");
	const options = baseOptions(await resolveClaudeBinary(), process.env);
	const session = new ClaudeCodeSession(id, config, options, (closed) => {
		if (state.sessions.get(id) === closed) state.sessions.delete(id);
	});
	state.sessions.set(id, session);
	return session;
}

/** End a session now (a finished subagent run). Safe to call for any id. */
export function endClaudeCodeSession(id: string): void {
	registry().sessions.get(id)?.close("run finished");
}

export function closeAllClaudeCodeSessions(reason: string): void {
	for (const session of [...registry().sessions.values()]) session.close(reason);
}

/** Test / status helper. */
export function liveClaudeCodeSessionCount(): number {
	return [...registry().sessions.values()].filter((s) => !s.closed).length;
}
