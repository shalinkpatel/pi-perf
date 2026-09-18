// Runs the extension directly: no Pi process, skills, model calls, or network.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { default: install } = await import(new URL('../extensions/pi-perf/index.ts', import.meta.url));

const styledFooter = (turnTtft, turnTps, sessionTtft, sessionTps) =>
  `[dim]Turn TTFT:[/dim] [accent]${turnTtft}[/accent] [dim]•[/dim] ` +
  `[dim]Turn TPS:[/dim] [success]${turnTps}[/success] [dim]•[/dim] ` +
  `[dim]Session TTFT:[/dim] [accent]${sessionTtft}[/accent] [dim]•[/dim] ` +
  `[dim]Session TPS:[/dim] [success]${sessionTps}[/success]`;

function harness(t, options = {}) {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => now);
  const dir = mkdtempSync(join(tmpdir(), 'pi-tps-test-'));
  const agentDir = join(dir, 'agent');
  const cwd = join(dir, 'project');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const previous = {
    perfLog: process.env.PI_PERF_LOG,
    perfPayloads: process.env.PI_PERF_LOG_PAYLOADS,
    log: process.env.PI_TPS_LOG,
    payloads: process.env.PI_TPS_LOG_PAYLOADS,
    agentDir: process.env.PI_CODING_AGENT_DIR,
  };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const log = join(dir, 'metrics.jsonl');
  delete process.env.PI_TPS_LOG;
  delete process.env.PI_TPS_LOG_PAYLOADS;
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
    for (const [key, value] of [['PI_PERF_LOG', previous.perfLog], ['PI_PERF_LOG_PAYLOADS', previous.perfPayloads], ['PI_TPS_LOG', previous.log], ['PI_TPS_LOG_PAYLOADS', previous.payloads], ['PI_CODING_AGENT_DIR', previous.agentDir]]) {
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
      getLeafId: () => sessionEntries.at(-1)?.id ?? null,
      getEntry: (id) => sessionEntries.find(entry => entry.id === id),
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
  const begin = (at, turnIndex = 0) => {
    emit(at, 'turn_start', { turnIndex, timestamp: at });
    emit(at, 'before_provider_request', { payload: { turn: turnIndex } });
    emit(at, 'before_provider_headers', { headers: { 'X-Request-ID': `client-${turnIndex}`, 'X-Correlation-ID': `client-corr-${turnIndex}` } });
    emit(at + 50, 'after_provider_response', { status: 200, headers: { 'x-request-id': `server-${turnIndex}`, 'x-correlation-id': `corr-${turnIndex}` } });
  };
  const finish = (at, output = 100) => emit(at, 'message_end', {
    message: { role: 'assistant', usage: { input: 20, cacheRead: 10, output } },
  });
  return {
    dir, log, emit, update, begin, finish, entries, notifications, statuses,
    records: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [],
    report: () => commands.get('perf').handler('', ctx),
    hasCommand: (name) => commands.has(name),
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
    assert.equal(r.clientRequestId, 'client-0');
    assert.equal(r.requestId, 'server-0');
    assert.equal(r.correlationId, 'corr-0');
    assert.equal(r.responseStatus, 200);
    assert.equal(r.responseAttempts.length, 1);
    const persisted = h.entries.find(e => e.customType === 'perf_request').data;
    for (const key of ['sec', 'ttftSec', 'eventItlMs', 'deltas', 'output', 'streamDecodeTps', 'requestId']) assert.equal(persisted[key], r[key]);
    const turn = h.records().find(r => r.type === 'turn');
    assert.deepEqual([turn.reqs, turn.output, turn.streamSec, turn.wallSec, turn.activeWallSec, turn.userWaitSec, turn.tps, turn.activeWallTps, turn.wallTps, turn.decodeTps, turn.streamDecodeTps], [1, 100, 0.5, 1, 1, 0, 200, 100, 100, 247.5, 250]);
    assert.deepEqual(h.statuses.at(-1), ['perf', styledFooter('0.100 s', '247.5', '0.100 s', '247.5')]);
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
  assert.deepEqual(h.statuses.at(-1), ['perf', styledFooter('0.200 s', '100.0', '0.150 s', '165.6')]);
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
    settings: { tps: { log: { enabled: false } } },
    projectTrusted: true,
    projectSettings: { tps: { log: { enabled: true, path: 'trusted.jsonl' } } },
  });
  trusted.begin(1000);
  trusted.update(1100, 'text_delta');
  trusted.finish(1200);
  assert.equal(existsSync(join(trusted.dir, 'project/.pi/trusted.jsonl')), true);

  const untrusted = harness(t, {
    envLog: false,
    projectTrusted: false,
    projectSettings: { tps: { log: { enabled: true, path: 'untrusted.jsonl' } } },
  });
  untrusted.begin(1000);
  untrusted.update(1100, 'text_delta');
  untrusted.finish(1200);
  assert.equal(existsSync(join(untrusted.dir, 'project/.pi/untrusted.jsonl')), false);
});

test('settings enable export and log every payload when requested', (t) => {
  const h = harness(t, {
    envLog: false,
    settings: { tps: { log: { enabled: true, path: '../metrics.jsonl', includePayloads: true } } },
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

test('reload restores active-branch metrics and footer from legacy session entries', async (t) => {
  const h = harness(t, {
    envLog: false,
    sessionEntries: [
      { id: 'request', parentId: null, type: 'custom', customType: 'tps_request', data: {
        turn: 0, input: 20, cacheRead: 10, output: 100, sec: 0.5, ttftSec: 0.1, itlMs: 200, deltas: 3, decodeTps: 247.5,
      } },
      { id: 'turn', parentId: 'request', type: 'custom', customType: 'tps_turn', data: {
        reqs: 1, output: 100, streamSec: 0.5, wallSec: 1, tps: 200,
      } },
    ],
  });
  h.emit(1000, 'session_start', { reason: 'reload' });
  assert.deepEqual(h.statuses.at(-1), ['perf', styledFooter('0.100 s', '247.5', '0.100 s', '247.5')]);
  await h.report();
  assert.match(h.notifications.at(-1), /100 tok out/);
  assert.match(h.notifications.at(-1), /1\.0s active wall \(\+0\.0s user wait\)/);
});
