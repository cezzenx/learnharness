/** Client-safe accounting folds. Rates and calculation live on the server,
 * using Pi's catalog and calculateCost; no copied pricing table lives here. */
import type { CallUsage, ChatRecord, JobRecord, TurnUsage } from "./contracts.ts";

export type CallPricer = (usage: Partial<CallUsage>, model: string) => number | null;
export interface SessionPricing {
	cost: number;
	unpriced: number;
	subscription?: number;
	/** The plan labels behind `subscription` turns, e.g. ["Claude plan"]. */
	plans?: string[];
	/** Derived at read time, keyed by the persisted turn's id. Never stored. */
	turnCosts: Record<string, number | null>;
}

export function isChatGPTPlan(model: string | undefined): boolean {
	return model?.startsWith("chatgpt:") === true;
}

/** The subscription plan a usage stamp ("provider:id") runs on, or null
 *  for API-key usage. Subscription usage is never priced in dollars. */
export function planLabel(model: string | undefined): string | null {
	if (model?.startsWith("chatgpt:")) return "ChatGPT plan";
	if (model?.startsWith("claude-code:")) return "Claude plan";
	return null;
}

export function isSubscriptionPlan(model: string | undefined): boolean {
	return planLabel(model) !== null;
}

/** "ChatGPT plan", or "ChatGPT plan + Claude plan" when both ran. */
export function joinPlanLabels(labels: Iterable<string>): string {
	return [...new Set(labels)].sort().join(" + ");
}

/** Where to check a plan's usage limits. */
export function planUsageLink(label: string): { href: string; text: string } | null {
	if (label === "ChatGPT plan") return { href: "https://chatgpt.com/settings/usage", text: "Manage ChatGPT usage" };
	if (label === "Claude plan") return { href: "https://claude.ai/settings/usage", text: "Check Claude usage" };
	return null;
}

/** Absent stays absent. Long-cache precision is unknown if any write-bearing
 * step lacks the split; never silently turn that missing detail into zero. */
export function sumSteps(steps: readonly CallUsage[]): CallUsage {
	const sumIfAny = (vals: (number | undefined)[]): number | undefined =>
		vals.every((v) => v === undefined) ? undefined : vals.reduce<number>((a, v) => a + (v ?? 0), 0);
	return {
		inputTokens: sumIfAny(steps.map((s) => s.inputTokens)),
		outputTokens: sumIfAny(steps.map((s) => s.outputTokens)),
		cacheReadTokens: sumIfAny(steps.map((s) => s.cacheReadTokens)),
		cacheWriteTokens: sumIfAny(steps.map((s) => s.cacheWriteTokens)),
		cacheWrite1hTokens: steps.some((s) => (s.cacheWriteTokens ?? 0) > 0 && s.cacheWrite1hTokens === undefined)
			? undefined : sumIfAny(steps.map((s) => s.cacheWrite1hTokens)),
		reasoningTokens: sumIfAny(steps.map((s) => s.reasoningTokens)),
	};
}

export function turnCost(turn: Pick<TurnUsage, "model" | "steps">, price: CallPricer): number | null {
	if (isSubscriptionPlan(turn.model) || turn.steps.length === 0) return null;
	let total = 0;
	for (const step of turn.steps) {
		const cost = price(step, turn.model);
		if (cost === null) return null;
		total += cost;
	}
	return total;
}

export function sessionCost(record: Pick<ChatRecord, "turns">, price: CallPricer): SessionPricing {
	let cost = 0;
	let unpriced = 0;
	let subscription = 0;
	const plans = new Set<string>();
	const turnCosts: Record<string, number | null> = {};
	for (const turn of record.turns ?? []) {
		const dollars = turnCost(turn, price);
		turnCosts[turn.id] = dollars;
		const plan = planLabel(turn.model);
		if (plan) { subscription++; plans.add(plan); }
		else if (dollars === null) unpriced++;
		else cost += dollars;
	}
	return { cost, unpriced, ...(subscription ? { subscription, plans: [...plans].sort() } : {}), turnCosts };
}

export function jobCost(job: Pick<JobRecord, "usage">, price: CallPricer): number | null {
	const usage = job.usage;
	if (!usage || isSubscriptionPlan(usage.model)) return null;
	if (usage.calls && usage.calls.length === usage.steps) {
		return turnCost({ model: usage.model, steps: usage.calls }, price);
	}
	// An old one-call job is fully reconstructible from its total. For a
	// multi-call job, the server resolver decides whether aggregate pricing
	// is safe for this model (tiered models need the lost per-call sizes).
	return price(usage, usage.model);
}
