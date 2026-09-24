import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import fs from "node:fs";

const LOG_FILE = "/tmp/llama-cpp-tps.log";
const DEBUG = process.env.LLAMA_CPP_EXTENSION_DEBUG === "1";
function log(...args: any[]) {
	if (!DEBUG) return;
	fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [llama-cpp-tps] ${args.join(" ")}\n`);
}

const downArrow = "↓";
const upArrow = "↑";

interface LlamaCppTimings {
	predicted_ms?: number;
	predicted_per_second?: number;
	prompt_ms?: number;
	prompt_per_second?: number;
}

interface ProgressData {
	total?: number;
	cache?: number;
	processed?: number;
	time_ms?: number;
	pct?: number;
}

// Store latest timing data (single model — the fetch interceptor only wraps one)
let latestTimings: LlamaCppTimings | null = null;
let lastTpsDisplay: string | null = null;

// ctx from turn_start, used by the SSE parsing loop
let turnCtx: ExtensionContext | null = null;

function calcProgressPct(prog: ProgressData): number {
	const cached = prog.cache ?? 0;
	if (prog.total && prog.total > 0) {
		return Math.round(((prog.processed ?? 0) - cached) / (prog.total - cached) * 100);
	}
	return Math.round(((prog.processed ?? 0) / prog.total!) * 100);
}

function formatTps(data: LlamaCppTimings): string | null {
	const predicted = data.predicted_per_second;
	const prompt = data.prompt_per_second;
	const predictedMs = data.predicted_ms;
	const promptMs = data.prompt_ms;

	if (!predicted || predicted <= 0) return null;

	if (prompt && prompt > 0) {
		return `Out: ${downArrow}${predicted.toFixed(1)} tok/s${fmtTime(predictedMs) ? ` (${fmtTime(predictedMs)})` : ""} | In: ${upArrow}${prompt.toFixed(1)} tok/s${fmtTime(promptMs) ? ` (${fmtTime(promptMs)})` : ""}`;
	}
	return `${downArrow}${predicted.toFixed(1)} tok/s${fmtTime(predictedMs) ? ` (${fmtTime(predictedMs)})` : ""}`;
}

function fmtTime(ms: number | undefined): string {
	if (!ms || ms <= 0)
		return "";
	if (ms < 1000)
		return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
}

function captureTimings(
	modelId: string,
	body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
	log("captureTimings called for model:", modelId);
	const reader = body.getReader();
	let buffer = "";
	const decoder = new TextDecoder();

	return new ReadableStream({
		async start(controller) {
			log("captureTimings start() called");
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				log("captureTimings read chunk, len:", value ? value.length : 0);

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.startsWith("data: ")) continue;
					const jsonStr = line.slice(6);
					if (jsonStr === "[DONE]") { controller.enqueue(value); decoder.decode(); controller.close(); return; }

					try {
						const chunk = JSON.parse(jsonStr);
						if (chunk.timings) {
							latestTimings = chunk.timings;
							log("TIMINGS captured:", JSON.stringify(chunk.timings));
						}
						if (chunk.prompt_progress) {
							const prog = chunk.prompt_progress;

							prog.pct = calcProgressPct(prog);

							if (!turnCtx) {
								log("[PROGRESS] turnCtx is NULL");
							} else if (!turnCtx.hasUI) {
								log("[PROGRESS] turnCtx.hasUI is false");
							} else {
								try {
									const msg = `Working... | Prompt Processing ${prog.pct}%`;
									turnCtx.ui.setWorkingMessage(msg);
									log("[PROGRESS] setWorkingMessage:", msg);
								} catch (err) {
									log("[PROGRESS] setWorkingMessage ERROR:", String(err));
								}
							}

							log("PROGRESS:", prog.processed, "/", prog.total, "cache:", prog.cache ?? 0, "pct:", prog.pct + "%", "time_ms:", prog.time_ms);
						}

					} catch {
						// ignore parse errors for non-JSON SSE lines
					}
				}

				controller.enqueue(value);
			}

			decoder.decode(); // flush any remaining multi-byte sequences

			controller.close();
		},
		cancel(reason?: any) {
			reader.cancel(reason);
		},
	});
}


export default function (pi: ExtensionAPI) {
	log("globalThis.fetch exists:", typeof globalThis.fetch);
	const originalFetch = globalThis.fetch;
	log("saved originalFetch:", typeof originalFetch);
	globalThis.fetch = async (input: any, init?: any) => {
		const url = typeof input === "string" ? input : input.url;
		log("fetch intercepted, url:", url);
		if (typeof url !== "string" || !url.includes("/chat/completions")) {
			return originalFetch(input, init);
		}
		log("fetch: routing /chat/completions through captureTimings");
		const response = await originalFetch(input, init);
		log("fetch: response status:", response.status, "ok:", response.ok, "body:", response.body ? "present" : "NULL");
		if (response.ok && response.body) {
			return new Response(captureTimings("llama-cpp-model", response.body), {
				status: response.status,
				headers: Object.fromEntries(response.headers),
			});
		}
		return response;
	};
	// This is more reliable than message_end because by the time it fires,
	// all SSE chunks have been fully consumed and timings are captured.
	pi.on("turn_end", (event, ctx) => {
		log("turn_end fired - hasUI:", ctx.hasUI);

		if (!latestTimings || !latestTimings.predicted_per_second) {
			log("turn_end - no valid timings");
			return;
		}

		const display = formatTps(latestTimings);

		if (display && ctx.hasUI) {
			if (display !== lastTpsDisplay) {
				lastTpsDisplay = display;
				ctx.ui.setWidget("llama-cpp-tps", (_tui, theme) => new Text(theme.fg("text", display), 1, 0), { placement: "belowEditor" });
				ctx.ui.notify(`TPS: ${display}`);
				log("turn_end - Set widget:", display);
			}
		}

	});

	pi.on("turn_start", (event, ctx) => {
		turnCtx = ctx;
		latestTimings = null;
		lastTpsDisplay = null;
		log("turn_start fired, hasUI:", ctx.hasUI);
	});

	pi.on("before_provider_request", (event) => {
		if (turnCtx?.model?.provider !== "llama-cpp") return;
		const payload = event.payload as Record<string, unknown> | undefined;
		if (!payload) return;
		log("before_provider_request: adding timings_per_token + return_progress to payload");
		const newPayload: any = { ...payload, timings_per_token: true, return_progress: true };
		return newPayload;
	});

	pi.on("session_shutdown", () => {
		log("session_shutdown: clearing state");
		latestTimings = null;
		lastTpsDisplay = null;

		globalThis.fetch = originalFetch;
	});

	log("extension loaded successfully");
}
