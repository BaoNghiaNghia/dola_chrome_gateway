import test from "node:test";
import assert from "node:assert/strict";
import {
  AdapterError,
  classifyPageText,
  extractConversationId,
  normalizeModel,
  validateDuration,
} from "./seedance-driver.mjs";

test("normalizes Seedance model aliases", () => {
  assert.equal(normalizeModel("seedance-2.5"), "seedance-2.5");
  assert.equal(normalizeModel("seedance_v2.5"), "seedance-2.5");
  assert.equal(normalizeModel("seedance-2.0"), "seedance-2.0");
});

test("rejects unsupported Seedance models", () => {
  assert.throws(
    () => normalizeModel("seedance-3.0"),
    (error) => error instanceof AdapterError && error.code === "unsupported_model",
  );
});

test("accepts only known Dola durations", () => {
  assert.equal(validateDuration(10), 10);
  assert.equal(validateDuration("15"), 15);
  assert.equal(validateDuration(30), 30);
  assert.throws(() => validateDuration(5), /Unsupported Seedance duration/);
});

test("extracts numeric Dola conversation id", () => {
  assert.equal(
    extractConversationId("https://www.dola.com/chat/123456789?foo=1"),
    "123456789",
  );
  assert.equal(extractConversationId("https://www.dola.com/chat"), null);
});

test("classifies daily limit and credit failures", () => {
  assert.equal(classifyPageText("Daily video generation limit reached")?.code, "daily_limit");
  assert.equal(classifyPageText("Insufficient credits")?.code, "insufficient_credit");
  assert.equal(classifyPageText("Generation is running"), null);
});
