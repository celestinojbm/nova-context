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
    assert.equal(content.privacy.rows.length, 6);
  }
});

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("\n");
  if (value && typeof value === "object") return Object.values(value).map(text).join("\n");
  return "";
}

test("privacy copy stays inside the security doc", () => {
  const banned = [
    /end-to-end/i,
    /\be2ee\b/i,
    /cifrado de extremo/i,
    /extremo a extremo/i,
    /your keys/i,
    /tus claves/i,
    /cannot read your memory/i,
    /no lee tu memoria/i,
    /never monetized/i,
    /nunca se monetiza/i,
    /no surveillance/i,
    /sin vigilancia/i,
  ];
  for (const content of dictionaries) {
    const blob = text(content);
    for (const pattern of banned) assert.doesNotMatch(blob, pattern);
    for (const plan of content.pricing.plans) {
      assert.equal(
        plan.items.some((item) => /transit|tránsito/.test(item)),
        true,
      );
    }
  }

  const encryption = en.features.items[5];
  assert.match(encryption?.title ?? "", /in transit and at rest/);
  assert.match(encryption?.body ?? "", /TLS 1\.3/);
  assert.match(encryption?.body ?? "", /in memory/);
  assert.match(encryption?.body ?? "", /model provider/);
  assert.match(en.privacy.rows[5]?.value ?? "", /plaintext/i);
  assert.match(en.faq.items[3]?.a ?? "", /does not keep it/);
  assert.match(en.hero.promise, /35 days/);

  const cifrado = es.features.items[5];
  assert.match(cifrado?.title ?? "", /tránsito y en reposo/);
  assert.match(cifrado?.body ?? "", /TLS 1\.3/);
  assert.match(cifrado?.body ?? "", /en memoria/);
  assert.match(cifrado?.body ?? "", /proveedor de modelos/);
  assert.match(es.privacy.rows[5]?.value ?? "", /texto en claro/);
  assert.match(es.faq.items[3]?.a ?? "", /no lo conserva/);
  assert.match(es.hero.promise, /35 días/);
});

test("sample code does not call a live host", () => {
  for (const content of dictionaries) {
    for (const tab of content.sdk.tabs) {
      assert.equal(tab.code.includes("api.example.invalid") || !tab.code.includes("https://"), true);
      assert.equal(tab.code.includes("localhost"), false);
    }
  }
});
