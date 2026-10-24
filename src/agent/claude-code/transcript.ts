import type { Message, Tool, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools, toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";

/**
 * History bookkeeping for the Claude Code provider (docs/claude-code-provider.md).
 *
 * The app's agent loop is stateless: every model call hands over the FULL
 * history. A live Claude Code session is stateful. This module decides,
 * per call, whether the incoming history is just the session's history
 * plus new tool results / user messages (continue the live session) or
 * anything else (restart the session and replay the history as text).
 */

/** Everything that, when changed, forces a new Claude Code process. */
export interface SessionConfig {
	modelId: string;
	level: string;
	systemPrompt: string;
	tools: Tool[];
	/** Stable fingerprint of all of the above. */
	key: string;
}

export function sessionConfig(messages: readonly Message[], modelId: string, level: string): SessionConfig {
	const systemPrompt = getCurrentSystemPrompt(messages);
	const tools = getCurrentTools(messages).map((t) => toToolDeclaration(t));
	const key = JSON.stringify([modelId, level, systemPrompt, tools]);
	return { modelId, level, systemPrompt, tools, key };
}

/** The conversation without system messages (those live in SessionConfig). */
export function conversation(messages: readonly Message[]): Message[] {
	return messages.filter((m) => m.role !== "system");
}

/** Strip the wire-boundary collision suffix ui-stream may add (`~2`). */
export function baseCallId(id: string): string {
	return id.replace(/~\d+$/, "");
}

function contentFingerprint(content: UserMessage["content"] | ToolResultMessage["content"]): unknown {
	if (typeof content === "string") return [["text", content]];
	return content.map((part) => part.type === "text" ? ["text", part.text] : ["image", part.mimeType, part.data.length, part.data.slice(0, 64)]);
}

/** A comparison key that survives the app's record round-trip (ids, timestamps,
 *  durations and thinking signatures are not part of it). */
export function fingerprint(message: Message): string {
	switch (message.role) {
		case "user":
			return JSON.stringify(["user", contentFingerprint(message.content)]);
		case "assistant":
			return JSON.stringify(["assistant", message.content.flatMap((part) =>
				part.type === "text" ? [["text", part.text]]
					: part.type === "toolCall" ? [["call", baseCallId(part.id), part.name, part.arguments]]
						: [])]);
		case "toolResult":
			return JSON.stringify(["result", baseCallId(message.toolCallId), message.isError, contentFingerprint(message.content)]);
		default:
			return JSON.stringify([message.role]);
	}
}

export type HistoryDelta =
	| { kind: "continue"; results: ToolResultMessage[]; users: UserMessage[] }
	| { kind: "restart"; reason: string };

/**
 * Compare what the live session has seen with the incoming conversation.
 * Continue only when the incoming history is the seen history plus tool
 * results for calls the session is waiting on, plus user messages.
 */
export function diffHistory(seen: readonly string[], incoming: readonly Message[], awaiting: ReadonlySet<string>): HistoryDelta {
	if (incoming.length <= seen.length) return { kind: "restart", reason: "history did not grow" };
	for (let i = 0; i < seen.length; i++) {
		if (fingerprint(incoming[i]!) !== seen[i]) return { kind: "restart", reason: `history changed at message ${i}` };
	}
	const results: ToolResultMessage[] = [];
	const users: UserMessage[] = [];
	for (const message of incoming.slice(seen.length)) {
		if (message.role === "toolResult") {
			if (users.length) return { kind: "restart", reason: "tool result after a new user message" };
			if (!awaiting.has(baseCallId(message.toolCallId))) return { kind: "restart", reason: "tool result for an unknown call" };
			results.push(message);
		} else if (message.role === "user") {
			users.push(message);
		} else {
			return { kind: "restart", reason: `unexpected ${message.role} message` };
		}
	}
	if (results.length !== awaiting.size) return { kind: "restart", reason: "not every pending tool call got a result" };
	return { kind: "continue", results, users };
}

// ---------------------------------------------------------------------------
// Replay rendering
// ---------------------------------------------------------------------------

/** An Anthropic Messages API user content block (the SDK's MessageParam shape). */
export type UserBlock =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: string; data: string } };

function imageBlock(data: string, mimeType: string): UserBlock {
	return { type: "image", source: { type: "base64", media_type: mimeType, data } };
}

/** A user message's content as SDK content blocks (images kept). */
export function userBlocks(message: UserMessage): UserBlock[] {
	if (typeof message.content === "string") return [{ type: "text", text: message.content }];
	return message.content.map((part) => part.type === "text" ? { type: "text" as const, text: part.text } : imageBlock(part.data, part.mimeType));
}

function plainText(content: UserMessage["content"] | ToolResultMessage["content"]): string {
	if (typeof content === "string") return content;
	return content.map((part) => part.type === "text" ? part.text : "[image]").join("\n");
}

function renderMessage(message: Message): string {
	switch (message.role) {
		case "user":
			return `<user>\n${plainText(message.content)}\n</user>`;
		case "assistant": {
			const parts = message.content.flatMap((part) =>
				part.type === "text" ? [part.text]
					: part.type === "toolCall" ? [`<tool_call name="${part.name}" id="${baseCallId(part.id)}">\n${JSON.stringify(part.arguments)}\n</tool_call>`]
						: []);
			return `<assistant>\n${parts.join("\n")}\n</assistant>`;
		}
		case "toolResult":
			return `<tool_result name="${message.toolName}" id="${baseCallId(message.toolCallId)}"${message.isError ? " error=\"true\"" : ""}>\n${plainText(message.content)}\n</tool_result>`;
		default:
			return "";
	}
}

/** Images in the trailing run of user / tool-result messages travel as real image blocks. */
function trailingImages(messages: readonly Message[]): UserBlock[] {
	const images: UserBlock[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!m || (m.role !== "user" && m.role !== "toolResult")) break;
		if (typeof m.content === "string") continue;
		for (const part of m.content) if (part.type === "image") images.unshift(imageBlock(part.data, part.mimeType));
	}
	return images;
}

/**
 * The opening message of a (re)started session.
 * - No assistant turns yet (new chat, every subagent run): the user
 *   messages go through as they are.
 * - Otherwise the history is written out as a transcript and Claude is
 *   asked to continue it. Tool calls in the transcript are past calls;
 *   new calls go through the real tools.
 */
export function replayBlocks(messages: readonly Message[]): UserBlock[] {
	if (!messages.some((m) => m.role === "assistant" || m.role === "toolResult")) {
		return messages.flatMap((m) => m.role === "user" ? userBlocks(m) : []);
	}
	const transcript = messages.map(renderMessage).filter(Boolean).join("\n\n");
	const last = messages[messages.length - 1];
	const ask = last?.role === "toolResult"
		? "Continue as the assistant from the latest tool results above."
		: "Continue as the assistant by responding to the latest user message above.";
	return [
		{
			type: "text",
			text: [
				"This conversation is being resumed in a fresh session. Here is everything so far:",
				"<conversation_so_far>",
				transcript,
				"</conversation_so_far>",
				`${ask} The tool calls above already happened; to call a tool now, use your tools as usual. Do not mention that the conversation was resumed.`,
			].join("\n"),
		},
		...trailingImages(messages),
	];
}
