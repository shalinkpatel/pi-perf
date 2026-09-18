# pi-perf

`pi-perf` measures Pi request and turn performance without changing provider traffic.

It records request latency, TTFT, token usage, request/correlation IDs, turn timing, and both AIPerf-style and stream-style decode rates. The footer shows the latest request and session aggregates; `/perf` shows the full in-memory report.

## Install

From this repository checkout:

```bash
pi install /path/to/pi-perf
```

From git after pushing it somewhere:

```bash
pi install git:github.com/<you>/pi-perf@v0.1.0
```

For a temporary trial without changing settings:

```bash
pi -e /path/to/pi-perf
```

## Use

```text
/perf
```

The footer shows latest-request TTFT/TPS plus session mean TTFT and aggregate TPS:

```text
Turn TTFT: 0.100 s • Turn TPS: 247.5 • Session TTFT: 0.150 s • Session TPS: 165.6
```

Footer TPS uses the AIPerf decode measurement, `(output - 1) / (latency - TTFT)`; the label omits “decode” for brevity. Labels are dim, TTFT values use the accent color, and TPS values use the success color. The footer updates after each request, when `/perf` runs, and after reload from persisted session entries.

JSONL export is disabled by default.

## Optional JSONL export

Global settings (`~/.pi/agent/settings.json`):

```json
{
  "piPerf": {
    "log": {
      "enabled": true,
      "path": "pi-perf.jsonl",
      "includePayloads": false
    }
  }
}
```

Relative paths in global settings resolve under `~/.pi/agent`. A trusted project can override the same section in `.pi/settings.json`; relative project paths resolve under `.pi`.

Set `includePayloads: true` to additionally export every provider payload and the system prompt. Leave it false for metrics-only logging.

Per-process overrides:

```bash
PI_PERF_LOG=/tmp/pi-perf.jsonl pi
PI_PERF_LOG=/tmp/pi-perf.jsonl PI_PERF_LOG_PAYLOADS=0 pi
```

Legacy `PI_TPS_LOG`, `PI_TPS_LOG_PAYLOADS`, and the `tps.log` settings section remain supported. There is no `/tps` command alias.

## Timing definitions

- Request latency: immediately before provider dispatch to last observed generated output.
- TTFT: request start to first generated text, thinking, or tool-argument event.
- TPS in `/perf`: server-reported output tokens / request latency, including TTFT.
- Footer TPS and `decodeTps`: AIPerf-style `(output - 1) / (latency - TTFT)`.
- Stream decode TPS: `output / (latency - TTFT)`, matching the Grafana board's stream convention.
- Turn stream time: sum of provider request latencies.
- Active turn wall: agent wall time including tools, excluding blocking user-input prompts.
- Total turn wall: active wall plus user-input wait.

## Development

```bash
npm test
```

The test suite runs the extension directly with a mocked Pi event surface. It requires no model calls or network access.
