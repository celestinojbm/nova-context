import type { ParsedIntent } from "@nova/schema";
import { describe, expect, it } from "vitest";
import { IntentRouter } from "./intent/router.js";
import { TranscriptionRouter } from "./transcription/router.js";
import {
  TranscriptionUnavailableError,
  type IntentProvider,
  type TranscriptionProvider,
} from "./types.js";

const fakeIntent: ParsedIntent = {
  action_type: "create_task",
  project_hint: "acme",
  summary: "Follow up with Acme",
  priority_guess: "normal",
  confidence: 0.95,
  parser: "llm",
  model: "fake-model",
};

function workingProvider(name: string): IntentProvider {
  return {
    name,
    parseIntent: () => Promise.resolve({ ...fakeIntent, model: name }),
  };
}

function failingProvider(name: string): IntentProvider {
  return {
    name,
    parseIntent: () => Promise.reject(new Error(`${name} is down`)),
  };
}

describe("IntentRouter fallback", () => {
  it("uses the primary provider when it succeeds", async () => {
    const router = new IntentRouter([workingProvider("primary")]);
    const result = await router.parse({ text: "create a task" });
    expect(result.provider).toBe("primary");
    expect(result.failures).toEqual([]);
  });

  it("falls back to the secondary on a forced primary failure", async () => {
    const router = new IntentRouter([
      failingProvider("primary"),
      workingProvider("secondary"),
    ]);
    const result = await router.parse({ text: "create a task" });
    expect(result.provider).toBe("secondary");
    expect(result.failures).toEqual([
      { provider: "primary", error: "primary is down" },
    ]);
  });

  it("falls back to the heuristic when every LLM provider fails", async () => {
    const router = new IntentRouter([
      failingProvider("primary"),
      failingProvider("secondary"),
    ]);
    const result = await router.parse({
      text: "create a task to review this for the pricing project",
    });
    expect(result.provider).toBe("heuristic");
    expect(result.intent.action_type).toBe("create_task");
    expect(result.intent.project_hint).toBe("pricing");
    expect(result.failures).toHaveLength(2);
  });

  it("always includes the heuristic as the terminal provider", () => {
    expect(new IntentRouter([]).providers).toEqual(["heuristic"]);
    expect(new IntentRouter([workingProvider("a")]).providers).toEqual([
      "a",
      "heuristic",
    ]);
  });
});

describe("TranscriptionRouter", () => {
  const audio = {
    data: Buffer.from("fake"),
    mimeType: "audio/webm",
    filename: "voice.webm",
  };

  it("reports unavailable when no provider is configured", async () => {
    const router = new TranscriptionRouter([]);
    expect(router.available).toBe(false);
    await expect(router.transcribe(audio)).rejects.toBeInstanceOf(
      TranscriptionUnavailableError,
    );
  });

  it("falls back across providers and surfaces all failures when none work", async () => {
    const down: TranscriptionProvider = {
      name: "down",
      transcribe: () => Promise.reject(new Error("503 from provider")),
    };
    const up: TranscriptionProvider = {
      name: "up",
      transcribe: () => Promise.resolve("hello world"),
    };

    const router = new TranscriptionRouter([down, up]);
    const result = await router.transcribe(audio);
    expect(result).toEqual({ transcript: "hello world", provider: "up" });

    const allDown = new TranscriptionRouter([down]);
    await expect(allDown.transcribe(audio)).rejects.toThrow(/503 from provider/);
  });
});
