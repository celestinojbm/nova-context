import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MESSAGE_ERROR,
  MESSAGE_INVALID,
  MESSAGE_OK,
  MESSAGE_TOO_LONG,
  MESSAGE_UNCONFIGURED,
  MESSAGE_UNREADABLE,
  SHEET_ORIGIN,
  handleContactPost,
  submitLandingContact,
} from "./sheets-contact.ts";

const NOW = new Date("2026-10-22T19:15:00.000Z");
const WEBHOOK = "https://example.com/exec";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("POST /api/contact", () => {
  it("rechaza un correo que no se puede leer y no llama al webhook", async () => {
    let called = false;
    const result = await submitLandingContact(form({ email: "no-es-correo" }), {
      webhookUrl: WEBHOOK,
      fetchImpl: async () => {
        called = true;
        return new Response("ok");
      },
    });
    assert.equal(result.status, "invalid");
    assert.equal(result.message, MESSAGE_INVALID);
    assert.equal(called, false);
  });

  it("lee la variable de entorno y no finge éxito si está vacía", async () => {
    const previous = process.env["LANDING_SHEETS_WEBHOOK_URL"];
    delete process.env["LANDING_SHEETS_WEBHOOK_URL"];
    try {
      let called = false;
      const result = await submitLandingContact(form({ email: "ada@example.com" }), {
        fetchImpl: async () => {
          called = true;
          return new Response("ok");
        },
      });
      assert.equal(result.status, "unconfigured");
      assert.equal(result.message, MESSAGE_UNCONFIGURED);
      assert.equal(called, false);
    } finally {
      if (previous === undefined) delete process.env["LANDING_SHEETS_WEBHOOK_URL"];
      else process.env["LANDING_SHEETS_WEBHOOK_URL"] = previous;
    }
  });

  it("dice que no está configurado si falta la variable, sin simular un éxito", async () => {
    let called = false;
    const result = await submitLandingContact(form({ email: "ada@example.com" }), {
      webhookUrl: "  ",
      fetchImpl: async () => {
        called = true;
        return new Response("ok");
      },
    });
    assert.equal(result.status, "unconfigured");
    assert.equal(result.message, MESSAGE_UNCONFIGURED);
    assert.equal(called, false);
    assert.equal(result.message.includes("Listo"), false);
  });

  it("no llama al webhook si la dirección no es https", async () => {
    let called = false;
    const result = await submitLandingContact(form({ email: "ada@example.com" }), {
      webhookUrl: "http://example.com/exec",
      fetchImpl: async () => {
        called = true;
        return new Response("ok");
      },
    });
    assert.equal(result.status, "unconfigured");
    assert.equal(result.message, MESSAGE_UNCONFIGURED);
    assert.equal(called, false);
  });

  it("responde como si hubiera salido bien cuando el honeypot viene relleno, y no guarda", async () => {
    let called = false;
    const result = await submitLandingContact(form({ email: "ada@example.com", company: "acme" }), {
      webhookUrl: WEBHOOK,
      fetchImpl: async () => {
        called = true;
        return new Response("ok");
      },
    });
    assert.equal(result.status, "ok");
    assert.equal(result.message, MESSAGE_OK);
    assert.equal(called, false);
  });

  it("corta un envío demasiado largo", async () => {
    const result = await submitLandingContact(form({ email: `${"a".repeat(300)}@example.com` }), {
      webhookUrl: WEBHOOK,
      fetchImpl: async () => {
        throw new Error("no debería llamarse");
      },
    });
    assert.equal(result.status, "invalid");
    assert.equal(result.message, MESSAGE_TOO_LONG);
  });

  it("hace POST con el correo, la fecha ISO y el origen nova-context", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const result = await submitLandingContact(form({ email: "  ada@example.com  ", origin: "otro" }), {
      webhookUrl: WEBHOOK,
      now: NOW,
      fetchImpl: async (url, init) => {
        seen.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    assert.equal(result.status, "ok");
    assert.equal(result.message, MESSAGE_OK);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.url, WEBHOOK);
    assert.equal(seen[0]?.init.method, "POST");
    const body = JSON.parse(String(seen[0]?.init.body));
    assert.deepEqual(body, {
      email: "ada@example.com",
      submittedAt: "2026-10-22T19:15:00.000Z",
      origin: SHEET_ORIGIN,
    });
  });

  it("no dice que salió bien si el webhook responde con error", async () => {
    const result = await submitLandingContact(form({ email: "ada@example.com" }), {
      webhookUrl: WEBHOOK,
      fetchImpl: async () => new Response("no", { status: 500 }),
    });
    assert.equal(result.status, "error");
    assert.equal(result.message, MESSAGE_ERROR);
  });

  it("no dice que salió bien si la red falla", async () => {
    const result = await submitLandingContact(form({ email: "ada@example.com" }), {
      webhookUrl: WEBHOOK,
      fetchImpl: async () => {
        throw new Error("caído");
      },
    });
    assert.equal(result.status, "error");
    assert.equal(result.message, MESSAGE_ERROR);
  });

  it("la ruta devuelve 413 si el cuerpo declarado supera el límite", async () => {
    const request = new Request("https://landing.test/api/contact", {
      method: "POST",
      headers: { "content-length": "99999", "content-type": "application/x-www-form-urlencoded" },
      body: "email=ada@example.com",
    });
    const response = await handleContactPost(request, {
      webhookUrl: WEBHOOK,
      fetchImpl: async () => {
        throw new Error("no debería llamarse");
      },
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { status: "invalid", message: MESSAGE_TOO_LONG });
  });

  it("la ruta devuelve 400 si el cuerpo no es un formulario", async () => {
    const request = new Request("https://landing.test/api/contact", {
      method: "POST",
      headers: { "content-type": "text/plain", "content-length": "4" },
      body: "hola",
    });
    const response = await handleContactPost(request, { webhookUrl: WEBHOOK });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { status: "invalid", message: MESSAGE_UNREADABLE });
  });

  it("la ruta devuelve 503 cuando falta el webhook y 200 cuando guarda", async () => {
    const missing = await handleContactPost(requestWith({ email: "ada@example.com" }), { webhookUrl: "" });
    assert.equal(missing.status, 503);
    assert.deepEqual(await missing.json(), { status: "unconfigured", message: MESSAGE_UNCONFIGURED });

    const saved = await handleContactPost(requestWith({ email: "ada@example.com" }), {
      webhookUrl: WEBHOOK,
      now: NOW,
      fetchImpl: async () => new Response("ok", { status: 200 }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { status: "ok", message: MESSAGE_OK });
  });
});

function requestWith(fields: Record<string, string>): Request {
  return new Request("https://landing.test/api/contact", { method: "POST", body: form(fields) });
}
