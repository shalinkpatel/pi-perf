// Runs the extension directly: no Pi process, skills, model calls, or network.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { default: install } = await import(new URL('../extensions/pi-perf/index.ts', import.meta.url));

// A decode value renders in success color; an `N e2e` fallback renders dim.
const tpsCell = (v) => /e2e$/.test(v) ? `[dim]${v}[/dim]` : `[success]${v}[/success]`;
const styledFooter = (turnTtft, turnDecode, sessionTtft, sessionDecode) =>
  `[dim]Turn:[/dim] [dim]TTFT[/dim] [accent]${turnTtft}[/accent] [dim]TPS[/dim] ${tpsCell(turnDecode)} [dim]•[/dim] ` +
  `[dim]Session:[/dim] [dim]TTFT[/dim] [accent]${sessionTtft}[/accent] [dim]TPS[/dim] ${tpsCell(sessionDecode)}`;

function harness(t, options = {}) {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => now);
  const dir = mkdtempSync(join(tmpdir(), 'pi-perf-test-'));
  const agentDir = join(dir, 'agent');
  const cwd = join(dir, 'project');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const previous = {
    perfLog: process.env.PI_PERF_LOG,
    perfPayloads: process.env.PI_PERF_LOG_PAYLOADS,
    agentDir: process.env.PI_CODING_AGENT_DIR,
  };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const log = join(dir, 'metrics.jsonl');
  if (options.envLog !== false) process.env.PI_PERF_LOG = log;
  else delete process.env.PI_PERF_LOG;
  if (options.settings !== undefined) {
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(options.settings));
  }
  if (options.projectSettings !== undefined) {
    const projectConfig = join(cwd, '.pi');
    mkdirSync(projectConfig, { recursive: true });
    writeFileSync(join(projectConfig, 'settings.json'), JSON.stringify(options.projectSettings));
  }
  t.after(() => {
    for (const [key, value] of [['PI_PERF_LOG', previous.perfLog], ['PI_PERF_LOG_PAYLOADS', previous.perfPayloads], ['PI_CODING_AGENT_DIR', previous.agentDir]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const handlers = new Map(), commands = new Map();
  const entries = [], notifications = [], statuses = [];
  const sessionEntries = options.sessionEntries ?? [];
  const ctx = {
    cwd,
    isProjectTrusted: () => options.projectTrusted === true,
    sessionManager: {
      getSessionFile: () => '/test/session.jsonl',
      getSessionId: () => 'session-id',
      getBranch: () => sessionEntries,
    },
    getSystemPrompt: () => 'test system prompt',
    ui: {
      theme: { fg: (color, text) => `[${color}]${text}[/${color}]` },
      setStatus: (key, text) => statuses.push([key, text]),
      notify: (text) => notifications.push(text),
    },
  };
  install({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (customType, data) => entries.push({ customType, data }),
  });
  const emit = (at, type, data = {}) => {
    now = at;
    return handlers.get(type)?.({ type, ...data }, ctx);
  };
  const update = (at, type, delta = '{}') => emit(at, 'message_update', {
    assistantMessageEvent: { type, delta, contentIndex: 0 },
  });
  const begin = (at, turnIndex = 0, responseHeaders = {}) => {
    emit(at, 'turn_start', { turnIndex, timestamp: at });
    emit(at, 'before_provider_headers', { headers: { 'X-Request-ID': `client-${turnIndex}`, 'X-Correlation-ID': `client-corr-${turnIndex}` } });
    emit(at, 'before_provider_request', { payload: { turn: turnIndex } });
    const headerNames = Object.keys(responseHeaders).map(name => name.toLowerCase().replaceAll('_', '-'));
    const defaultHeaders = {
      ...(headerNames.some(name => name.endsWith('request-id')) ? {} : { 'x-request-id': `server-${turnIndex}` }),
      ...(headerNames.some(name => name.endsWith('correlation-id')) ? {} : { 'x-correlation-id': `corr-${turnIndex}` }),
    };
    emit(at + 50, 'after_provider_response', { status: 200, headers: { ...defaultHeaders, ...responseHeaders } });
  };
  const finish = (at, output = 100, model = 'test-model') => emit(at, 'message_end', {
    message: { role: 'assistant', model, usage: { input: 20, cacheRead: 10, output } },
  });
  return {
    dir, log, emit, update, begin, finish, entries, notifications, statuses,
    records: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [],
    report: () => commands.get('perf').handler('', ctx),
    hasCommand: (name) => commands.has(name),
    sessionEntries,
  };
}

for (const [name, types] of [
  ['tool-only', ['toolcall_delta', 'toolcall_delta', 'toolcall_delta']],
  ['thinking/text followed by tool arguments', ['thinking_delta', 'text_delta', 'toolcall_delta']],
  ['text-only unchanged', ['text_delta', 'text_delta', 'text_delta']],
  ['thinking-only unchanged', ['thinking_delta', 'thinking_delta', 'thinking_delta']],
]) {
  test(name, async (t) => {
    const h = harness(t);
    h.update(900, 'toolcall_delta'); // no request open: ignore
    h.emit(1000, 'agent_start');
    h.begin(1000);
    h.update(1050, 'toolcall_start'); // lifecycle events are not deltas
    types.forEach((type, i) => h.update(1100 + 200 * i, type, i ? '{}' : ''));
    h.update(1600, 'toolcall_end');
    h.update(1650, 'done');
    h.emit(1660, 'message_end', { message: { role: 'toolResult' } });
    h.finish(1700); // trailer time must not extend inference timing
    h.finish(1750); // duplicate end must not double count
    h.update(1800, 'toolcall_delta'); // closed request: ignore
    h.emit(2000, 'agent_end');
    const request = h.records().filter(r => r.type === 'request');
    assert.equal(request.length, 1);
    const r = request[0];
    assert.deepEqual([r.sec, r.ttftSec, r.eventItlMs, r.deltas, r.output], [0.5, 0.1, 200, 3, 100]);
    assert.deepEqual([r.startPerfMs, r.responseStartPerfMs, r.firstOutputPerfMs, r.lastOutputPerfMs, r.messageEndPerfMs], [1000, 1050, 1100, 1500, 1700]);
    assert.equal(r.tps, 200);
    assert.equal(r.decodeTps, 247.5);
    assert.equal(r.streamDecodeTps, 250);
    assert.equal(r.effectiveTps, 247.5);
    assert.equal(r.tpsSource, 'events');
    assert.deepEqual([r.metricTokens, r.metricSec], [99, 0.4]);
    assert.equal(r.clientRequestId, 'client-0');
    assert.equal(r.requestId, 'server-0');
    assert.equal(r.correlationId, 'corr-0');
    assert.equal(r.responseStatus, 200);
    assert.equal(r.responseAttempts.length, 1);
    const persisted = h.entries.find(e => e.customType === 'perf_request').data;
    for (const key of ['sec', 'ttftSec', 'eventItlMs', 'deltas', 'output', 'streamDecodeTps', 'requestId']) assert.equal(persisted[key], r[key]);
    const turn = h.records().find(r => r.type === 'turn');
    assert.deepEqual([turn.reqs, turn.output, turn.streamSec, turn.wallSec, turn.activeWallSec, turn.userWaitSec, turn.tps, turn.activeWallTps, turn.wallTps, turn.decodeTps, turn.streamDecodeTps], [1, 100, 0.5, 1, 1, 0, 200, 100, 100, 247.5, 250]);
    assert.deepEqual(h.statuses.at(-1), ['perf', styledFooter('0.1s', '247.5', '0.1s', '247.5')]);
    await h.report();
    assert.equal(h.hasCommand('tps'), false);
    assert.match(h.notifications.at(-1), /100 tok out/);
    assert.match(h.notifications.at(-1), /200\.0 tok\/s/);
    assert.match(h.notifications.at(-1), /247\.5 \/ 250\.0 tok\/s/);
    assert.match(h.notifications.at(-1), new RegExp(h.log.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}

test('single tool delta has TTFT but no decode interval', (t) => {
  const h = harness(t);
  h.begin(1000);
  h.update(1200, 'toolcall_delta');
  h.finish(1800, 1);
  const r = h.records().find(r => r.type === 'request');
  assert.deepEqual([r.sec, r.ttftSec, r.eventItlMs, r.deltas, r.tps, r.decodeTps, r.streamDecodeTps], [0.2, 0.2, null, 1, 5, null, null]);
  assert.equal(r.effectiveTps, 5);
  assert.equal(r.tpsSource, 'e2e');
  assert.deepEqual([r.metricTokens, r.metricSec], [1, 0.2]);
  assert.deepEqual(h.statuses.at(-1), ['perf', styledFooter('0.2s', '5.0 e2e', '0.2s', '5.0 e2e')]);
});

test('buffered burst falls back to end-to-end TPS instead of dividing by dispatch jitter', (t) => {
  const h = harness(t);
  h.emit(1000, 'agent_start');
  h.begin(1000);
  // 700 tokens arrive as one burst 16 s after the request: 181 deltas within 30 ms.
  for (let i = 0; i < 181; i++) h.update(17000 + i * 30 / 180, 'text_delta');
  h.finish(17040, 700);
  h.emit(17100, 'agent_end');
  const r = h.records().find(r => r.type === 'request');
  assert.equal(r.buffered, true);
  assert.equal(r.decodeTps, null);
  assert.equal(r.streamDecodeTps, null);
  assert.equal(r.tpsSource, 'e2e');
  assert.ok(Math.abs(r.effectiveTps - 700 / 16.03) < 0.01, r.effectiveTps);
  assert.ok(r.effectiveTps < 100);
  const turn = h.records().find(r => r.type === 'turn');
  assert.equal(turn.decodeTps, null);
  assert.match(h.statuses.at(-1)[1], /Turn:\S* \S*TTFT\S* \S*16\.0s\S* \S*TPS\S* \S*43\.7 e2e\S* \S*•/);
  // A genuinely streamed short reply (11 tokens over 100 ms = 100 tok/s) keeps the events formula.
  const h2 = harness(t);
  h2.begin(1000);
  h2.update(2000, 'text_delta');
  h2.update(2100, 'text_delta');
  h2.finish(2100, 11);
  const r2 = h2.records().find(r => r.type === 'request');
  assert.deepEqual([r2.buffered, r2.tpsSource, Math.round(r2.decodeTps)], [false, 'events', 100]);
});

test('a request delivered 3x faster than the model\'s running median is treated as buffered', (t) => {
  const h = harness(t);
  // Four honest requests at 100 tok/s establish the median (101 tokens over 1 s after a 1 s TTFT).
  for (let i = 0; i < 4; i++) {
    h.begin(10000 * i);
    h.update(10000 * i + 1000, 'text_delta');
    h.update(10000 * i + 2000, 'text_delta');
    h.finish(10000 * i + 2000, 101);
  }
  // Proxy holds the fifth response for 15 s, then drains 945 tokens in 1.4 s (674 tok/s).
  h.begin(50000);
  h.update(65300, 'text_delta');
  h.update(66700, 'text_delta');
  h.finish(66700, 945);
  // A model that genuinely streams at 300 tok/s is not flagged once it has its own samples.
  for (let i = 0; i < 4; i++) {
    h.begin(70000 + 10000 * i);
    h.update(70000 + 10000 * i + 1000, 'text_delta');
    h.update(70000 + 10000 * i + 2000, 'text_delta');
    h.finish(70000 + 10000 * i + 2000, 301, 'fast-model');
  }
  const rs = h.records().filter(r => r.type === 'request');
  assert.deepEqual(rs.slice(0, 4).map(r => [r.buffered, Math.round(r.decodeTps)]), Array(4).fill([false, 100]));
  assert.deepEqual([rs[4].buffered, rs[4].tpsSource, Math.round(rs[4].effectiveTps)], [true, 'e2e', Math.round(945 / 16.7)]);
  assert.match(h.statuses[4][1], /Turn:\S* \S*TTFT\S* \S*15\.3s\S* \S*TPS\S* \S*56\.6 e2e\S* \S*•/); // buffered request has no trusted decode
  assert.deepEqual(rs.slice(5).map(r => [r.buffered, Math.round(r.decodeTps)]), Array(4).fill([false, 300]));
});

test('gateway sent-at anchors the decode window when a downstream proxy holds the stream', (t) => {
  const h = harness(t);
  // Gateway accepted at 1000, forwarded the first token at 2000 (server TTFT 1 s). A proxy held the
  // stream: our headers and 201 tokens all arrived between 12000 and 12100.
  h.emit(1000, 'turn_start', { turnIndex: 0, timestamp: 1000 });
  h.emit(1000, 'before_provider_request', { payload: {} });
  h.emit(12000, 'after_provider_response', { status: 200, headers: {
    'x-request-id': 'srv', 'x-gateway-received-at': '1000', 'x-gateway-sent-at': '2000' } });
  h.update(12000, 'text_delta');
  h.update(12100, 'text_delta');
  h.finish(12100, 201);
  const r = h.records().find(r => r.type === 'request');
  // Decode window is 2000 -> 12100 = 10.1 s, not the 100 ms delta interval.
  assert.deepEqual([r.tpsSource, r.buffered, r.anchoredSec, r.serverTtftSec, r.headerDelaySec], ['anchored', false, 10.1, 1, 10]);
  assert.ok(Math.abs(r.decodeTps - 200 / 10.1) < 1e-9);
  assert.match(h.statuses.at(-1)[1], /Turn:\S* \S*TTFT\S* \S*11\.0s\S* \S*TPS\S* \S*19\.8\S* \S*•/);

  // A sent-at outside our request window (clock skew or a stale header) is ignored.
  const h2 = harness(t);
  h2.emit(1000, 'turn_start', { turnIndex: 0, timestamp: 1000 });
  h2.emit(1000, 'before_provider_request', { payload: {} });
  h2.emit(1050, 'after_provider_response', { status: 200, headers: { 'x-edge-sent-at': '500' } });
  h2.update(1100, 'text_delta');
  h2.update(1500, 'text_delta');
  h2.finish(1500, 101);
  const r2 = h2.records().find(r => r.type === 'request');
  assert.deepEqual([r2.tpsSource, r2.anchoredSec, r2.serverTtftSec, r2.decodeTps], ['events', null, null, 250]);
});

test('an aborted attempt is recorded but does not take over the footer or session sums', (t) => {
  const h = harness(t);
  h.begin(1000);
  h.update(1100, 'text_delta');
  h.update(1500, 'text_delta');
  h.finish(1500, 100);
  const before = h.statuses.at(-1);
  // Pi aborts a hung attempt: no response headers, no deltas, usage all zero.
  h.emit(2000, 'turn_start', { turnIndex: 1, timestamp: 2000 });
  h.emit(2000, 'before_provider_request', { payload: {} });
  h.emit(13000, 'message_end', { message: { role: 'assistant', stopReason: 'aborted', errorMessage: 'Operation aborted', usage: { input: 0, output: 0 } } });
  const aborted = h.records().filter(r => r.type === 'request').at(-1);
  assert.deepEqual([aborted.output, aborted.stopReason, aborted.errorMessage, aborted.responseStatus, aborted.tpsSource], [0, 'aborted', 'Operation aborted', null, null]);
  assert.deepEqual(h.statuses.at(-1), before);
  assert.deepEqual(h.statuses.at(-1), ['perf', styledFooter('0.1s', '247.5', '0.1s', '247.5')]);
});

test('turn decode totals follow server timing; zero-output usage never yields negative rates', (t) => {
  const h = harness(t);
  h.emit(1000, 'agent_start');
  h.begin(1000, 0, { 'server-timing': 'llm-decode;dur=250' });
  h.update(1100, 'text_delta');
  h.update(1500, 'text_delta');
  h.finish(1500, 100);
  h.begin(2000, 1);
  h.update(2100, 'text_delta');
  h.update(2500, 'text_delta');
  h.finish(2500, 0); // aborted stream, usage never arrived
  h.emit(3000, 'agent_end');
  const [server, aborted] = h.records().filter(r => r.type === 'request');
  assert.deepEqual([server.tpsSource, server.decodeTps, server.metricSec], ['server', 400, 0.25]);
  assert.deepEqual([aborted.decodeTps, aborted.streamDecodeTps, aborted.effectiveTps, aborted.tpsSource], [null, null, null, null]);
  const turn = h.records().find(r => r.type === 'turn');
  assert.deepEqual([turn.decodeSec, turn.decodeTokens, turn.decodeTps, turn.streamDecodeTps], [0.25, 100, 400, 400]);
});

test('generic server timing headers override event decode and suffix request IDs', (t) => {
  const h = harness(t);
  h.begin(1000, 0, { 'Server-Timing': 'llm-decode;dur=250', 'x-acme-request-id': 'acme-request' });
  h.update(1100, 'text_delta');
  h.update(1500, 'text_delta');
  h.finish(1600, 100);
  const r = h.records().find(r => r.type === 'request');
  assert.equal(r.responseAttempts[0].serverDecodeMs, 250);
  assert.equal(r.requestId, 'acme-request');
  assert.equal(r.decodeTps, 400);
  assert.equal(r.effectiveTps, 400);
  assert.equal(r.tpsSource, 'server');
  assert.deepEqual([r.metricTokens, r.metricSec], [100, 0.25]);
});

test('Server-Timing parsing respects quoted strings and explicit token metrics', (t) => {
  const h = harness(t);
  h.begin(1000, 0, { 'Server-Timing': 'llm-decode;dur="250"' });
  h.update(1100, 'text_delta');
  h.update(1500, 'text_delta');
  h.finish(1600, 100);
  const valid = h.records().find(r => r.type === 'request');
  assert.equal(valid.responseAttempts[0].serverDecodeMs, 250);
  assert.equal(valid.tpsSource, 'server');
  assert.equal(valid.effectiveTps, 400);
});

test('unrelated or quoted Server-Timing metrics do not override observed decode', (t) => {
  const h = harness(t);
  h.begin(1000, 0, { 'Server-Timing': 'image-decode;dur=1, cache;desc="hit, llm-decode;dur=1;ignored=x"' });
  h.update(1100, 'text_delta');
  h.update(1500, 'text_delta');
  h.finish(1600, 100);
  const r = h.records().find(r => r.type === 'request');
  assert.equal(r.responseAttempts[0].serverDecodeMs, null);
  assert.equal(r.tpsSource, 'events');
  assert.equal(r.effectiveTps, 247.5);
});

test('session_tree restores metrics from the newly selected branch', (t) => {
  const h = harness(t, { envLog: false, sessionEntries: [] });
  h.sessionEntries.push(
    { id: 'old-request', parentId: null, type: 'custom', customType: 'perf_request', data: { turn: 0, output: 10, sec: 1, ttftSec: 0.5, deltas: 2 } },
  );
  h.emit(1000, 'session_start', { reason: 'reload' });
  assert.deepEqual(h.statuses.at(-1), ['perf', styledFooter('0.5s', '18.0', '0.5s', '18.0')]);
  h.sessionEntries.length = 0;
  h.sessionEntries.push(
    { id: 'new-request', parentId: null, type: 'custom', customType: 'perf_request', data: { turn: 0, output: 20, sec: 2, ttftSec: 1, deltas: 2 } },
  );
  h.emit(2000, 'session_tree', { newLeafId: 'new-request', oldLeafId: 'old-request' });
  assert.deepEqual(h.statuses.at(-1), ['perf', styledFooter('1.0s', '19.0', '1.0s', '19.0')]);
});

test('agent_end updates the footer without notifying the main chat window', (t) => {
  const h = harness(t);
  h.emit(1000, 'agent_start');
  h.begin(1000);
  h.update(1100, 'text_delta');
  h.finish(1200);
  h.emit(1300, 'agent_end');
  assert.equal(h.notifications.length, 0);
  assert.equal(h.statuses.length, 1);
});

test('footer aggregates session TTFT and decode TPS across requests', (t) => {
  const h = harness(t);
  h.begin(1000);
  h.update(1100, 'text_delta');
  h.update(1500, 'text_delta');
  h.finish(1600, 100);
  h.begin(2000, 1);
  h.update(2200, 'text_delta');
  h.update(2700, 'text_delta');
  h.finish(2800, 51);
  // Turn: 51 tokens over 0.7 s e2e, 50 over 0.5 s decode. Session: 151/1.2 s e2e, 149/0.9 s decode.
  assert.deepEqual(h.statuses.at(-1), ['perf', styledFooter('0.2s', '100.0', '0.2s', '165.6')]);
});

test('tool execution excluded, follow-up request resets timing, turn sums requests', (t) => {
  const h = harness(t);
  h.emit(1000, 'agent_start');
  h.begin(1000);
  h.update(1100, 'toolcall_delta');
  h.update(1500, 'toolcall_delta');
  h.finish(1600);
  h.emit(1700, 'tool_execution_start');
  h.emit(1800, 'ui_prompt_start', { reason: 'ui_prompt', kind: 'confirm' });
  h.emit(5800, 'ui_prompt_end', { reason: 'ui_prompt', kind: 'confirm' });
  h.emit(5900, 'tool_execution_end');
  h.begin(6000, 1);
  h.update(6100, 'text_delta');
  h.update(6500, 'text_delta');
  h.finish(6600);
  h.emit(7000, 'agent_end');
  const requests = h.records().filter(r => r.type === 'request');
  assert.deepEqual(requests.map(r => [r.turn, r.sec, r.ttftSec, r.eventItlMs, r.deltas]),
    [[0, 0.5, 0.1, 400, 2], [1, 0.5, 0.1, 400, 2]]);
  assert.deepEqual(requests.map(r => r.requestId), ['server-0', 'server-1']);
  const turn = h.records().find(r => r.type === 'turn');
  assert.deepEqual([turn.reqs, turn.output, turn.streamSec, turn.wallSec, turn.activeWallSec, turn.userWaitSec, turn.tps, turn.activeWallTps, turn.wallTps, turn.decodeTps, turn.streamDecodeTps],
    [2, 200, 1, 6, 2, 4, 200, 100, 100/3, 247.5, 250]);
});

test('JSONL export is disabled by default', (t) => {
  const h = harness(t, { envLog: false });
  h.begin(1000);
  h.update(1100, 'text_delta');
  h.finish(1200);
  assert.equal(existsSync(h.log), false);
  assert.equal(h.records().length, 0);
  assert.equal(h.entries.filter(e => e.customType === 'perf_request').length, 1);
});

test('settings enable metrics-only export by default', (t) => {
  const h = harness(t, {
    envLog: false,
    settings: { piPerf: { log: { enabled: true, path: '../metrics.jsonl' } } },
  });
  h.emit(900, 'before_agent_start', { prompt: 'hello' });
  h.begin(1000);
  h.update(1100, 'text_delta');
  h.finish(1200);
  assert.deepEqual(h.records().map(r => r.type), ['request']);
});

test('trusted project settings override global settings; untrusted settings are ignored', (t) => {
  const trusted = harness(t, {
    envLog: false,
    settings: { piPerf: { log: { enabled: false } } },
    projectTrusted: true,
    projectSettings: { piPerf: { log: { enabled: true, path: 'trusted.jsonl' } } },
  });
  trusted.begin(1000);
  trusted.update(1100, 'text_delta');
  trusted.finish(1200);
  assert.equal(existsSync(join(trusted.dir, 'project/.pi/trusted.jsonl')), true);

  const untrusted = harness(t, {
    envLog: false,
    projectTrusted: false,
    projectSettings: { piPerf: { log: { enabled: true, path: 'untrusted.jsonl' } } },
  });
  untrusted.begin(1000);
  untrusted.update(1100, 'text_delta');
  untrusted.finish(1200);
  assert.equal(existsSync(join(untrusted.dir, 'project/.pi/untrusted.jsonl')), false);
});

test('settings enable export and log every payload when requested', (t) => {
  const h = harness(t, {
    envLog: false,
    settings: { piPerf: { log: { enabled: true, path: '../metrics.jsonl', includePayloads: true } } },
  });
  h.emit(900, 'before_agent_start', { prompt: 'hello' });
  h.begin(1000);
  h.update(1100, 'text_delta');
  h.finish(1200);
  h.begin(2000, 1);
  h.update(2100, 'toolcall_delta');
  h.finish(2200);
  const records = h.records();
  assert.equal(records.filter(r => r.type === 'provider_request').length, 2);
  assert.equal(records.filter(r => r.type === 'request').length, 2);
  assert.equal(records.filter(r => r.type === 'system_prompt').length, 1);
});

test('reload restores active-branch metrics and footer from persisted session entries', async (t) => {
  const h = harness(t, {
    envLog: false,
    sessionEntries: [
      { id: 'request', parentId: null, type: 'custom', customType: 'perf_request', data: {
        turn: 0, input: 20, cacheRead: 10, output: 100, sec: 0.5, ttftSec: 0.1, eventItlMs: 200, deltas: 3, decodeTps: 247.5,
      } },
      { id: 'turn', parentId: 'request', type: 'custom', customType: 'perf_turn', data: {
        reqs: 1, output: 100, streamSec: 0.5, wallSec: 1, tps: 200,
      } },
    ],
  });
  h.emit(1000, 'session_start', { reason: 'reload' });
  assert.deepEqual(h.statuses.at(-1), ['perf', styledFooter('0.1s', '247.5', '0.1s', '247.5')]);
  await h.report();
  assert.match(h.notifications.at(-1), /100 tok out/);
  assert.match(h.notifications.at(-1), /1\.0s active wall \(\+0\.0s user wait\)/);
});
