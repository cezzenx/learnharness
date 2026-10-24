"use client";

import { useState } from "react";
import type { ClaudeCodeStatus } from "@/src/core";
import { Button } from "@/components/ui/button";
import { useModelCatalog } from "@/components/model-picker";
import { notifySettingsSaved } from "@/components/settings-signal";

export const CLAUDE_CODE_NOTICE = "Runs your installed Claude Code, signed in with your own Claude account. LearnHarness never sees or stores your Claude credentials. Requests count toward your Claude plan's usage limits, and conversation context, learning material and tool results are sent to Anthropic.";

/** One line describing the current state. Pure; exported for tests. */
export function claudeCodeSummary(status: ClaudeCodeStatus | undefined): string {
	if (!status || !status.checked) return "Checking Claude Code…";
	if (status.available) return `Signed in${status.email ? ` as ${status.email}` : ""}${status.plan ? ` · ${status.plan}` : ""}`;
	return status.error ?? "Claude Code is not available.";
}

/** The Providers row for the Claude Code (subscription) provider. */
export function ClaudeCodeConnection({ setup = false }: { setup?: boolean }) {
	const { catalog } = useModelCatalog();
	const status = catalog?.claudeCode;
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = async () => {
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/models?refresh=claude-code");
			if (!response.ok) throw new Error(`status ${response.status}`);
			// Every catalog reader (pickers, setup) re-reads the fresh status.
			notifySettingsSaved("keys");
		} catch {
			setError("Could not check Claude Code. Try again.");
		} finally {
			setBusy(false);
		}
	};

	return <div className="flex flex-col gap-1.5" data-testid="claude-code-connection">
		<div className="flex flex-wrap items-center gap-3">
			<span className="font-ui text-xs text-foreground">Claude Code (subscription)</span>
			<span data-testid="claude-code-status" className={`min-w-0 flex-1 text-xs ${status?.available ? "text-muted-foreground" : "text-foreground/80"}`}>
				{claudeCodeSummary(status)}
			</span>
			<Button type="button" size="xs" variant="ghost" data-testid="claude-code-refresh" disabled={busy} onClick={() => void refresh()}>
				{busy ? "Checking…" : "Refresh"}
			</Button>
		</div>
		{status?.checked && !status.available && (
			<p className="text-xs leading-relaxed text-muted-foreground">
				Install Claude Code, run <code className="font-mono">claude</code> in a terminal and sign in with your Claude account, then press Refresh.
			</p>
		)}
		{!setup && <p className="text-xs leading-relaxed text-muted-foreground" data-testid="claude-code-notice">
			{CLAUDE_CODE_NOTICE}{" "}
			<a href="https://claude.ai/settings/usage" target="_blank" rel="noreferrer" className="underline underline-offset-2">Check usage</a>
		</p>}
		{error && <p role="alert" className="text-xs text-red-400">{error}</p>}
	</div>;
}
