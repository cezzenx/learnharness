import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, Model, SimpleStreamOptions, StopReason, StreamFunction, TextContent, ThinkingContent, ToolCall, Usage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { stripToolPrefix } from "./mcp-tools.ts";
import { endClaudeCodeSession, getClaudeCodeSession, startClaudeCodeSession, type ClaudeCodeSession } from "./session-manager.ts";
import { conversation, diffHistory, fingerprint, replayBlocks, sessionConfig, userBlocks } from "./transcript.ts";

/**
 * The Claude Code provider's StreamFunction (docs/claude-code-provider.md).
 * One call = one Claude API call inside a live Claude Code session:
 * continue the session when the history only grew by tool results / user
 * messages, otherwise restart it with a replay; then translate Claude's
 * streaming events into pi events until that API call's message ends.
 */

export const CLAUDE_CODE_PROVIDER = "claude-code";

const USAGE_URL = "https://claude.ai/settings/usage";

/** User-facing error text. Never suggests that an API key was used. */
export function claudeCodeStreamError(message: string): string {
	if (/usage limit|rate.?limit|429|limit reached|out of extra usage/i.test(message)) return `Claude plan usage limit reached. Check usage at ${USAGE_URL}, or pick another model for this slot.`;
	if (/log ?in|logged out|not authenticated|401|oauth|invalid api key|authentication/i.test(message)) return "Claude Code is not signed in. Run `claude` in a terminal, sign in with your Claude account, then refresh Providers.";
	if (/not found|ENOENT|executable/i.test(message)) return "Claude Code could not be started. Install it (https://claude.com/claude-code) or check that `claude` runs in a terminal.";
	if (/model/i.test(message) && /not (available|supported)|invalid|unknown/i.test(message)) return "This Claude model is not available on your plan. Refresh Providers and choose another Claude model.";
	if (/abort|cancel|interrupt/i.test(message)) return "Claude request cancelled.";
	if (/overloaded|529|5\d\d/i.test(message)) return "Claude is overloaded right now. Retry in a moment.";
	return `Claude Code request failed: ${message.slice(0, 300)}`;
}

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function emptyMessage(model: Model<Api>): AssistantMessage {
	return { role: "assistant", api: model.api, provider: CLAUDE_CODE_PROVIDER, model: model.id, content: [], stopReason: "stop", timestamp: Date.now(), usage: emptyUsage() };
}

interface RawUsage { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null; output_tokens_details?: { thinking_tokens?: number | null } | null }

/** Anthropic streaming events → pi events, building one AssistantMessage. */
export class EventTranslator {
	started = false;
	finished = false;
	private rawStop: string | null = null;
	/** Anthropic content-block index → index in partial.content (-1 = ignored block). */
	private readonly blocks = new Map<number, number>();
	private readonly json = new Map<number, string>();

	constructor(readonly partial: AssistantMessage, private readonly output: AssistantMessageEventStream) {}

	private usage(raw: RawUsage | undefined): void {
		if (!raw) return;
		const u = this.partial.usage;
		if (raw.input_tokens != null) u.input = raw.input_tokens;
		if (raw.output_tokens != null) u.output = raw.output_tokens;
		if (raw.cache_read_input_tokens != null) u.cacheRead = raw.cache_read_input_tokens;
		if (raw.cache_creation_input_tokens != null) u.cacheWrite = raw.cache_creation_input_tokens;
		if (raw.output_tokens_details?.thinking_tokens != null) u.reasoning = raw.output_tokens_details.thinking_tokens;
		u.totalTokens = u.input + u.output + u.cacheRead + u.cacheWrite;
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.output.push({ type: "start", partial: this.partial });
	}

	/** One Anthropic streaming event (the union is wide; only the fields used here are read). */
	handle(event: any): void {
		const content = this.partial.content;
		switch (event.type) {
			case "message_start":
				this.start();
				this.usage(event.message?.usage);
				break;
			case "content_block_start": {
				this.start();
				const block = event.content_block;
				let index = -1;
				if (block.type === "text") {
					index = content.push({ type: "text", text: "" } satisfies TextContent) - 1;
					this.output.push({ type: "text_start", contentIndex: index, partial: this.partial });
				} else if (block.type === "thinking" || block.type === "redacted_thinking") {
					const part: ThinkingContent = { type: "thinking", thinking: block.thinking ?? "", ...(block.type === "redacted_thinking" ? { redacted: true, thinkingSignature: block.data } : {}) };
					index = content.push(part) - 1;
					this.output.push({ type: "thinking_start", contentIndex: index, partial: this.partial });
				} else if (block.type === "tool_use") {
					index = content.push({ type: "toolCall", id: block.id, name: stripToolPrefix(block.name), arguments: {} } satisfies ToolCall) - 1;
					this.json.set(index, "");
					this.output.push({ type: "toolcall_start", contentIndex: index, partial: this.partial });
				}
				this.blocks.set(event.index, index);
				break;
			}
			case "content_block_delta": {
				const index = this.blocks.get(event.index) ?? -1;
				const part = content[index];
				if (index < 0 || !part) break;
				const delta = event.delta;
				if (delta.type === "text_delta" && part.type === "text") {
					part.text += delta.text;
					this.output.push({ type: "text_delta", contentIndex: index, delta: delta.text, partial: this.partial });
				} else if (delta.type === "thinking_delta" && part.type === "thinking") {
					part.thinking += delta.thinking;
					this.output.push({ type: "thinking_delta", contentIndex: index, delta: delta.thinking, partial: this.partial });
				} else if (delta.type === "signature_delta" && part.type === "thinking") {
					part.thinkingSignature = (part.thinkingSignature ?? "") + delta.signature;
				} else if (delta.type === "input_json_delta" && part.type === "toolCall") {
					this.json.set(index, (this.json.get(index) ?? "") + delta.partial_json);
					this.output.push({ type: "toolcall_delta", contentIndex: index, delta: delta.partial_json, partial: this.partial });
				}
				break;
			}
			case "content_block_stop": {
				const index = this.blocks.get(event.index) ?? -1;
				const part = content[index];
				if (index < 0 || !part) break;
				if (part.type === "text") this.output.push({ type: "text_end", contentIndex: index, content: part.text, partial: this.partial });
				else if (part.type === "thinking") this.output.push({ type: "thinking_end", contentIndex: index, content: part.thinking, partial: this.partial });
				else if (part.type === "toolCall") {
					const raw = this.json.get(index) ?? "";
					try { part.arguments = raw.trim() ? JSON.parse(raw) : {}; } catch { part.argumentsError = `invalid JSON arguments: ${raw.slice(0, 200)}`; }
					this.output.push({ type: "toolcall_end", contentIndex: index, toolCall: part, partial: this.partial });
				}
				break;
			}
			case "message_delta":
				if (event.delta?.stop_reason) this.rawStop = event.delta.stop_reason;
				this.usage(event.usage);
				break;
			case "message_stop":
				this.finished = true;
				break;
		}
	}

	/** Final stop reason (pi scale). Throws for refusals. */
	stopReason(): StopReason {
		const calls = this.partial.content.some((c) => c.type === "toolCall");
		switch (this.rawStop) {
			case "tool_use": return calls ? "toolUse" : "stop";
			case "max_tokens":
			case "model_context_window_exceeded": return "length";
			case "refusal": throw new Error("Claude declined to respond to this request.");
			default: return calls ? "toolUse" : "stop";
		}
	}
}

function resultError(message: SDKMessage): string | undefined {
	if (message.type !== "result" || !message.is_error) return undefined;
	const m = message as { errors?: string[]; result?: string; subtype: string };
	return m.errors?.join("; ") || m.result || m.subtype;
}

export function claudeCodeStream(): StreamFunction<Api, SimpleStreamOptions> {
	return (model, context, options) => {
		const output = new AssistantMessageEventStream();
		void (async () => {
			const partial = emptyMessage(model);
			const sessionId = options?.sessionId ?? `ephemeral-${randomUUID()}`;
			const signal = options?.signal;
			let session: ClaudeCodeSession | undefined;
			try {
				if (model.provider !== CLAUDE_CODE_PROVIDER) throw new Error("Claude Code model is not in the Claude plan catalog");
				const level = options?.reasoning ?? "off";
				const config = sessionConfig(context.messages, model.id, level);
				const conv = conversation(context.messages);
				const live = getClaudeCodeSession(sessionId);
				if (live?.busy) throw new Error("this conversation already has a Claude request running");
				const delta = live && live.config.key === config.key
					? diffHistory(live.seen, conv, live.awaiting)
					: { kind: "restart" as const, reason: live ? "settings changed" : "no live session" };
				if (signal?.aborted) throw new Error("aborted");

				if (delta.kind === "continue" && live) {
					session = live;
					session.begin();
					session.deliver(delta.results);
					for (const user of delta.users) session.send(userBlocks(user));
				} else {
					if (live || conv.some((m) => m.role === "assistant")) console.info(`[claude-code ${sessionId}] new session with replay (${delta.kind === "restart" ? delta.reason : "no live session"})`);
					session = await startClaudeCodeSession(sessionId, config);
					session.begin();
					session.send(replayBlocks(conv));
				}

				const translator = new EventTranslator(partial, output);
				while (!translator.finished) {
					const message = await session.next(signal);
					if (message.type === "stream_event") {
						if (message.parent_tool_use_id === null) translator.handle(message.event);
					} else if (message.type === "assistant" && message.error && message.parent_tool_use_id === null) {
						const text = message.message.content.map((c) => (c.type === "text" ? c.text : "")).join(" ").trim();
						throw new Error(`${message.error}${text ? `: ${text}` : ""}`);
					} else if (message.type === "result") {
						const failure = resultError(message);
						if (failure) throw new Error(failure);
						// A success result before this call's message started is the
						// previous turn's tail; one after it means the turn ended early.
						if (translator.started) break;
					}
				}
				partial.stopReason = translator.stopReason();
				translator.start();
				session.seen = [...conv.map(fingerprint), fingerprint(partial)];
				session.awaiting.clear();
				for (const part of partial.content) if (part.type === "toolCall") session.awaiting.add(part.id);
				output.push({ type: "done", reason: partial.stopReason as "stop" | "length" | "toolUse", message: partial });
			} catch (err) {
				const aborted = signal?.aborted === true;
				if (session && !session.closed) {
					if (aborted) await session.interrupt();
					// The session's state is unknown after a failure: start clean next time.
					session.close(aborted ? "aborted" : "request failed");
				}
				partial.stopReason = aborted ? "aborted" : "error";
				partial.errorMessage = claudeCodeStreamError(aborted ? "aborted" : err instanceof Error ? err.message : String(err));
				output.push({ type: "error", reason: partial.stopReason, error: partial });
			} finally {
				session?.end();
				if (sessionId.startsWith("ephemeral-")) endClaudeCodeSession(sessionId);
				output.end();
			}
		})();
		return output;
	};
}
