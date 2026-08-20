import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("uses safe defaults", () => {
    expect(parseConfig({})).toEqual({
      config: {
        maxAgents: 12,
        maxConcurrency: 12,
        maxDepth: 3,
        cancelGraceMs: 5000,
      },
      diagnostics: [],
    });
  });

  it("rejects malformed and non-positive integers with visible effective values", () => {
    const result = parseConfig({
      PI_SUB_MAX_AGENTS: "4.5",
      PI_SUB_MAX_CONCURRENCY: "0",
      PI_SUB_MAX_DEPTH: "-1",
      PI_SUB_CANCEL_GRACE_MS: " 250 ",
    });

    expect(result.config).toMatchObject({
      maxAgents: 12,
      maxConcurrency: 12,
      maxDepth: 3,
      cancelGraceMs: 5000,
    });
    expect(result.diagnostics).toEqual([
      "PI_SUB_MAX_AGENTS must be a positive base-ten integer; using 12.",
      "PI_SUB_MAX_CONCURRENCY must be a positive base-ten integer; using 12.",
      "PI_SUB_MAX_DEPTH must be a positive base-ten integer; using 3.",
      "PI_SUB_CANCEL_GRACE_MS must be a positive base-ten integer; using 5000.",
    ]);
  });

  it("clamps concurrency to the live-agent limit and depth to its hard ceiling", () => {
    const result = parseConfig({
      PI_SUB_MAX_AGENTS: "8",
      PI_SUB_MAX_CONCURRENCY: "20",
      PI_SUB_MAX_DEPTH: "9",
    });

    expect(result.config).toMatchObject({ maxAgents: 8, maxConcurrency: 8, maxDepth: 3 });
    expect(result.diagnostics).toEqual([
      "PI_SUB_MAX_CONCURRENCY cannot exceed PI_SUB_MAX_AGENTS; using 8.",
      "PI_SUB_MAX_DEPTH cannot exceed 3; using 3.",
    ]);
  });

  it("preserves a configured socket parent directory", () => {
    expect(parseConfig({ PI_SUB_SOCKET_DIR: "/tmp/pi-sub" }).config.socketDir).toBe("/tmp/pi-sub");
  });
});
