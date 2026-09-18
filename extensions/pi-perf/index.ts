// pi-perf: per-request and per-turn latency, TTFT, and throughput measurements.
// Request latency opens immediately before provider dispatch and closes at the last
// observed generated output (text, thinking, or tool arguments).
//
//   TPS               = output tokens / request latency (includes TTFT)
//   decode TPS        = (output tokens - 1) / (request latency - TTFT)  [AIPerf]
//   stream decode TPS = output tokens / (request latency - TTFT)        [no N-1 correction]
//   active wall TPS   = output tokens / turn wall time excluding user-input waits
//
// Token counts are server-reported usage. Request = one provider call. Turn = one
// full agent run for a user prompt, including tool execution between requests.
//
// JSONL export is disabled by default. Enable it in ~/.pi/agent/settings.json:
//   { "piPerf": { "log": { "enabled": true, "path": "pi-perf.jsonl", "includePayloads": false } } }
// A trusted project's .pi/settings.json can override the same nested object.
// PI_PERF_LOG=/path/to/file.jsonl is a per-process override; it includes payloads by
// default, set PI_PERF_LOG_PAYLOADS=0 to disable them.
// View history with /perf.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

// A proxy that holds a response and releases it compressed makes (output - 1) / decodeSec report
// delivery speed, not decode speed: tens of thousands of tok/s for a single burst, or 3-6x the
// model's real rate when the buffer drains over a second. Treat the events interval as buffered
// when it exceeds an absolute cap or, once a model has a few samples, a multiple of that model's
// running median; fall back to end-to-end for those requests.
// ponytail: calibration knobs. Raise the cap for stacks that genuinely stream faster than this.
const MAX_PLAUSIBLE_DECODE_TPS = 1000;
const BUFFERED_MEDIAN_MULTIPLE = 2.5;
const BUFFERED_MIN_SAMPLES = 3;
// Server epoch headers are only trusted when they fall inside our own request window, which
// bounds clock skew between the gateway and this machine to at most a round trip.
const TRUSTED_SOURCES = new Set(["server", "anchored", "events"]);
const trusted = (source: unknown) => typeof source === "string" && TRUSTED_SOURCES.has(source);

interface ResponseAttempt {
  status: number;
  atWallMs: number;
  atPerfMs: number;
  requestId: string | null;
  correlationId: string | null;
  traceparent: string | null;
  serverDecodeMs: number | null;
  serverDecodeTps: number | null;
  serverReceivedAtMs: number | null;  // gateway accepted the request (epoch ms header)
  serverSentAtMs: number | null;      // gateway began forwarding the response, i.e. first token
}
interface ActiveRequest {
  turn: number;
  startWallMs: number;
  startPerfMs: number;
  responseStartWallMs: number | null;
  responseStartPerfMs: number | null;
  firstOutputPerfMs: number | null;
  lastOutputPerfMs: number | null;
  outputEvents: number;
  clientRequestId: string | null;
  clientCorrelationId: string | null;
  responses: ResponseAttempt[];
}
interface Req {
  turn: number;
  input: number;
  cacheRead: number;
  output: number;
  sec: number;
  ttftSec: number | null;
  eventItlMs: number | null;
  deltas: number;
  decodeTps: number | null;
  streamDecodeTps: number | null;
  effectiveTps: number | null;
  // server: provider Server-Timing decode metric. anchored: gateway sent-at header to the last
  // delta on our clock; immune to anything downstream of the gateway holding the stream.
  // events: first to last delta on our clock. e2e: whole request latency.
  tpsSource: "server" | "anchored" | "events" | "e2e" | null;
  metricTokens: number;
  metricSec: number;
}
interface Turn {
  reqs: number;
  output: number;
  streamSec: number;
  wallSec: number;          // total agent wall time, including user-input waits
  activeWallSec: number;    // wallSec minus time blocked on extension UI prompts
  userWaitSec: number;
  decodeSec: number;
  decodeTokens: number;
  streamDecodeTokens: number;
}
interface LogConfig {
  enabled: boolean;
  path: string;
  includePayloads: boolean;
}

const CONFIG_DIR_NAME = ".pi";
const getAgentDir = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), CONFIG_DIR_NAME, "agent");
const expandTildePath = (path: string) =>
  path === "~" ? homedir() : path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(2)) : path;
const f1 = (n: number) => n.toFixed(1);
const f3 = (n: number) => n.toFixed(3);
const div = (a: number | null, b: number) => (a === null || b <= 0 ? null : a / b);
const rate = (n: number | null) => (n === null ? "n/a" : f1(n));
const seconds = (n: number | null) => (n === null ? "n/a" : `${f3(n)} s`);
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function headerValue(headers: Record<string, unknown>, names: string[]): string | null {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  for (const name of names) {
    const value = lower.get(name);
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function headerValueBySuffix(headers: Record<string, unknown>, suffix: string): string | null {
  const normalizedSuffix = suffix.toLowerCase().replaceAll("_", "-");
  const entries = Object.entries(headers).map(([key, value]) =>
    [key.toLowerCase().replaceAll("_", "-"), value] as const);
  for (const [key, value] of entries) {
    if (key === normalizedSuffix && typeof value === "string" && value.length > 0) return value;
  }
  for (const [key, value] of entries) {
    if (key.endsWith(`-${normalizedSuffix}`) && typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function numericHeaderBySuffix(headers: Record<string, unknown>, suffixes: string[]): number | null {
  for (const suffix of suffixes) {
    const value = headerValueBySuffix(headers, suffix);
    if (value === null) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

const TOKEN_TIMING_STEMS = [
  "llm-decode",
  "model-decode",
  "token-decode",
  "llm-token-generation",
  "model-token-generation",
  "token-generation",
];

function splitOutsideQuotes(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (quoted) {
      if (char === "\\") {
        current += char;
        escaped = true;
      } else if (char === '"') {
        quoted = false;
        current += char;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      current += char;
      continue;
    }
    if (char === delimiter) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  const last = current.trim();
  if (last.length > 0) parts.push(last);
  return parts;
}

function unquoteHttpString(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  let result = "";
  for (let i = 1; i < trimmed.length - 1; i++) {
    if (trimmed[i] === "\\" && i + 1 < trimmed.length - 1) {
      result += trimmed[i + 1];
      i++;
      continue;
    }
    result += trimmed[i];
  }
  return result;
}

function serverTimingMs(headers: Record<string, unknown>): number | null {
  const value = headerValue(headers, ["server-timing"]);
  if (!value) return null;
  for (const stem of TOKEN_TIMING_STEMS) {
    for (const entry of splitOutsideQuotes(value, ",")) {
      const parts = splitOutsideQuotes(entry, ";");
      const name = (parts.shift() ?? "").trim().toLowerCase().replaceAll("_", "-");
      if (name !== stem) continue;
      for (const param of parts) {
        const equals = param.indexOf("=");
        if (equals === -1) continue;
        const key = param.slice(0, equals).trim().toLowerCase();
        if (key !== "dur") continue;
        const parsed = Number(unquoteHttpString(param.slice(equals + 1)));
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
    }
  }
  return null;
}

function serverDecodeTiming(headers: Record<string, unknown>): Pick<ResponseAttempt, "serverDecodeMs" | "serverDecodeTps"> {
  const durationSuffixes = TOKEN_TIMING_STEMS.flatMap((stem) => [`${stem}-duration-ms`, `${stem}-ms`]);
  const tpsSuffixes = TOKEN_TIMING_STEMS.flatMap((stem) => [`${stem}-tokens-per-second`, `${stem}-tps`]);
  return {
    serverDecodeMs: numericHeaderBySuffix(headers, durationSuffixes) ?? serverTimingMs(headers),
    serverDecodeTps: numericHeaderBySuffix(headers, tpsSuffixes),
  };
}

function readLogSettings(path: string, baseDir: string): Partial<LogConfig> {
  try {
    const settings: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isObject(settings) || !isObject(settings.piPerf)) return {};
    const raw = settings.piPerf.log;
    const rawLog: Record<string, unknown> = typeof raw === "boolean" ? { enabled: raw }
      : typeof raw === "string" ? { enabled: true, path: raw }
      : isObject(raw) ? raw
      : {};
    const result: Partial<LogConfig> = {};
    if (typeof rawLog.enabled === "boolean") result.enabled = rawLog.enabled;
    if (typeof rawLog.path === "string" && rawLog.path.length > 0) {
      const expanded = expandTildePath(rawLog.path);
      result.path = isAbsolute(expanded) ? expanded : join(baseDir, expanded);
    }
    if (typeof rawLog.includePayloads === "boolean") result.includePayloads = rawLog.includePayloads;
    return result;
  } catch {
    // Missing or malformed settings must not break Pi. Pi reports malformed known
    // settings separately; this extension-specific section is best-effort.
    return {};
  }
}

function logConfig(ctx?: any): LogConfig {
  const envPath = process.env.PI_PERF_LOG;
  if (envPath) {
    return {
      enabled: true,
      path: expandTildePath(envPath),
      includePayloads: process.env.PI_PERF_LOG_PAYLOADS !== "0",
    };
  }
  const agentDir = getAgentDir();
  const globalPath = join(agentDir, "settings.json");
  let settings = readLogSettings(globalPath, agentDir);
  if (ctx?.isProjectTrusted?.()) {
    const projectDir = join(ctx.cwd, CONFIG_DIR_NAME);
    settings = { ...settings, ...readLogSettings(join(projectDir, "settings.json"), projectDir) };
  }
  return {
    enabled: settings.enabled === true,
    path: settings.path ?? join(agentDir, "pi-perf.jsonl"),
    includePayloads: settings.includePayloads === true,
  };
}

export default function (pi: ExtensionAPI) {
  const reqs: Req[] = [];
  const turns: Turn[] = [];
  let turnIdx = -1;
  let runStartPerf = 0;
  let runStartWall = 0;
  let cur: Turn | undefined;
  let active: ActiveRequest | undefined;
  let pendingClientRequestId: string | null = null;
  let pendingClientCorrelationId: string | null = null;
  let userWaitStartPerf: number | null = null;
  const eventRatesByModel = new Map<string, number[]>();
  const looksBuffered = (model: string, rate: number) => {
    const rates = eventRatesByModel.get(model) ?? [];
    const sorted = [...rates].sort((a, b) => a - b);
    const median = sorted.length >= BUFFERED_MIN_SAMPLES ? sorted[Math.floor(sorted.length / 2)] : null;
    rates.push(rate);
    eventRatesByModel.set(model, rates);
    return rate > MAX_PLAUSIBLE_DECODE_TPS || (median !== null && rate > BUFFERED_MEDIAN_MULTIPLE * median);
  };

  const session = (ctx: any) => {
    try { return ctx.sessionManager?.getSessionFile?.() ?? ctx.sessionManager?.getSessionId?.(); } catch { return undefined; }
  };
  const sessionStats = () => {
    let ttftSec = 0;
    let ttftCount = 0;
    let metricSec = 0;
    let metricTokens = 0;
    let sec = 0;
    let output = 0;
    for (const req of reqs) {
      if (req.output === 0) continue; // aborted / errored attempts carry no throughput signal
      if (req.ttftSec !== null) {
        ttftSec += req.ttftSec;
        ttftCount++;
      }
      sec += req.sec;
      output += req.output;
      // Decode aggregates only trust server or clean event timing; e2e fallbacks are excluded.
      if (trusted(req.tpsSource) && req.metricSec > 0 && req.metricTokens > 0) {
        metricSec += req.metricSec;
        metricTokens += req.metricTokens;
      }
    }
    return {
      ttftSec: ttftCount > 0 ? ttftSec / ttftCount : null,
      tps: div(output, sec),
      decodeTps: metricSec > 0 && metricTokens > 0 ? metricTokens / metricSec : null,
    };
  };
  const updateFooterStatus = (ctx: any) => {
    // The footer shows the latest request that produced tokens; a failed attempt keeps the
    // previous reading rather than replacing it with n/a.
    const latest = reqs.findLast((r) => r.output > 0);
    if (!latest) {
      ctx.ui.setStatus("perf", undefined);
      return;
    }
    const session = sessionStats();
    const color = (name: string, text: string) => ctx.ui.theme?.fg?.(name, text) ?? text;
    const label = (text: string) => color("dim", text);
    const separator = color("dim", "•");
    // Headline is decode TPS from a trustworthy source (Server-Timing, gateway anchor, or clean
    // event timing), n/a otherwise. End-to-end TPS (tokens / request latency, immune to stream
    // buffering) always follows in parentheses.
    const tps = (decode: number | null, e2e: number | null) =>
      `${color("success", rate(decode))} ${label(`(e2e ${rate(e2e)})`)}`;
    const latestDecode = trusted(latest.tpsSource) ? latest.decodeTps : null;
    ctx.ui.setStatus(
      "perf",
      [
        `${label("Turn TTFT:")} ${color("accent", seconds(latest.ttftSec))}`,
        `${label("Turn TPS:")} ${tps(latestDecode, div(latest.output, latest.sec))}`,
        `${label("Session TTFT:")} ${color("accent", seconds(session.ttftSec))}`,
        `${label("Session TPS:")} ${tps(session.decodeTps, session.tps)}`,
      ].join(` ${separator} `),
    );
  };
  const finite = (value: unknown, fallback = 0) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const nullableFinite = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;

  const restoreFromSession = (ctx: any) => {
    reqs.length = 0;
    turns.length = 0;
    for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
      if (entry.type !== "custom") continue;
      const data = entry.data;
      if (!isObject(data)) continue;
      if (entry.customType === "perf_request") {
        const output = finite(data.output);
        const sec = finite(data.sec);
        const ttftSec = nullableFinite(data.ttftSec);
        const decodeSec = ttftSec === null ? null : sec - ttftSec;
        const eventDecodeTps = decodeSec !== null && decodeSec > 0 && output > 1 && (output - 1) / decodeSec <= MAX_PLAUSIBLE_DECODE_TPS
          ? (output - 1) / decodeSec : null;
        const decodeTps = nullableFinite(data.decodeTps) ?? eventDecodeTps;
        const effectiveTps = nullableFinite(data.effectiveTps) ?? decodeTps ?? div(output, sec);
        const tpsSource = trusted(data.tpsSource) || data.tpsSource === "e2e"
          ? data.tpsSource as Req["tpsSource"]
          : decodeTps !== null ? "events" : effectiveTps !== null ? "e2e" : null;
        reqs.push({
          turn: finite(data.turn, -1),
          input: finite(data.input),
          cacheRead: finite(data.cacheRead),
          output,
          sec,
          ttftSec,
          eventItlMs: nullableFinite(data.eventItlMs),
          deltas: finite(data.deltas),
          decodeTps,
          streamDecodeTps: "streamDecodeTps" in data ? nullableFinite(data.streamDecodeTps)
            : eventDecodeTps !== null && decodeSec !== null ? output / decodeSec : null,
          effectiveTps,
          tpsSource,
          metricTokens: nullableFinite(data.metricTokens) ?? (decodeTps !== null && decodeSec !== null ? output - 1 : output),
          metricSec: nullableFinite(data.metricSec) ?? (decodeTps !== null && decodeSec !== null ? decodeSec : sec),
        });
      } else if (entry.customType === "perf_turn") {
        const wallSec = finite(data.wallSec);
        turns.push({
          reqs: finite(data.reqs),
          output: finite(data.output),
          streamSec: finite(data.streamSec),
          wallSec,
          activeWallSec: finite(data.activeWallSec, wallSec),
          userWaitSec: finite(data.userWaitSec),
          decodeSec: finite(data.decodeSec),
          decodeTokens: finite(data.decodeTokens),
          streamDecodeTokens: finite(data.streamDecodeTokens),
        });
      }
    }
    updateFooterStatus(ctx);
  };
  const writeLog = (rec: object, ctx?: any) => {
    const config = logConfig(ctx);
    if (!config.enabled) return;
    try {
      mkdirSync(dirname(config.path), { recursive: true });
      appendFileSync(config.path, JSON.stringify(rec) + "\n");
    } catch {}
  };

  pi.on("session_start", (_e, ctx) => restoreFromSession(ctx));
  pi.on("session_tree", (_e, ctx) => restoreFromSession(ctx));

  let sysLogged = false;
  pi.on("before_agent_start", (_e, ctx) => {
    const config = logConfig(ctx);
    if (!sysLogged && config.includePayloads) {
      sysLogged = true;
      writeLog({ type: "system_prompt", text: ctx.getSystemPrompt() }, ctx);
    }
  });

  pi.on("before_provider_request", (e, ctx) => {
    const startWallMs = Date.now();
    active = {
      turn: turnIdx,
      startWallMs,
      startPerfMs: performance.now(),
      responseStartWallMs: null,
      responseStartPerfMs: null,
      firstOutputPerfMs: null,
      lastOutputPerfMs: null,
      outputEvents: 0,
      clientRequestId: pendingClientRequestId,
      clientCorrelationId: pendingClientCorrelationId,
      responses: [],
    };
    pendingClientRequestId = null;
    pendingClientCorrelationId = null;
    const config = logConfig(ctx);
    if (config.includePayloads) {
      writeLog({ type: "provider_request", session: session(ctx), turn: turnIdx, startWallMs, payload: e.payload }, ctx);
    }
  });

  pi.on("before_provider_headers", (e) => {
    const requestId = headerValueBySuffix(e.headers, "request-id");
    const correlationId = headerValueBySuffix(e.headers, "correlation-id");
    if (active) {
      active.clientRequestId = requestId;
      active.clientCorrelationId = correlationId;
      return;
    }
    // Pi emits headers before before_provider_request; hold them until the request opens.
    pendingClientRequestId = requestId;
    pendingClientCorrelationId = correlationId;
  });

  pi.on("after_provider_response", (e) => {
    if (!active) return;
    const atWallMs = Date.now();
    const atPerfMs = performance.now();
    if (active.responseStartPerfMs === null) {
      active.responseStartWallMs = atWallMs;
      active.responseStartPerfMs = atPerfMs;
    }
    active.responses.push({
      status: e.status,
      atWallMs,
      atPerfMs,
      requestId: headerValueBySuffix(e.headers, "request-id"),
      correlationId: headerValueBySuffix(e.headers, "correlation-id"),
      traceparent: headerValueBySuffix(e.headers, "traceparent"),
      ...serverDecodeTiming(e.headers),
      serverReceivedAtMs: numericHeaderBySuffix(e.headers, ["received-at", "accepted-at"]),
      serverSentAtMs: numericHeaderBySuffix(e.headers, ["sent-at"]),
    });
  });

  pi.on("ui_prompt_start", () => {
    // Pi coalesces nested/overlapping prompts into one outer span.
    if (userWaitStartPerf === null) userWaitStartPerf = performance.now();
  });

  pi.on("ui_prompt_end", () => {
    if (userWaitStartPerf === null) return;
    const elapsedSec = (performance.now() - userWaitStartPerf) / 1000;
    userWaitStartPerf = null;
    if (cur) cur.userWaitSec += elapsedSec;
  });

  pi.on("turn_start", (e) => {
    turnIdx = e.turnIndex;
  });

  pi.on("message_update", (e) => {
    if (!active) return;
    const t = e.assistantMessageEvent.type;
    // Tool-call arguments are generated model output; tool execution stays outside
    // request latency and is included in turn wall time instead.
    if (t !== "text_delta" && t !== "thinking_delta" && t !== "toolcall_delta") return;
    const now = performance.now();
    if (active.firstOutputPerfMs === null) active.firstOutputPerfMs = now;
    active.lastOutputPerfMs = now;
    active.outputEvents++;
  });

  pi.on("message_end", (e: any, ctx) => {
    // assistant message_end fires when the model stream completes, before tools run.
    if (e.message.role !== "assistant" || !active) return;
    const messageEndWallMs = Date.now();
    const messageEndPerfMs = performance.now();
    const req = active;
    active = undefined;

    const u = e.message.usage ?? {};
    const output = u.output ?? 0;
    const lastOutputPerfMs = req.lastOutputPerfMs;
    const endPerfMs = lastOutputPerfMs ?? messageEndPerfMs;
    const sec = (endPerfMs - req.startPerfMs) / 1000;
    const ttftSec = req.firstOutputPerfMs === null ? null : (req.firstOutputPerfMs - req.startPerfMs) / 1000;
    const decodeSec = ttftSec === null ? null : sec - ttftSec;
    const eventItlMs = req.outputEvents > 1 && lastOutputPerfMs !== null && req.firstOutputPerfMs !== null
      ? (lastOutputPerfMs - req.firstOutputPerfMs) / (req.outputEvents - 1)
      : null;
    const finalResponse = req.responses.at(-1);
    const lastOutputWallMs = lastOutputPerfMs === null ? null : req.startWallMs + (lastOutputPerfMs - req.startPerfMs);
    const sentAt = finalResponse?.serverSentAtMs ?? null;
    const sentAtTrusted = sentAt !== null && req.responseStartWallMs !== null
      && sentAt >= req.startWallMs && sentAt <= req.responseStartWallMs;
    const anchoredSec = sentAtTrusted && lastOutputWallMs !== null ? (lastOutputWallMs - sentAt) / 1000 : null;
    const serverTtftSec = sentAtTrusted && finalResponse?.serverReceivedAtMs ? (sentAt - finalResponse.serverReceivedAtMs) / 1000 : null;
    // How long the first byte took to reach us after the gateway sent it: a proxy hold shows up here.
    const headerDelaySec = sentAtTrusted && req.responseStartWallMs !== null ? (req.responseStartWallMs - sentAt) / 1000 : null;
    // Prefer the gateway anchor for the decode window; fall back to the delta interval.
    const windowSec = anchoredSec !== null && anchoredSec > 0 ? anchoredSec : decodeSec;
    const windowSource: Req['tpsSource'] = anchoredSec !== null && anchoredSec > 0 ? 'anchored' : 'events';
    const buffered = windowSec !== null && windowSec > 0 && output > 1
      && looksBuffered(String(e.message.model ?? ""), (output - 1) / windowSec);
    const eventDecodeTps = windowSec !== null && windowSec > 0 && output > 1 && !buffered ? (output - 1) / windowSec : null;
    const streamDecodeTps = windowSec !== null && windowSec > 0 && output > 0 && !buffered ? output / windowSec : null;
    let decodeTps = eventDecodeTps;
    let tpsSource: Req['tpsSource'] = eventDecodeTps !== null ? windowSource : null;
    let metricTokens = eventDecodeTps !== null ? output - 1 : 0;
    let metricSec = eventDecodeTps !== null && windowSec !== null ? windowSec : 0;
    if (finalResponse?.serverDecodeTps && finalResponse.serverDecodeTps > 0 && output > 0) {
      decodeTps = finalResponse.serverDecodeTps;
      tpsSource = 'server';
      metricTokens = output;
      metricSec = output / finalResponse.serverDecodeTps;
    } else if (finalResponse?.serverDecodeMs && finalResponse.serverDecodeMs > 0 && output > 0) {
      metricSec = finalResponse.serverDecodeMs / 1000;
      metricTokens = output;
      decodeTps = output / metricSec;
      tpsSource = 'server';
    }
    if (tpsSource === null) {
      metricTokens = output;
      metricSec = sec;
      tpsSource = sec > 0 && output > 0 ? 'e2e' : null;
    }
    const effectiveTps = metricSec > 0 && metricTokens > 0 ? metricTokens / metricSec : null;

    const record = {
      type: "request",
      source: "pi-perf",
      session: session(ctx),
      turn: req.turn,
      startWallMs: req.startWallMs,
      startPerfMs: req.startPerfMs,
      responseStartWallMs: req.responseStartWallMs,
      responseStartPerfMs: req.responseStartPerfMs,
      firstOutputPerfMs: req.firstOutputPerfMs,
      lastOutputPerfMs: req.lastOutputPerfMs,
      messageEndWallMs,
      messageEndPerfMs,
      responseStatus: finalResponse?.status ?? null,
      stopReason: e.message.stopReason ?? null,
      errorMessage: e.message.errorMessage ?? null,
      clientRequestId: req.clientRequestId,
      clientCorrelationId: req.clientCorrelationId,
      requestId: finalResponse?.requestId ?? null,
      correlationId: finalResponse?.correlationId ?? null,
      traceparent: finalResponse?.traceparent ?? null,
      responseAttempts: req.responses,
      input: u.input ?? 0,
      cacheRead: u.cacheRead ?? 0,
      output,
      sec,
      ttftSec,
      serverTtftSec,
      headerDelaySec,
      anchoredSec,
      eventItlMs,
      deltas: req.outputEvents,
      buffered,
      tps: div(output, sec),
      decodeTps,
      streamDecodeTps,
      effectiveTps,
      tpsSource,
      metricTokens,
      metricSec,
    };
    reqs.push(record);

    if (cur) {
      cur.reqs++;
      cur.output += output;
      cur.streamSec += sec;
      // Turn decode totals follow the same server/events selection as the request; e2e fallbacks
      // (no decode boundary, or a buffered burst) contribute nothing to decode time.
      if (trusted(tpsSource) && metricSec > 0) {
        cur.decodeSec += metricSec;
        cur.decodeTokens += metricTokens;
        cur.streamDecodeTokens += output;
      }
    }
    updateFooterStatus(ctx);
    try { pi.appendEntry("perf_request", record); } catch {}
    writeLog(record, ctx);
  });

  pi.on("agent_start", () => {
    runStartWall = Date.now();
    runStartPerf = performance.now();
    if (userWaitStartPerf !== null) userWaitStartPerf = runStartPerf;
    cur = { reqs: 0, output: 0, streamSec: 0, wallSec: 0, activeWallSec: 0, userWaitSec: 0, decodeSec: 0, decodeTokens: 0, streamDecodeTokens: 0 };
  });

  pi.on("agent_end", (_e, ctx) => {
    if (!cur) return;
    const endPerf = performance.now();
    if (userWaitStartPerf !== null) {
      // Do not let a still-open prompt leak into the next agent run.
      cur.userWaitSec += Math.max(0, (endPerf - userWaitStartPerf) / 1000);
      userWaitStartPerf = null;
    }
    cur.wallSec = (endPerf - runStartPerf) / 1000;
    cur.activeWallSec = Math.max(0, cur.wallSec - cur.userWaitSec);
    turns.push(cur);
    const tps = div(cur.output, cur.streamSec);
    const activeWallTps = div(cur.output, cur.activeWallSec);
    const wallTps = div(cur.output, cur.wallSec);
    const decodeTps = div(cur.decodeTokens, cur.decodeSec);
    const streamDecodeTps = div(cur.streamDecodeTokens, cur.decodeSec);
    // Turn metrics stay in the footer; /perf is the explicit detailed report.
    const record = {
      type: "turn",
      source: "pi-perf",
      session: session(ctx),
      startWallMs: runStartWall,
      ...cur,
      tps,
      activeWallTps,
      wallTps,
      decodeTps,
      streamDecodeTps,
    };
    writeLog(record, ctx);
    try { pi.appendEntry("perf_turn", record); } catch {}
    cur = undefined;
  });

  const showPerf = async (_args: string, ctx: any) => {
    const lines = ["Requests (provider calls; decode = AIPerf / stream):"];
    if (reqs.length === 0) lines.push("  (none)");
    for (const r of reqs) {
      const tps = div(r.output, r.sec);
      lines.push(
        `  turn ${r.turn}: ${r.output} tok out (${r.input} in), ${f1(r.sec)}s e2e, ttft ${r.ttftSec === null ? "n/a" : f1(r.ttftSec) + "s"}, ${rate(tps)} tok/s, decode ${rate(r.decodeTps)} / ${rate(r.streamDecodeTps)} tok/s`,
      );
    }
    lines.push("Turns (per prompt; active wall excludes user-input waits):");
    if (turns.length === 0) lines.push("  (none)");
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      const tps = div(t.output, t.streamSec);
      const activeWallTps = div(t.output, t.activeWallSec);
      const wallTps = div(t.output, t.wallSec);
      const decodeTps = div(t.decodeTokens, t.decodeSec);
      const streamDecodeTps = div(t.streamDecodeTokens, t.decodeSec);
      lines.push(
        `  #${i + 1}: ${t.reqs} req, ${t.output} tok, ${f1(t.streamSec)}s stream, ${f1(t.activeWallSec)}s active wall (+${f1(t.userWaitSec)}s user wait), ${rate(tps)} stream tok/s, ${rate(activeWallTps)} active-wall tok/s (${rate(wallTps)} total-wall), decode ${rate(decodeTps)} / ${rate(streamDecodeTps)} tok/s`,
      );
    }
    const config = logConfig(ctx);
    lines.push(`JSONL export: ${config.enabled ? config.path : "disabled"}`);
    updateFooterStatus(ctx);
    ctx.ui.notify(lines.join("\n"), "info");
  };

  pi.registerCommand("perf", {
    description: "Show per-request and per-turn latency/throughput",
    handler: showPerf,
  });
}
