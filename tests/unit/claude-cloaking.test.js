/**
 * Regression: Claude passthrough streaming leaked cloaked tool names to clients.
 *
 * Symptom seen by Claude Code / OpenClaw users:
 *   "I can't use the tool 'exec_ide' here because it isn't available.
 *    I need to stop retrying it and answer without that tool."
 *   (Also seen as web_search_ide, read_ide, write_ide, etc.)
 *
 * Why it happened: 9router cloaks client tool names with a _ide suffix on the
 * request path (anti-ban against the upstream provider), then is supposed to
 * strip the suffix on the response path. For Claude /v1/messages passthrough,
 * the strip never ran — upstream `content_block_start` events containing
 * `"name":"read_ide"` reached the client unchanged, and the model's own tool
 * registry has no `read_ide`, so it refused to invoke them.
 *
 * Contract under test: given a `toolNameMap` of cloaked → original names, the
 * SSE pipeline MUST NOT emit any cloaked name to the client — regardless of
 * whether the event is processed on the transform path or stranded in the
 * flush buffer at end-of-stream.
 */

import { describe, it, expect, vi } from "vitest";

// Stub the usage DB so stream.js can load without touching sqlite.
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestUsage: vi.fn(),
}));

const { createPassthroughStreamWithLogger } = await import("open-sse/utils/stream.js");
const { FORMATS } = await import("open-sse/translator/formats.js");
const { decloakToolNames } = await import("open-sse/utils/claudeCloaking.js");

async function runStream(stream, inputs) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  const chunks = [];
  const readAll = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }
  })();

  for (const input of inputs) await writer.write(encoder.encode(input));
  await writer.close();
  await readAll;

  return chunks.join("");
}

describe("Claude passthrough cloak/decloak symmetry", () => {
  it("does not leak *_ide tool names when a content_block_start lands in the flush buffer", async () => {
    // Map cloaked → original. This mirrors what cloakClaudeTools() builds.
    const toolNameMap = new Map([
      ["read_ide", "read"],
      ["exec_ide", "exec"],
      ["web_search_ide", "web_search"],
    ]);

    // Upstream SSE: event: line is newline-terminated, but the data: line is NOT.
    // The data: line therefore sits in the transform's internal buffer until
    // the writer closes, at which point the flush handler must decloak it.
    const event =
      "event: content_block_start\n" +
      'data: {"type":"content_block_start","index":0,' +
      '"content_block":{"type":"tool_use","id":"toolu_01","name":"read_ide","input":{}}}';

    // Public wrapper signature:
    //   createPassthroughStreamWithLogger(
    //     provider, reqLogger, model, connectionId, body,
    //     onStreamComplete, apiKey, sourceFormat, toolNameMap
    //   )
    // sourceFormat + toolNameMap are the new tail params — the fix must
    // thread them through so passthrough mode can decloak Claude events.
    const stream = createPassthroughStreamWithLogger(
      null, null, null, null, null, null, null,
      FORMATS.CLAUDE, toolNameMap,
    );

    const output = await runStream(stream, [event]);

    // Invariant: no cloaked name ever reaches the client.
    expect(output).not.toMatch(/_ide/);
    // And the real tool name IS present.
    expect(output).toContain('"name":"read"');
  });

  it("decloaks non-streaming Claude response bodies (content[] with tool_use)", () => {
    // Non-streaming /v1/messages returns a full message object with content[].
    // Same cloak→decloak invariant must hold: nonStreamingHandler.js passes
    // this body through decloakToolNames before the Response is sent, so the
    // single walker has to cover this shape too.
    const toolNameMap = new Map([
      ["read_ide", "read"],
      ["exec_ide", "exec"],
    ]);

    const body = {
      id: "msg_01",
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "I'll look at the file." },
        { type: "tool_use", id: "toolu_01", name: "read_ide", input: { path: "/tmp/x" } },
        { type: "tool_use", id: "toolu_02", name: "exec_ide", input: { cmd: "ls" } },
      ],
      stop_reason: "tool_use",
    };

    const result = decloakToolNames(body, toolNameMap);

    expect(result.content[1].name).toBe("read");
    expect(result.content[2].name).toBe("exec");
    expect(JSON.stringify(result)).not.toMatch(/_ide/);
  });
});
