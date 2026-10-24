/** Client-safe Claude Code provider status (docs/claude-code-provider.md). No credentials ever enter it. */
export interface ClaudeCodeStatus {
	/** False until the first check has run. */
	checked: boolean;
	/** Claude Code was found and is signed in with a Claude account. */
	available: boolean;
	/** The installed `claude` used, or null when the SDK's bundled copy is used. */
	binary: string | null;
	email: string | null;
	/** e.g. "Claude Pro". */
	plan: string | null;
	error: string | null;
}
