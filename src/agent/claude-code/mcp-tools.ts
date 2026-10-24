import type { Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * The app's tools, served to Claude Code through an in-process MCP server
 * (docs/claude-code-provider.md). Claude sees them as `mcp__lh__<name>`.
 *
 * The server never runs a tool. A call is handed to `onCall`, which parks
 * it until the app's own agent loop has executed the tool and the next
 * model call brings the result back (session-manager.ts).
 */

export const MCP_SERVER_NAME = "lh";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** `mcp__lh__quiz` → `quiz`; names without the prefix pass through. */
export function stripToolPrefix(name: string): string {
	return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}

export type ToolCallHandler = (toolUseId: string | undefined, name: string, args: Record<string, unknown>) => Promise<CallToolResult>;

export function createToolServer(tools: readonly Tool[], onCall: ToolCallHandler): McpServer {
	const mcp = new McpServer({ name: MCP_SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });
	// Low-level handlers so the tools keep their exact JSON Schemas (TypeBox
	// output) instead of going through the SDK's Zod-only tool() helper.
	mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.parameters as unknown as { type: "object"; [key: string]: unknown },
		})),
	}));
	mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const meta = request.params._meta as Record<string, unknown> | undefined;
		const toolUseId = typeof meta?.["claudecode/toolUseId"] === "string" ? meta["claudecode/toolUseId"] : undefined;
		return onCall(toolUseId, request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>);
	});
	return mcp;
}

/** The app's tool result, as an MCP tool result. */
export function toCallToolResult(result: ToolResultMessage): CallToolResult {
	const content: CallToolResult["content"] = result.content.map((part) =>
		part.type === "text"
			? { type: "text" as const, text: part.text }
			: { type: "image" as const, data: part.data, mimeType: part.mimeType });
	if (content.length === 0) content.push({ type: "text", text: "(no output)" });
	return { content, isError: result.isError };
}

/** What a parked call gets when the session goes away before the app answers it. */
export function cancelledCallResult(reason: string): CallToolResult {
	return { content: [{ type: "text", text: `Tool call cancelled: ${reason}` }], isError: true };
}
