import type { Api, Model } from "@earendil-works/pi-ai";
import type { AccountInfo, ModelInfo, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { baseOptions, resolveClaudeBinary, type QueryFactory } from "./session-manager.ts";
import { CLAUDE_CODE_PROVIDER } from "./stream.ts";
import type { ClaudeCodeStatus } from "../../core/contracts/claude-code.ts";

/**
 * Claude Code availability + the Claude plan model catalog
 * (docs/claude-code-provider.md). A short-lived Claude Code process is
 * started WITHOUT a prompt (no usage) to read the signed-in account and the
 * models it offers. Results are cached; the Providers Refresh forces a
 * re-check.
 */

const CACHE_MS = 5 * 60_000;

interface CatalogState {
	status: ClaudeCodeStatus;
	models: Model<Api>[];
	checkedAt: number;
	inflight?: Promise<void>;
}
const key = Symbol.for("lh.claude-code.catalog");
function state(): CatalogState {
	const global = globalThis as typeof globalThis & { [key]?: CatalogState };
	global[key] ??= { status: { checked: false, available: false, binary: null, email: null, plan: null, error: null }, models: [], checkedAt: 0 };
	return global[key];
}

let probeFactory: QueryFactory | undefined;
/** Test seam: replace the SDK query used for the status probe. */
export function setClaudeCodeProbeFactory(factory: QueryFactory | undefined): void { probeFactory = factory; }

export function claudeCodeStatus(): ClaudeCodeStatus { return state().status; }
export function claudeCodeConnected(): boolean { return state().status.available; }
export function claudeCodeModels(): Model<Api>[] { return state().models; }
export function claudeCodeModel(id: string): Model<Api> | undefined { return claudeCodeModels().find((m) => m.id === id); }

/** For engines: the catalog entry, or (before the first status check after a
 *  restart) the same model built from pi-ai's Anthropic catalog. Claude Code
 *  itself reports a model the plan cannot use when the request runs. */
export function claudeCodeEngineModel(id: string, known: readonly Model<Api>[]): Model<Api> | undefined {
	return claudeCodeModel(id) ?? planModels([{ value: id, displayName: "", description: "" }], known)[0];
}

/** Signed in with a Claude account (not an API key or another backend). */
export function signedIn(account: AccountInfo | undefined): boolean {
	if (!account) return false;
	if (account.apiProvider && account.apiProvider !== "firstParty") return false;
	if (account.apiKeySource && account.apiKeySource !== "none") return false;
	return Boolean(account.subscriptionType || account.email);
}

/** The account's models that pi-ai's Anthropic catalog knows, stamped as Claude plan models. */
export function planModels(offered: readonly ModelInfo[], known: readonly Model<Api>[]): Model<Api>[] {
	const out: Model<Api>[] = [];
	for (const entry of offered) {
		if (entry.value === "default") continue;
		const id = entry.resolvedModel ?? entry.value;
		const base = known.find((m) => m.id === id);
		if (!base || out.some((m) => m.id === id)) continue;
		out.push({ ...base, provider: CLAUDE_CODE_PROVIDER, name: entry.displayName || base.name, headers: undefined, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
	}
	return out;
}

async function probe(known: readonly Model<Api>[]): Promise<void> {
	const s = state();
	const binary = (await resolveClaudeBinary()) ?? null;
	let close = () => {};
	try {
		const idle: AsyncIterable<SDKUserMessage> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
		const params = { prompt: idle, options: baseOptions(binary ?? undefined, process.env) };
		const q = probeFactory ? probeFactory(params) : (await import("@anthropic-ai/claude-agent-sdk")).query(params);
		close = () => q.close();
		const init = await Promise.race([
			q.initializationResult(),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Claude Code did not respond in time")), 30_000).unref?.()),
		]);
		const ok = signedIn(init.account);
		s.status = {
			checked: true,
			available: ok,
			binary,
			email: init.account?.email ?? null,
			plan: init.account?.subscriptionType ?? null,
			error: ok ? null : "Claude Code is not signed in with a Claude account. Run `claude` in a terminal and sign in.",
		};
		s.models = ok ? planModels(init.models ?? [], known) : [];
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		s.status = {
			checked: true,
			available: false,
			binary,
			email: null,
			plan: null,
			error: /not found|ENOENT/i.test(message)
				? "Claude Code was not found. Install it from https://claude.com/claude-code and sign in."
				: `Claude Code could not be checked: ${message.slice(0, 200)}`,
		};
		s.models = [];
	} finally {
		close();
		s.checkedAt = Date.now();
	}
}

/** Re-check status and models (cached for 5 minutes unless forced). */
export async function refreshClaudeCodeModels(known: readonly Model<Api>[], force = false): Promise<void> {
	const s = state();
	// Tests are deterministic and offline: never start a real Claude Code process.
	if (process.env.NODE_ENV === "test" && !probeFactory) return;
	if (s.inflight) return s.inflight;
	if (!force && s.status.checked && Date.now() - s.checkedAt < CACHE_MS) return;
	s.inflight = probe(known).finally(() => { s.inflight = undefined; });
	return s.inflight;
}

/** Test seam. */
export function resetClaudeCodeCatalog(): void {
	const global = globalThis as typeof globalThis & { [key]?: CatalogState };
	delete global[key];
}
