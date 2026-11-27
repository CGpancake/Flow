// Pure herdr glue contracts. Entry point: node --test tests/*.test.ts.

import assert from "node:assert/strict";
import test from "node:test";

import { chainMetadata, promptBlocked, SOURCE } from "../.pi/extensions/herdr-lean.ts";

const tasks = [
	{ label: "Restart watcher", status: "running", agent: "worker" },
	{ label: "Audit logs", status: "done", agent: "reviewer" },
	{ label: "Patch parser", status: "failed", agent: "worker" },
	{ label: "Ship note", status: "queued", agent: "researcher" },
];

test("chainMetadata labels a /work chain", () => {
	const meta = chainMetadata("work", { tasks, current: 1 });
	assert.equal(meta.title, "pi · /work 2/4 · reviewer · Audit logs");
	assert.equal(meta.display_agent, "pi: /work 2/4 · reviewer");
	assert.equal(meta.tokens.mode, "/work");
	assert.equal(meta.tokens.step, "2/4");
	assert.equal(meta.tokens.task, "Audit logs");
	assert.equal(meta.tokens.agent, "reviewer");
	assert.equal(meta.tokens.done, "1");
	assert.equal(meta.tokens.failed, "1");
	assert.equal(meta.tokens.running, "1");
	assert.equal(meta.tokens.queued, "1");
	assert.equal(meta.ttl_ms, 15 * 60 * 1000);
	assert.equal(meta.applies_to_source, "herdr:pi");
});

test("chainMetadata labels a tool chain", () => {
	const meta = chainMetadata("chain", { tasks, current: 0 });
	assert.equal(meta.title, "pi · chain 1/4 · worker · Restart watcher");
	assert.equal(meta.tokens.mode, "chain");
	assert.equal(meta.tokens.step, "1/4");
	assert.equal(meta.tokens.done, "1");
	assert.equal(meta.tokens.failed, "1");
	assert.equal(meta.tokens.running, "1");
	assert.equal(meta.tokens.queued, "1");
	assert.equal(meta.ttl_ms, 15 * 60 * 1000);
	assert.equal(meta.applies_to_source, "herdr:pi");
});

test("chainMetadata stays safe without tasks", () => {
	const meta = chainMetadata("chain", {});
	assert.equal(meta.title, "pi · chain · chain");
	assert.equal(meta.tokens.step, "");
	assert.equal(meta.tokens.done, "0");
	assert.equal(meta.tokens.failed, "0");
	assert.equal(meta.tokens.running, "0");
	assert.equal(meta.tokens.queued, "0");
});

test("herdr reports under a non-herdr source", () => {
	assert.ok(!SOURCE.startsWith("herdr:"));
});

test("promptBlocked uses the prompt title or a waiting fallback", () => {
	assert.deepEqual(promptBlocked({ kind: "select", title: "Pick one" }), { active: true, label: "Pick one" });
	assert.deepEqual(promptBlocked({ kind: "custom" }), { active: true, label: "waiting: custom" });
	assert.deepEqual(promptBlocked({}), { active: true, label: "waiting: input" });
});
