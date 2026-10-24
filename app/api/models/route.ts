import { modelCatalog, refreshConnectionCatalog } from "@/src/server";

/**
 * The model picker's data (model-control wave): pi-ai's configured-provider
 * catalog as client-safe DTOs — id/name/cost/context/modality plus each
 * model's SUPPORTED thinking levels (per its thinkingLevelMap). Static
 * catalog: no network, stable within a pi-ai version.
 */
export async function GET(request?: Request) {
	// ?refresh=claude-code: the Providers Refresh button re-checks Claude Code now.
	const refresh = request ? new URL(request.url).searchParams.get("refresh") : null;
	await refreshConnectionCatalog({ forceClaudeCode: refresh === "claude-code" });
	return Response.json(modelCatalog(), { headers: { "Cache-Control": "no-store" } });
}
