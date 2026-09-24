/**
 * Extension: Auto-discover models from llama.cpp router server.
 * 
 * Replaces the "models" array in models.json. The user only needs to specify
 * baseUrl and api at the provider level - the extension probes /props to
 * confirm router mode, then queries /models for the list with runtime
 * config, and registers them.
 * 
 * Minimal models.json:
{
	"providers": {
		"${PROVIDER}": { <--- key
		"baseUrl": "http://127.0.0.1:8080",
		"api": "openai-completions",
		"apiKey": "local",
		"models": [
			{
			"id": "${MODEL_ID}" <--- key
			}
		]
		}
	}
	}
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import type {
	ExtensionContext,
	ExtensionAPI,
	ProviderConfig,
	ProviderModelConfig
} from "@mariozechner/pi-coding-agent";
import fs from "node:fs";

const LOG_FILE = "/tmp/llama-cpp-auto.log";
const DEBUG = process.env.LLAMA_CPP_EXTENSION_DEBUG === "1";
function log(...args: any[]) {
	if (!DEBUG) return;
	fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [llama-cpp-auto] ${args.join(" ")}\n`);
}

function notify(message: string, ctx: ExtensionContext) {
	ctx.ui.notify(`[llama-cpp auto-discover] ${message}`, "warning")
}

const PROVIDER = "llama-cpp"
const MODEL_ID = "llama-cpp-discover"

interface modelStatus {
	args: string[];
}

interface modelData {
	id: string;
	status: modelStatus;
}

interface llamaCppModels {
	data: modelData[];
}

function parseArgsToMap(args: string[]): Record<string, string> {
	const map: Record<string, string> = {};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg.startsWith("--")) {
			const key = arg.replace(/^--/, "");
			const nextValue = args[i + 1];

			if (nextValue !== undefined && !nextValue.startsWith("--")) {
				map[key] = nextValue;
				i++; // consumed the value
			} else {
				// boolean flag — no value
				map[key] = "true";
			}
		}
	}

	return map;
}

function formatModelName(id: string): string {
	return id.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function transformLlamaCppModels(input: llamaCppModels): ProviderModelConfig[] {
	return input.data.map((model) => {
		const args = parseArgsToMap(model.status.args);

		return {
			id: model.id,
			name: formatModelName(model.id),
			contextWindow: args["ctx-size"] ? parseInt(args["ctx-size"], 10) : 0,
			maxTokens: (args["n_predict"] || args["ctx-size"])
				? parseInt(args["n_predict"] || args["ctx-size"], 10)
				: 0,

			// Hardcoded: crashes without it ("Cannot read 'includes'") —
			// https://github.com/badlogic/pi-mono/issues/1167, https://github.com/badlogic/pi-mono/issues/1028
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0
			},
			reasoning: false
		};
	});
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		discoverAndRegister(ctx);
	});

	async function discoverAndRegister(ctx: ExtensionContext): Promise<void> {
		try {
			const registeredModels: Model<Api>[] = ctx.modelRegistry.getAvailable()
			log("registered models", JSON.stringify(registeredModels))

			const discoveryModels = registeredModels.filter(m => m.provider === PROVIDER && m.id === MODEL_ID)

			if (discoveryModels.length !== 1) {
				notify(`Found ${discoveryModels.length} llama - cpp providers / models.Only one should be specified in the shape of:
		{
			"providers": {
				"${PROVIDER}": { < --- key
		"baseUrl": "http://127.0.0.1:8080",
				"api": "openai-completions",
				"apiKey": "local",
				"models": [
					{
						"id": "${MODEL_ID}" < --- key
					}
				]
			}
		}
} `, ctx)
				return;
			}

			const discoveryModel = discoveryModels[0];
			const apiKeyAndHeaders = await ctx.modelRegistry.getApiKeyAndHeaders(discoveryModel)
			if (!apiKeyAndHeaders.ok) {
				throw new Error(apiKeyAndHeaders.error);
			}

			const discoveryHeaders = new Headers(apiKeyAndHeaders.headers);
			if (apiKeyAndHeaders.apiKey && !discoveryHeaders.has("authorization")) {
				discoveryHeaders.set("Authorization", `Bearer ${apiKeyAndHeaders.apiKey}`);
			}

			const isRouter = await checkRouterMode(discoveryModel.baseUrl, discoveryHeaders);
			if (!isRouter) {
				notify("server is not in router mode", ctx);
				return;
			}
			const url = `${discoveryModel.baseUrl}/models`;
			log(`Querying ${url}`);

			const response = await fetch(url, { headers: discoveryHeaders });
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			const llamaCppModels: llamaCppModels = await response.json();
			if (!llamaCppModels.data || !Array.isArray(llamaCppModels.data)) {
				throw new Error("Invalid response format from llama.cpp server");
			}

			if (llamaCppModels.data.length === 0) {
				notify(`Server returned no models`, ctx);
				return;
			}

			log(`Got models from llama-cpp: ${JSON.stringify(llamaCppModels)}`)

			const autoDiscoveredModels = transformLlamaCppModels(llamaCppModels)
			log(`autoDiscoveredModels ${JSON.stringify(autoDiscoveredModels)}`)

			const updatedProvider: ProviderConfig = {
				baseUrl: discoveryModel.baseUrl,
				apiKey: apiKeyAndHeaders.apiKey,
				api: discoveryModel.api,
				headers: apiKeyAndHeaders.headers,
				models: autoDiscoveredModels
			}
			const wasOnDiscoverModel = ctx.model?.provider === PROVIDER && ctx.model?.id === MODEL_ID

			pi.registerProvider(PROVIDER, updatedProvider)

			if (wasOnDiscoverModel && autoDiscoveredModels.length > 0) {
				const firstModel = ctx.modelRegistry.find(PROVIDER, autoDiscoveredModels[0].id)
				if (firstModel) {
					pi.setModel(firstModel)
				}
			}

		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			notify(`Failed to discover models: ${msg}`, ctx);
		}
	}


	async function checkRouterMode(baseUrl: string, headers: Headers): Promise<boolean> {
		let res: Response;
		try {
			res = await fetch(`${baseUrl}/props`, { headers });
		} catch {
			log(`Failed to probe ${baseUrl}/props`);
			return false;
		}
		if (!res.ok) {
			return false;
		}
		const body = await res.json();
		return body.role === "router";
	}
}