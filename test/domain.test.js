import test from "node:test";
import assert from "node:assert/strict";
import { buildHandoff, chooseProvider, createTask } from "../src/domain.js";

test("routes normal work to Claude", () => {
  assert.equal(chooseProvider({ complexity: "normal", critical: false }, { claude: "available", codex: "available" }), "claude");
});

test("routes critical work to Codex", () => {
  assert.equal(chooseProvider({ complexity: "normal", critical: true }, { claude: "available", codex: "available" }), "codex");
});

test("falls back when preferred provider is unavailable", () => {
  assert.equal(chooseProvider({ complexity: "normal", critical: false }, { claude: "exhausted", codex: "available" }), "codex");
});

test("handoff includes checkpoint evidence", () => {
  const task = createTask({ title: "Ship", prompt: "Build it" });
  task.provider = "claude";
  task.checkpoint.completed.push("API added");
  task.checkpoint.verification.push("tests pass");
  assert.match(buildHandoff(task, "limit reached", "codex"), /API added[\s\S]*tests pass[\s\S]*codex/);
});
