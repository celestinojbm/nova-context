#!/usr/bin/env node
// M19 demo seed — SINTÉTICO. Crea (o reutiliza) una cuenta local de demo y
// añade unos pocos Context Moments de texto para que la línea de tiempo no
// esté vacía. Solo habla con la API LOCAL; no usa servicios en la nube.
//
//   NOVA_DEMO_API=http://localhost:3001 node demo/seed.mjs
const api = process.env.NOVA_DEMO_API ?? "http://localhost:3001";
const email = process.env.NOVA_DEMO_EMAIL ?? "demo@nova.local";
const password = process.env.NOVA_DEMO_PASSWORD ?? "nova-demo-password";

if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(api)) {
  console.error(`seed: se niega a escribir en una API no local (${api}).`);
  process.exit(1);
}

async function call(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

const signup = await call("/v1/auth/signup", { method: "POST", body: { email, password } });
const fresh = signup.status === 201;
const login = await call("/v1/auth/login", { method: "POST", body: { email, password } });
if (login.status !== 200 || !login.body?.token) {
  console.error(`seed: login falló (HTTP ${login.status}). ¿Existe ${email} con otra contraseña?`);
  process.exit(1);
}
const token = login.body.token;

const moments = [
  {
    title: "Atlas — notas de diseño del panel",
    url: "http://localhost:8080/atlas/diseno",
    text: "Proyecto Atlas. Notas de diseño del panel: tarjetas de métricas, modo oscuro y exportación CSV.",
    intent: "guardar como referencia del proyecto Atlas",
  },
  {
    title: "Atlas — feedback de usuarios piloto",
    url: "http://localhost:8080/atlas/feedback",
    text: "Proyecto Atlas. Feedback sintético: los usuarios piden filtros por fecha y atajos de teclado.",
    intent: "añadir al proyecto Atlas para la próxima planificación",
  },
  {
    title: "Huerto comunitario — calendario de riego",
    url: "http://localhost:8080/huerto/riego",
    text: "Huerto comunitario. Calendario de riego sintético: lunes y jueves por la mañana.",
    intent: "recordarme el calendario de riego del huerto",
  },
];

if (!fresh) {
  const list = await call("/v1/context/moments?limit=50", { token });
  const titles = new Set((list.body?.items ?? []).map((m) => m.source_meta?.title ?? m.title));
  if (moments.every((m) => titles.has(m.title))) {
    console.log(`seed: ${email} ya tiene los momentos de demo; nada que hacer.`);
    process.exit(0);
  }
}

for (const m of moments) {
  const r = await call("/v1/context/moments", {
    method: "POST",
    token,
    body: {
      source_mode: "instant_capture",
      source_meta: { url: m.url, title: m.title },
      payload: { dom_extract: { main_text: m.text } },
      extracted_text: `${m.title}. ${m.text}`,
      intent_text: m.intent,
    },
  });
  if (r.status !== 201) {
    console.error(`seed: no se pudo crear "${m.title}" (HTTP ${r.status}).`);
    process.exit(1);
  }
}
console.log(`seed: ${moments.length} momentos sintéticos creados para ${email}.`);
