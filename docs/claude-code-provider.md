# Claude Code provider (Claude subscription)

The `claude-code` provider runs LearnHarness's model calls through your locally installed **Claude Code**, signed in with your own Claude account (Pro, Max, Team or Enterprise). No API key is involved. Usage counts toward your Claude plan's limits, and the cost meter shows **Claude plan** instead of dollars.

LearnHarness never sees or stores Claude credentials. Sign-in always happens in Claude Code itself, following [Anthropic's rules for Claude Code authentication](https://code.claude.com/docs/en/legal-and-compliance).

## Setup

1. Install Claude Code from <https://claude.com/claude-code>.
2. Run `claude` in a terminal and sign in with your Claude account.
3. In LearnHarness, open **Settings → Providers → Subscriptions**. The **Claude Code (subscription)** row should say *Signed in as …*. If it doesn't, press **Refresh**.
4. Pick Claude models (listed with **Claude plan**) for your model slots.

## How it works

Code lives in `src/agent/claude-code/`.

- **Transport (`session-manager.ts`).** Each app conversation gets one live Claude Code process, run by the Anthropic Agent SDK (`@anthropic-ai/claude-agent-sdk`) in streaming-input mode. A teaching chat uses its chat id. Each background run gets its own process, which closes when the run ends. The installed `claude` on PATH is used first; the SDK's bundled copy is the fallback.
- **Isolation.** The Claude Code process uses only LearnHarness's tools:
  - no built-in tools (`tools: []`)
  - none of your settings, CLAUDE.md, hooks, plugins or MCP servers (`settingSources: []`, `strictMcpConfig`)
  - no saved sessions (`persistSession: false`)
  - an empty private working folder (`<data>/claude-code-cwd`)
  - its own compaction disabled (`DISABLE_AUTO_COMPACT=1`)

  Every `ANTHROPIC_*` variable and the app's secrets are removed from its environment, so it can't silently bill an API key.
- **Tools (`mcp-tools.ts`).** The app's tools are served to Claude as `mcp__lh__<name>` through an in-process MCP server, with their exact JSON Schemas. The server never runs a tool. It parks the call, the app's agent loop runs the tool as usual, and the next model call delivers the result. Claude's tool-use id is used to match the two.
- **Per-call flow (`stream.ts`, `transcript.ts`).** The app's agent loop is stateless and sends the full history on every call. The provider compares that history with what the live session has seen:
  - **History grew only by tool results and/or user messages:** the session continues. Quiz answers that arrive minutes later work this way, because the quiz's tool call stays parked inside Claude Code.
  - **Anything else:** the session restarts and the history is replayed as a transcript. That covers app compaction, a changed system prompt, tool set, model or thinking level, an app restart, and a session closed after **30 idle minutes**.
- **Events.** Claude's streaming events become pi events. Usage tokens are reported normally, so the context meter and compaction work. Cost is always 0.
- **Thinking.** Levels map to Claude Code `effort`: minimal and low → low, then medium, high, xhigh. `off` disables thinking.
- **Catalog (`catalog.ts`).** A short Claude Code start with **no prompt** (so no usage) reads the signed-in account and the models it offers. Those models that pi-ai's Anthropic catalog knows are listed under the `claude-code` provider. The result is cached for 5 minutes; **Refresh** re-checks now.

## Limits

- **Replays are less natural.** After a restart, Claude sees past tool calls as text rather than real tool calls.
- **Plan limits apply.** Background helpers (researcher, extraction, demos, compaction) count toward the same limits when their slots use Claude. Pick cheaper or API models for those slots if you hit limits.
- **Proprietary dependency.** The Agent SDK is Anthropic software under Anthropic's terms, not an open-source license.
