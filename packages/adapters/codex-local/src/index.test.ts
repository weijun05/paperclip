import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_LOCAL_MODEL,
  isCodexLocalFastModeSupported,
  models,
  normalizeCodexModel,
} from "./index.js";

describe("codex local adapter metadata", () => {
  it("advertises current GPT-5.6 Codex-capable OpenAI models by default", () => {
    const modelIds = models.map((model) => model.id);

    // Default to the concrete gpt-5.6-sol slug — Codex ships no metadata for the bare gpt-5.6
    // alias, so it must not be advertised or used as the default (it triggers a fallback warning).
    expect(DEFAULT_CODEX_LOCAL_MODEL).toBe("gpt-5.6-sol");
    expect(modelIds.slice(0, 3)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(modelIds).not.toContain("gpt-5.6");
    expect(isCodexLocalFastModeSupported(DEFAULT_CODEX_LOCAL_MODEL)).toBe(true);
    expect(modelIds).not.toContain("gpt-5.3-codex");
    // gpt-5.3-codex-spark is advertised: Codex ships it and it was previously reachable
    // only by typing the slug manually. Fast mode must stay available for it, which for a
    // known model means membership of CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS.
    expect(modelIds).toContain("gpt-5.3-codex-spark");
    expect(isCodexLocalFastModeSupported("gpt-5.3-codex-spark")).toBe(true);
  });

  it("normalizes the legacy bare gpt-5.6 alias to the concrete gpt-5.6-sol slug", () => {
    expect(normalizeCodexModel("gpt-5.6")).toBe("gpt-5.6-sol");
    expect(normalizeCodexModel("  gpt-5.6  ")).toBe("gpt-5.6-sol");
    // Concrete slugs and unknown/manual model IDs pass through untouched.
    expect(normalizeCodexModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(normalizeCodexModel("gpt-5.5")).toBe("gpt-5.5");
    expect(normalizeCodexModel("future-model")).toBe("future-model");
    expect(normalizeCodexModel("")).toBe("");
    expect(normalizeCodexModel(null)).toBe("");
  });
});
