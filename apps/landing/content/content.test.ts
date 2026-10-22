import assert from "node:assert/strict";
import test from "node:test";
import { en } from "./en.ts";
import { es } from "./es.ts";

const dictionaries = [en, es];

test("english is the default locale id", () => {
  assert.equal(en.meta.locale, "en");
  assert.equal(es.meta.locale, "es");
});

test("both locales mark prices, latency, and the sample payload as placeholders", () => {
  for (const content of dictionaries) {
    for (const value of [
      content.pricing.badge,
      content.pricing.note,
      content.sdk.example,
      content.how.metricNote,
    ]) {
      assert.match(value.toLowerCase(), /placeholder/);
    }
    assert.deepEqual(
      content.pricing.plans.map((plan) => plan.price),
      ["$0", "$12", "$24"],
    );
    assert.equal(content.sdk.response.includes("cap_7Qe2"), true);
    assert.equal(content.sdk.tabs.length, 3);
    assert.equal(content.faq.items.length, 5);
    assert.equal(content.faq.items[0]?.open, true);
    assert.equal(content.how.steps.length, 4);
    assert.equal(content.features.items.length, 6);
    assert.equal(content.privacy.rows.length, 5);
  }
});

test("sample code does not call a live host", () => {
  for (const content of dictionaries) {
    for (const tab of content.sdk.tabs) {
      assert.equal(tab.code.includes("api.example.invalid") || !tab.code.includes("https://"), true);
      assert.equal(tab.code.includes("localhost"), false);
    }
  }
});
