# pi-perf

`pi-perf` measures Pi request and turn performance without changing provider traffic.

It records request latency, TTFT, token usage, request/correlation IDs, turn timing, and both AIPerf-style and stream-style decode rates. The footer shows the latest request and session aggregates; `/perf` shows the full in-memory report.

## Install

From this repository checkout:

```bash
pi install /path/to/pi-perf
```

From GitHub (tracks the default branch; append `@v0.1.0` to pin a tag):

```bash
pi install git:github.com/shalinkpatel/pi-perf
```

Then restart Pi. The footer shows TTFT and TPS for the latest request and the session after the first request; `/perf` prints the detailed report. Remove with `pi remove git:github.com/shalinkpatel/pi-perf`.

For a temporary trial without changing settings:

```bash
pi -e git:github.com/shalinkpatel/pi-perf
# or a local checkout
pi -e /path/to/pi-perf
```

Requirements: Pi with extension support (`@earendil-works/pi-coding-agent`), Node 20+ for `npm test`. No runtime dependencies.

## Use

```text
/perf
```

The footer shows latest-request TTFT/TPS plus session mean TTFT and aggregate TPS:

```text
Turn: TTFT 4.1s TPS 112.2 • Session: TTFT 5.6s TPS 156.3
```

Turn is the latest request; Session is the mean TTFT and aggregate decode TPS across the session.

The footer reflects the latest request that produced tokens; an aborted or errored attempt is recorded (with `stopReason` and `errorMessage`) but does not replace the reading or count toward session sums. Footer TPS is decode TPS from a trustworthy timing source (see priority below) and reads `-` when there is none for that request, for example a stream that a proxy held and released in a burst. End-to-end TPS (server-reported output tokens / request latency including TTFT) is in every record and in `/perf`; it cannot be inflated by buffering, so a wide gap between it and decode TPS means something between Pi and the model is holding the stream. Labels are dim, TTFT values use the accent color, and TPS values use the success color. The footer updates after each request, when `/perf` runs, and after reload or `/tree` navigation. Automatic turn metrics do not appear in the main chat window; `/perf` is the explicit detailed report.

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

There is no `/tps` command alias.

## Timing definitions

- Request latency: immediately before provider dispatch to last observed generated output.
- TTFT: request start to first generated text, thinking, or tool-argument event.
- TPS in `/perf`: server-reported output tokens / request latency, including TTFT.
- Footer decode TPS, in priority order: provider `Server-Timing` decode metrics; a gateway's `*-sent-at` epoch header to the last delta on our clock (`tpsSource: anchored`, accepted only when the header falls inside our own request window so clock skew is bounded by a round trip); AIPerf-style event decode `(output - 1) / (latency - TTFT)`. `-` for buffered or single-event responses.
- Response headers are matched by suffix, case-insensitively, so any gateway prefix works: `*-request-id`, `*-correlation-id`, `*-received-at` or `*-accepted-at` (epoch ms), `*-sent-at` (epoch ms), plus the `Server-Timing` names below. Nothing vendor-specific is assumed.
- `serverTtftSec`: `sent-at - received-at` from gateway headers, the server-side time to first token. `headerDelaySec`: how long after `sent-at` the response headers reached us; anything beyond network latency is a proxy holding the stream. `anchoredSec`: the sent-at-to-last-delta window. Session decode excludes requests without a trustworthy decode source.
- Provider-reported timing is extracted only from explicit token-generation names, such as `Server-Timing: llm-decode;dur=...` or headers ending in `llm-decode-duration-ms` / `llm-decode-tps`. Equivalent `model-decode` and `token-generation` names are accepted. Ambiguous names such as `image-decode` are ignored.
- `decodeTps`: server-reported decode TPS when available, otherwise AIPerf-style event decode. Null when the event interval implies more than 1,000 tok/s, or more than 2.5x the running median for that model once it has three samples; both mean a proxy held the response and released it compressed, so the interval measured delivery, not decode (this produced the 40,000 tok/s and the 3-6x-too-high footer readings). Such records carry `buffered: true` and fall back to end-to-end TPS. Turn and session decode totals use the same server/events selection as the request and skip e2e fallbacks.
- Stream decode TPS: `output / (latency - TTFT)`, the same window without AIPerf's N-1 correction; some serving dashboards use this convention.
- Turn stream time: sum of provider request latencies.
- Active turn wall: agent wall time including tools, excluding blocking user-input prompts.
- Total turn wall: active wall plus user-input wait.

## Development

```bash
npm test
```

The test suite runs the extension directly with a mocked Pi event surface. It requires no model calls or network access.
