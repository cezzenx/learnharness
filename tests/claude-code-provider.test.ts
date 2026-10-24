import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeContext, type Api, type AssistantMessage, type Message, type Model, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// Offline: a fake Claude Code stands in for the SDK's query(). The data dir
// points at a temp folder before any app module (config.ts) loads.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-claude-code-test-"));
process.env.LH_DATA_DIR = dataDir;

type Mod = typeof import("../src/agent/claude-code/session-manager.ts");
let sessions: Mod;
let streamMod: typeof import("../src/agent/claude-code/stream.ts");
let transcript: typeof import("../src/agent/claude-code/transcript.ts");
let catalog: typeof import("../src/agent/claude-code/catalog.ts");
let prices: typeof import("../src/core/prices.ts");

/** One scripted Claude API call: text and/or tool calls. */
interface Step { hang?: boolean; text?: string; thinking?: string; toolCalls?: { id: string; name: string; args: Record<string, unknown> }[]; error?: string; stop?: string }

/** A fake Claude Code process driven by a script of API calls. */
class FakeClaude {
	starts: Options[] = [];
	inputs: SDKUserMessage[][] = [];
	toolResults: { id: string; text: string; isError: boolean }[] = [];
	interrupts = 0;
	closes = 0;
	constructor(public script: Step[]) {}

	factory = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
		const fake = this;
		fake.starts.push(params.options);
		const received: SDKUserMessage[] = [];
		fake.inputs.push(received);
		const server = (params.options.mcpServers?.lh as { instance: McpServer }).instance;
		let closed = false;
		const iterator = params.prompt[Symbol.asyncIterator]();
		async function* run() {
			const [clientT, serverT] = InMemoryTransport.createLinkedPair();
			await server.connect(serverT);
			const client = new Client({ name: "fake-claude", version: "1" });
			await client.connect(clientT);
			const listed = await client.listTools();
			yield { type: "system", subtype: "init", tools: listed.tools.map((t) => `mcp__lh__${t.name}`) };
			let waitingForUser = true;
			while (!closed) {
				if (waitingForUser) {
					const next = await iterator.next();
					if (next.done || closed) return;
					received.push(next.value);
				}
				const step = fake.script.shift();
				if (!step) return;
				if (step.hang) {
					await new Promise<void>((resolve) => { const timer = setInterval(() => { if (closed) { clearInterval(timer); resolve(); } }, 5); });
					return;
				}
				if (step.error) { yield { type: "result", subtype: "error_during_execution", is_error: true, errors: [step.error] }; return; }
				yield* events(step);
				if (step.toolCalls?.length) {
					for (const call of step.toolCalls) {
						const result = await client.callTool({ name: call.name, arguments: call.args, _meta: { "claudecode/toolUseId": call.id } });
						const content = result.content as { type: string; text?: string }[];
						fake.toolResults.push({ id: call.id, text: content.map((c) => c.text ?? `[${c.type}]`).join(""), isError: result.isError === true });
					}
					waitingForUser = false;
				} else {
					yield { type: "result", subtype: "success", is_error: false, result: step.text ?? "" };
					waitingForUser = true;
				}
			}
		}
		const gen = run();
		return Object.assign(gen, {
			interrupt: async () => { fake.interrupts++; return undefined; },
			close: () => { closed = true; fake.closes++; },
		}) as never;
	};
}

function* events(step: Step) {
	const se = (event: unknown) => ({ type: "stream_event", parent_tool_use_id: null, event });
	yield se({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } } });
	let index = 0;
	if (step.thinking) {
		yield se({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
		yield se({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: step.thinking } });
		yield se({ type: "content_block_stop", index });
		index++;
	}
	if (step.text) {
		yield se({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
		yield se({ type: "content_block_delta", index, delta: { type: "text_delta", text: step.text } });
		yield se({ type: "content_block_stop", index });
		index++;
	}
	for (const call of step.toolCalls ?? []) {
		yield se({ type: "content_block_start", index, content_block: { type: "tool_use", id: call.id, name: `mcp__lh__${call.name}`, input: {} } });
		yield se({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) } });
		yield se({ type: "content_block_stop", index });
		index++;
	}
	yield se({ type: "message_delta", delta: { stop_reason: step.stop ?? (step.toolCalls?.length ? "tool_use" : "end_turn") }, usage: { output_tokens: 42 } });
	yield se({ type: "message_stop" });
}

const quizTool = { name: "quiz", description: "Ask the learner a question.", parameters: Type.Object({ question: Type.String() }) };
const model = { id: "claude-sonnet-5-5", name: "Sonnet", api: "anthropic-messages", provider: "claude-code", baseUrl: "", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 64000 } as unknown as Model<Api>;
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
const result = (id: string, text: string): ToolResultMessage => ({ role: "toolResult", toolCallId: id, toolName: "quiz", content: [{ type: "text", text }], isError: false, timestamp: 2 });

async function call(messages: Message[], opts: { sessionId?: string; reasoning?: string; signal?: AbortSignal; system?: string } = {}): Promise<AssistantMessage> {
	const ctx = normalizeContext({ systemPrompt: opts.system ?? "You are a teacher.", messages, tools: [quizTool] });
	const stream = streamMod.claudeCodeStream()(model, ctx, { sessionId: opts.sessionId ?? "chat-1", reasoning: (opts.reasoning ?? "low") as never, signal: opts.signal });
	return stream.result();
}

before(async () => {
	sessions = await import("../src/agent/claude-code/session-manager.ts");
	streamMod = await import("../src/agent/claude-code/stream.ts");
	transcript = await import("../src/agent/claude-code/transcript.ts");
	catalog = await import("../src/agent/claude-code/catalog.ts");
	prices = await import("../src/core/prices.ts");
	sessions.setClaudeBinaryOverride(undefined);
});
beforeEach(() => sessions.closeAllClaudeCodeSessions("test reset"));
after(() => {
	sessions.closeAllClaudeCodeSessions("test end");
	sessions.setQueryFactory(undefined);
	fs.rmSync(dataDir, { recursive: true, force: true });
});

test("environment drops API keys, other backends and app secrets, keeps the rest", () => {
	const env = sessions.claudeCodeEnv({ PATH: "/bin", HOME: "/home/x", ANTHROPIC_API_KEY: "sk-ant", ANTHROPIC_BASE_URL: "http://x", CLAUDE_CODE_USE_BEDROCK: "1", LH_DESKTOP_API_SECRET: "s", OPENAI_API_KEY: "sk-o", CLAUDECODE: "1", CLAUDE_CODE_OAUTH_TOKEN: "oauth" });
	assert.equal(env.PATH, "/bin");
	assert.equal(env.HOME, "/home/x");
	for (const gone of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "LH_DESKTOP_API_SECRET", "CLAUDECODE"]) assert.equal(env[gone], undefined, gone);
	assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "oauth", "a subscription token the user set stays");
	assert.equal(env.DISABLE_AUTO_COMPACT, "1");
	assert.equal(env.ENABLE_TOOL_SEARCH, "false");
	assert.match(env.CLAUDE_AGENT_SDK_CLIENT_APP ?? "", /^learnharness\//);
});

test("thinking levels map to Claude effort; off disables thinking; unsupported effort clamps", () => {
	assert.deepEqual(sessions.thinkingOptions("off"), { thinking: { type: "disabled" } });
	assert.equal(sessions.thinkingOptions("minimal").effort, "low");
	assert.equal(sessions.thinkingOptions("medium").effort, "medium");
	assert.equal(sessions.thinkingOptions("xhigh").effort, "xhigh");
	assert.equal(sessions.thinkingOptions("xhigh", ["low", "medium", "high", "max"]).effort, "high");
});

test("history diff: growth by tool results and user messages continues; anything else restarts", () => {
	const a: AssistantMessage = { role: "assistant", api: "x", provider: "claude-code", model: "m", content: [{ type: "text", text: "Q?" }, { type: "toolCall", id: "t1", name: "quiz", arguments: { question: "Q" } }], stopReason: "toolUse", timestamp: 3, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	const seen = [user("hi"), a].map(transcript.fingerprint);
	const awaiting = new Set(["t1"]);
	assert.equal(transcript.diffHistory(seen, [user("hi"), a, result("t1~2", "A")], awaiting).kind, "continue", "collision suffix is ignored");
	const both = transcript.diffHistory(seen, [user("hi"), a, result("t1", "A"), user("also this")], awaiting);
	assert.equal(both.kind, "continue");
	assert.equal(both.kind === "continue" && both.users.length, 1);
	assert.equal(transcript.diffHistory(seen, [user("hi"), a], awaiting).kind, "restart", "no growth");
	assert.equal(transcript.diffHistory(seen, [user("summary"), a, result("t1", "A")], awaiting).kind, "restart", "compaction rewrote the head");
	assert.equal(transcript.diffHistory(seen, [user("hi"), a, result("t9", "A")], awaiting).kind, "restart", "unknown call");
	assert.equal(transcript.diffHistory(seen, [user("hi"), a, user("skip")], awaiting).kind, "restart", "pending call left without a result");
});

test("replay: a fresh conversation goes through verbatim; a resumed one becomes a transcript with trailing images", () => {
	const fresh = transcript.replayBlocks([{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1 }]);
	assert.deepEqual(fresh.map((b) => b.type), ["text", "image"]);
	const a: AssistantMessage = { role: "assistant", api: "x", provider: "claude-code", model: "m", content: [{ type: "toolCall", id: "t1", name: "quiz", arguments: { question: "Q" } }], stopReason: "toolUse", timestamp: 3, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	const resumed = transcript.replayBlocks([user("hi"), a, { role: "toolResult", toolCallId: "t1", toolName: "quiz", content: [{ type: "text", text: "B" }, { type: "image", data: "BBBB", mimeType: "image/png" }], isError: false, timestamp: 4 }]);
	assert.equal(resumed[0]!.type, "text");
	const text = (resumed[0] as { text: string }).text;
	assert.match(text, /<conversation_so_far>/);
	assert.match(text, /<tool_call name="quiz" id="t1">/);
	assert.match(text, /latest tool results/);
	assert.deepEqual(resumed.slice(1).map((b) => b.type), ["image"]);
});

test("one live session carries a tool call, its result and the next turn; usage maps; cost is zero", async () => {
	const fake = new FakeClaude([
		{ thinking: "plan", text: "Let me check.", toolCalls: [{ id: "toolu_1", name: "quiz", args: { question: "2+2?" } }] },
		{ text: "Correct, it's 4." },
		{ text: "Next topic." },
	]);
	sessions.setQueryFactory(fake.factory);
	const history: Message[] = [user("teach me")];
	const first = await call(history);
	assert.equal(first.stopReason, "toolUse");
	assert.equal(first.provider, "claude-code");
	assert.deepEqual(first.content.map((c) => c.type), ["thinking", "text", "toolCall"]);
	const toolCall = first.content[2] as { name: string; id: string; arguments: unknown };
	assert.equal(toolCall.name, "quiz", "mcp prefix stripped");
	assert.deepEqual(toolCall.arguments, { question: "2+2?" });
	assert.deepEqual({ ...first.usage, cost: undefined }, { input: 10, output: 42, cacheRead: 100, cacheWrite: 5, totalTokens: 157, cost: undefined });
	assert.equal(first.usage.cost.total, 0);

	// The quiz answer arrives in a later request: same process, the parked tool call resolves.
	history.push(first, result("toolu_1", "4"));
	const second = await call(history);
	assert.equal(second.stopReason, "stop");
	assert.equal((second.content[0] as { text: string }).text, "Correct, it's 4.");
	assert.deepEqual(fake.toolResults, [{ id: "toolu_1", text: "4", isError: false }]);
	assert.equal(fake.starts.length, 1, "no restart");

	history.push(second, user("go on"));
	const third = await call(history);
	assert.equal((third.content[0] as { text: string }).text, "Next topic.");
	assert.equal(fake.starts.length, 1);
	assert.equal(fake.inputs[0]!.length, 2, "two user messages sent to the same process");

	const options = fake.starts[0]!;
	assert.deepEqual(options.tools, []);
	assert.deepEqual(options.settingSources, []);
	assert.equal(options.strictMcpConfig, true);
	assert.equal(options.persistSession, false);
	assert.equal(options.permissionMode, "dontAsk");
	assert.deepEqual(options.allowedTools, ["mcp__lh__*"]);
	assert.equal(options.model, "claude-sonnet-5-5");
	assert.equal(options.effort, "low");
	assert.match(String(options.systemPrompt), /^You are a teacher\.[\s\S]*mcp__lh__quiz/);
	assert.equal(options.env?.ANTHROPIC_API_KEY, undefined);
});

test("compaction (rewritten history) restarts the session and replays a transcript", async () => {
	const fake = new FakeClaude([{ text: "Hello." }, { text: "Resumed fine." }]);
	sessions.setQueryFactory(fake.factory);
	const first = await call([user("hi")]);
	const compacted: Message[] = [user("[summary] earlier we covered X"), first, user("continue")];
	const second = await call(compacted);
	assert.equal((second.content[0] as { text: string }).text, "Resumed fine.");
	assert.equal(fake.starts.length, 2);
	assert.equal(fake.closes, 1, "the old process is closed");
	const opening = fake.inputs[1]![0]!.message.content as { type: string; text: string }[];
	assert.match(opening[0]!.text, /conversation_so_far[\s\S]*earlier we covered X[\s\S]*Hello\./);
});

test("changing model settings restarts; a different conversation gets its own process", async () => {
	const fake = new FakeClaude([{ text: "a" }, { text: "b" }, { text: "c" }]);
	sessions.setQueryFactory(fake.factory);
	const first = await call([user("hi")]);
	await call([user("hi"), first, user("more")], { reasoning: "high" });
	assert.equal(fake.starts.length, 2);
	assert.equal(fake.starts[1]!.effort, "high");
	await call([user("other chat")], { sessionId: "chat-2" });
	assert.equal(fake.starts.length, 3);
	assert.equal(sessions.liveClaudeCodeSessionCount(), 2);
	sessions.endClaudeCodeSession("chat-2");
	assert.equal(sessions.liveClaudeCodeSessionCount(), 1);
});

test("a Claude error becomes a user-facing error message and closes the session", async () => {
	const fake = new FakeClaude([{ error: "Claude AI usage limit reached" }]);
	sessions.setQueryFactory(fake.factory);
	const failed = await call([user("hi")]);
	assert.equal(failed.stopReason, "error");
	assert.match(failed.errorMessage ?? "", /Claude plan usage limit reached/);
	assert.doesNotMatch(failed.errorMessage ?? "", /API key/i);
	assert.equal(sessions.liveClaudeCodeSessionCount(), 0);
});

test("abort during a reply interrupts Claude, reports aborted and closes the session", async () => {
	const fake = new FakeClaude([{ hang: true }]);
	sessions.setQueryFactory(fake.factory);
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 30);
	const aborted = await call([user("hi")], { signal: controller.signal });
	assert.equal(aborted.stopReason, "aborted");
	assert.equal(aborted.errorMessage, "Claude request cancelled.");
	assert.equal(fake.interrupts, 1);
	assert.equal(sessions.liveClaudeCodeSessionCount(), 0);
});

test("an abort before anything is sent keeps the live session (nothing changed)", async () => {
	const fake = new FakeClaude([{ toolCalls: [{ id: "toolu_5", name: "quiz", args: { question: "?" } }] }, { text: "ok" }]);
	sessions.setQueryFactory(fake.factory);
	const first = await call([user("hi")]);
	const controller = new AbortController();
	controller.abort();
	assert.equal((await call([user("hi"), first, result("toolu_5", "x")], { signal: controller.signal })).stopReason, "aborted");
	const retried = await call([user("hi"), first, result("toolu_5", "x")]);
	assert.equal((retried.content[0] as { text: string }).text, "ok");
	assert.equal(fake.starts.length, 1);
});

test("closing a session cancels a parked tool call (an open quiz) inside Claude Code", async () => {
	const fake = new FakeClaude([{ toolCalls: [{ id: "toolu_9", name: "quiz", args: { question: "?" } }] }]);
	sessions.setQueryFactory(fake.factory);
	assert.equal((await call([user("hi")])).stopReason, "toolUse");
	sessions.closeAllClaudeCodeSessions("idle");
	await new Promise((r) => setTimeout(r, 20));
	assert.deepEqual(fake.toolResults, [{ id: "toolu_9", text: "Tool call cancelled: idle", isError: true }]);
});

test("catalog: signed-in account → connected, offered models stamped as zero-cost Claude plan models", async () => {
	const known = [
		{ ...model, provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
		{ ...model, provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
	] as Model<Api>[];
	catalog.resetClaudeCodeCatalog();
	let closed = 0;
	catalog.setClaudeCodeProbeFactory(() => ({
		initializationResult: async () => ({
			account: { email: "learner@example.invalid", subscriptionType: "Claude Pro", apiProvider: "firstParty" },
			models: [
				{ value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default", description: "" },
				{ value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "" },
				{ value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "" },
				{ value: "claude-mystery-9", displayName: "Unknown", description: "" },
			],
		}),
		close: () => { closed++; },
	}) as never);
	await catalog.refreshClaudeCodeModels(known, true);
	assert.equal(catalog.claudeCodeConnected(), true);
	assert.equal(catalog.claudeCodeStatus().plan, "Claude Pro");
	assert.deepEqual(catalog.claudeCodeModels().map((m) => [m.provider, m.id, m.name, m.cost.input]), [["claude-code", "claude-sonnet-5-5", "Sonnet 5.5", 0], ["claude-code", "claude-opus-5-5", "Opus 5.5", 0]]);
	assert.equal(closed, 1, "the probe process is closed");
	assert.equal(catalog.claudeCodeEngineModel("claude-opus-5-5", known)?.provider, "claude-code");
	const { providerKeyPresent } = await import("../src/server/keys.ts");
	const { catalogProviders, modelCatalog } = await import("../src/server/model-catalog.ts");
	assert.equal(providerKeyPresent("claude-code"), true, "the turn gate opens");
	assert.deepEqual(catalogProviders().find((p) => p.id === "claude-code"), { id: "claude-code", envVar: "", keyPresent: true });
	const picker = modelCatalog();
	assert.ok(picker.models.some((m) => m.provider === "claude-code" && m.id === "claude-sonnet-5-5"));
	assert.equal(picker.claudeCode?.email, "learner@example.invalid");

	catalog.setClaudeCodeProbeFactory(() => ({ initializationResult: async () => ({ account: { apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" }, models: [] }), close: () => {} }) as never);
	await catalog.refreshClaudeCodeModels(known, true);
	assert.equal(catalog.claudeCodeConnected(), false, "an API-key login is not the subscription");
	assert.match(catalog.claudeCodeStatus().error ?? "", /sign in/);
	assert.equal(providerKeyPresent("claude-code"), false, "the turn gate closes");
	assert.equal(catalog.claudeCodeEngineModel("claude-opus-5-5", known)?.provider, "claude-code", "engines still resolve before the next check");
	catalog.setClaudeCodeProbeFactory(undefined);
	catalog.resetClaudeCodeCatalog();
});

test("Claude plan usage is labelled, never priced in dollars", () => {
	assert.equal(prices.planLabel("claude-code:claude-opus-5-5"), "Claude plan");
	assert.equal(prices.planLabel("chatgpt:gpt-5"), "ChatGPT plan");
	assert.equal(prices.planLabel("anthropic:claude-opus-5-5"), null);
	const pricing = prices.sessionCost({ turns: [{ id: "t", messageId: "m", at: "", model: "claude-code:claude-opus-5-5", steps: [{ inputTokens: 1, outputTokens: 1 }] }] } as never, () => 1);
	assert.deepEqual({ cost: pricing.cost, unpriced: pricing.unpriced, subscription: pricing.subscription, plans: pricing.plans }, { cost: 0, unpriced: 0, subscription: 1, plans: ["Claude plan"] });
	assert.equal(prices.joinPlanLabels(["Claude plan", "ChatGPT plan", "Claude plan"]), "ChatGPT plan + Claude plan");
});

test("Providers row summary", async () => {
	const { claudeCodeSummary } = await import("../components/settings/claude-code-connection.tsx");
	assert.equal(claudeCodeSummary(undefined), "Checking Claude Code…");
	assert.equal(claudeCodeSummary({ checked: true, available: true, binary: null, email: "a@b.c", plan: "Claude Pro", error: null }), "Signed in as a@b.c · Claude Pro");
	assert.match(claudeCodeSummary({ checked: true, available: false, binary: null, email: null, plan: null, error: "Claude Code was not found." }), /not found/);
});
