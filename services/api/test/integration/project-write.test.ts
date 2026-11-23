import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { createUser, type TestUser } from "./helpers.js";

/**
 * BUILD_PLAN §5: POST /v1/projects y PATCH /v1/context/moments/:id.
 * Contra Postgres real; cuentas nuevas por suite para aislar datos.
 */
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("project write + moment PATCH", () => {
  let app: FastifyInstance;
  let db: pg.Client;
  let alice: TestUser;
  let bob: TestUser;
  const stamp = Date.now();

  beforeAll(async () => {
    await migrate(databaseUrl!);
    app = await buildApp({
      ocr: null,
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_RATE_LIMIT_PREFIX: `test-pw-${stamp}`,
      }),
    });
    await app.ready();
    alice = await createUser(app, `pw-alice-${stamp}@example.test`);
    bob = await createUser(app, `pw-bob-${stamp}@example.test`);
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  async function createProject(user: TestUser, payload: Record<string, unknown>) {
    return user.inject({ method: "POST", url: "/v1/projects", payload });
  }

  async function captureMoment(user: TestUser, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await user.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: {
        source_mode: "instant_capture",
        source_meta: { url: "https://example.com/pricing", title: "Pricing" },
        extracted_text: "Enterprise plans start at 10 dollars",
        intent_text: "remember this",
        ...extra,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  describe("POST /v1/projects", () => {
    it("exige autenticación", async () => {
      const res = await app.inject({ method: "POST", url: "/v1/projects", payload: { name: "X" } });
      expect(res.statusCode).toBe(401);
    });

    it("crea un proyecto, lo lista y deja rastro en el audit sin contenido", async () => {
      const res = await createProject(alice, { name: "  Acme API  ", description: "Límites de la API" });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        name: "Acme API",
        description: "Límites de la API",
        local_only: false,
      });

      const list = (await alice.inject({ method: "GET", url: "/v1/projects" })).json();
      const found = list.items.find((p: { id: string }) => p.id === body.id);
      expect(found).toMatchObject({ name: "Acme API", moment_count: 0, task_count: 0 });

      const audit = await db.query(
        `SELECT detail FROM audit_log WHERE user_id = $1 AND event_type = 'project.create' AND subject_id = $2`,
        [alice.userId, body.id],
      );
      expect(audit.rowCount).toBe(1);
      expect(JSON.stringify(audit.rows[0].detail)).not.toContain("Acme");
      expect(JSON.stringify(audit.rows[0].detail)).not.toContain("Límites");
    });

    it("valida el cuerpo (400)", async () => {
      expect((await createProject(alice, {})).statusCode).toBe(400);
      expect((await createProject(alice, { name: "   " })).statusCode).toBe(400);
      expect((await createProject(alice, { name: "ok", user_id: "x" })).statusCode).toBe(400);
    });

    it("rechaza nombres duplicados sin distinguir mayúsculas (409), también en concurrencia", async () => {
      expect((await createProject(alice, { name: "Dup Name" })).statusCode).toBe(201);
      expect((await createProject(alice, { name: "dup NAME" })).statusCode).toBe(409);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => createProject(alice, { name: "Carrera" })),
      );
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 409)).toHaveLength(4);
    });

    it("permite el mismo nombre a otro usuario (aislamiento)", async () => {
      expect((await createProject(alice, { name: "Compartido" })).statusCode).toBe(201);
      expect((await createProject(bob, { name: "Compartido" })).statusCode).toBe(201);
      const bobList = (await bob.inject({ method: "GET", url: "/v1/projects" })).json();
      expect(bobList.items.filter((p: { name: string }) => p.name === "Compartido")).toHaveLength(1);
    });

    it("aplica el tope de proyectos activos (409)", async () => {
      const carol = await createUser(app, `pw-carol-${stamp}@example.test`);
      // Inbox ya cuenta como 1: rellena hasta el tope por SQL y comprueba el siguiente alta.
      await db.query(
        `INSERT INTO projects (user_id, name)
         SELECT $1, 'bulk-' || g FROM generate_series(1, 199) g`,
        [carol.userId],
      );
      const res = await createProject(carol, { name: "uno-mas" });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "project_limit_reached", limit: 200 });
    });
  });

  describe("PATCH /v1/context/moments/:id", () => {
    it("exige autenticación y valida ids/cuerpo", async () => {
      const id = await captureMoment(alice);
      expect(
        (await app.inject({ method: "PATCH", url: `/v1/context/moments/${id}`, payload: { project_id: null } }))
          .statusCode,
      ).toBe(401);
      expect((await alice.inject({ method: "PATCH", url: "/v1/context/moments/no-uuid", payload: { project_id: null } })).statusCode).toBe(404);
      expect((await alice.inject({ method: "PATCH", url: `/v1/context/moments/${id}`, payload: {} })).statusCode).toBe(400);
      expect(
        (await alice.inject({ method: "PATCH", url: `/v1/context/moments/${id}`, payload: { extracted_text: "no" } }))
          .statusCode,
      ).toBe(400);
    });

    it("vincula, cambia y desvincula el proyecto; tareas y acciones del momento lo siguen", async () => {
      const p1 = (await createProject(alice, { name: "Vinculo Uno" })).json().id as string;
      const p2 = (await createProject(alice, { name: "Vinculo Dos" })).json().id as string;
      const id = await captureMoment(alice, { intent_text: "create a task to follow up with Acme" });
      const taskBefore = await db.query("SELECT id, project_id FROM tasks WHERE moment_id = $1", [id]);
      expect(taskBefore.rowCount).toBe(1);

      let res = await alice.inject({ method: "PATCH", url: `/v1/context/moments/${id}`, payload: { project_id: p1 } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id, project_id: p1, changed: ["project_id"] });
      let task = await db.query("SELECT project_id FROM tasks WHERE moment_id = $1", [id]);
      expect(task.rows[0].project_id).toBe(p1);
      let act = await db.query("SELECT project_id FROM actions WHERE moment_id = $1", [id]);
      expect(act.rows.every((r) => r.project_id === p1)).toBe(true);

      res = await alice.inject({ method: "PATCH", url: `/v1/context/moments/${id}`, payload: { project_id: p2 } });
      expect(res.json().changed).toEqual(["project_id"]);
      const got = (await alice.inject({ method: "GET", url: `/v1/context/moments/${id}` })).json();
      expect(got.project_id).toBe(p2);
      task = await db.query("SELECT project_id FROM tasks WHERE moment_id = $1", [id]);
      expect(task.rows[0].project_id).toBe(p2);

      res = await alice.inject({ method: "PATCH", url: `/v1/context/moments/${id}`, payload: { project_id: null } });
      expect(res.json()).toMatchObject({ project_id: null, changed: ["project_id"] });
      task = await db.query("SELECT project_id FROM tasks WHERE moment_id = $1", [id]);
      expect(task.rows[0].project_id).toBeNull();
    });

    it("es idempotente: repetir el mismo valor no cambia nada ni escribe audit", async () => {
      const p = (await createProject(alice, { name: "Idempotente" })).json().id as string;
      const id = await captureMoment(alice, { project_id: p });
      const before = (await db.query("SELECT count(*)::int AS n FROM audit_log WHERE subject_id = $1", [id])).rows[0].n;
      const res = await alice.inject({ method: "PATCH", url: `/v1/context/moments/${id}`, payload: { project_id: p } });
      expect(res.statusCode).toBe(200);
      expect(res.json().changed).toEqual([]);
      const after = (await db.query("SELECT count(*)::int AS n FROM audit_log WHERE subject_id = $1", [id])).rows[0].n;
      expect(after).toBe(before);
    });

    it("rechaza proyecto inexistente, ajeno o archivado (400) sin modificar el momento", async () => {
      const id = await captureMoment(alice);
      const bobProject = (await createProject(bob, { name: "Solo de Bob" })).json().id as string;
      const archived = (await createProject(alice, { name: "Archivado" })).json().id as string;
      await db.query("UPDATE projects SET archived = true WHERE id = $1", [archived]);

      for (const project_id of [bobProject, archived, "00000000-0000-4000-8000-000000000000"]) {
        const res = await alice.inject({ method: "PATCH", url: `/v1/context/moments/${id}`, payload: { project_id } });
        expect(res.statusCode).toBe(400);
        expect(res.json().issues[0].path).toBe("project_id");
      }
      const row = (await db.query("SELECT project_id FROM context_moments WHERE id = $1", [id])).rows[0];
      expect(row.project_id).toBeNull();
    });

    it("no permite editar momentos de otro usuario (404)", async () => {
      const id = await captureMoment(alice);
      const p = (await createProject(bob, { name: "Bob Intento" })).json().id as string;
      const res = await bob.inject({ method: "PATCH", url: `/v1/context/moments/${id}`, payload: { project_id: p } });
      expect(res.statusCode).toBe(404);
      const row = (await db.query("SELECT project_id FROM context_moments WHERE id = $1", [id])).rows[0];
      expect(row.project_id).toBeNull();
    });

    it("registra moment.update sin contenido y project.link.override si difiere de la sugerencia", async () => {
      const hinted = (await createProject(alice, { name: "Pricing Hint" })).json().id as string;
      const other = (await createProject(alice, { name: "Otro Distinto" })).json().id as string;
      const id = await captureMoment(alice, { intent_text: "save this for the pricing hint project" });

      const res = await alice.inject({ method: "PATCH", url: `/v1/context/moments/${id}`, payload: { project_id: other } });
      expect(res.statusCode).toBe(200);

      const rows = (
        await db.query(
          `SELECT event_type, detail FROM audit_log WHERE subject_id = $1 AND event_type IN ('moment.update','project.link.override')`,
          [id],
        )
      ).rows;
      const update = rows.find((r) => r.event_type === "moment.update");
      expect(update.detail).toMatchObject({ fields: ["project_id"], to_project_id: other });
      expect(JSON.stringify(update.detail)).not.toContain("pricing hint");
      const override = rows.find((r) => r.event_type === "project.link.override");
      expect(override.detail).toMatchObject({ chosen_project_id: other, suggested_project_id: hinted });
    });

    it("edita la intención: redacta PII, reparsea, actualiza tsv y no escribe el texto en el audit", async () => {
      const id = await captureMoment(alice, { intent_text: "remember this" });
      const res = await alice.inject({
        method: "PATCH",
        url: `/v1/context/moments/${id}`,
        payload: { intent_text: "create a task to email zebra.quokka@example.com about the invoice" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.changed).toEqual(["intent_text"]);
      expect(body.intent_text).not.toContain("zebra.quokka@example.com");
      expect(body.intent_parsed).toMatchObject({ parser: "heuristic", action_type: "create_task" });

      const row = (await db.query("SELECT intent_text, tsv::text AS tsv FROM context_moments WHERE id = $1", [id])).rows[0];
      expect(row.intent_text).toBe(body.intent_text);
      expect(row.tsv).toContain("invoic");
      expect(row.tsv).not.toContain("quokka");

      const audit = (
        await db.query(`SELECT detail FROM audit_log WHERE subject_id = $1 AND event_type = 'moment.update'`, [id])
      ).rows;
      expect(JSON.stringify(audit)).not.toContain("quokka");
      expect(JSON.stringify(audit)).not.toContain("invoice");
      expect(audit[0].detail.redactions).toMatchObject({ email: 1 });
    });

    it("intent_text null o vacío borra la intención y el parseo", async () => {
      const id = await captureMoment(alice, { intent_text: "create a task to call Bob" });
      for (const value of [null, "   "]) {
        await alice.inject({ method: "PATCH", url: `/v1/context/moments/${id}`, payload: { intent_text: "create a task to call Bob" } });
        const res = await alice.inject({ method: "PATCH", url: `/v1/context/moments/${id}`, payload: { intent_text: value } });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ intent_text: null, intent_parsed: null });
      }
    });

    it("no toca texto extraído, resumen ni medios del momento", async () => {
      const id = await captureMoment(alice);
      const before = (await db.query("SELECT extracted_text, summary, payload, source_meta FROM context_moments WHERE id = $1", [id])).rows[0];
      await alice.inject({ method: "PATCH", url: `/v1/context/moments/${id}`, payload: { intent_text: "otra cosa" } });
      const after = (await db.query("SELECT extracted_text, summary, payload, source_meta FROM context_moments WHERE id = $1", [id])).rows[0];
      expect(after).toEqual(before);
    });

    it("recalcula memory_items.local_only al revincular (nunca queda un hecho no-local en un proyecto local)", async () => {
      const localProject = (await createProject(alice, { name: "Solo Local", local_only: true })).json();
      expect(localProject.local_only).toBe(true);
      const open = (await createProject(alice, { name: "Abierto" })).json().id as string;
      const id = await captureMoment(alice, { project_id: open });
      await db.query(
        `INSERT INTO memory_items (user_id, moment_id, layer, content, local_only)
         VALUES ($1, $2, 'semantic', 'hecho de prueba', false)`,
        [alice.userId, id],
      );

      await alice.inject({ method: "PATCH", url: `/v1/context/moments/${id}`, payload: { project_id: localProject.id } });
      let mem = await db.query("SELECT local_only FROM memory_items WHERE moment_id = $1", [id]);
      expect(mem.rows[0].local_only).toBe(true);

      await alice.inject({ method: "PATCH", url: `/v1/context/moments/${id}`, payload: { project_id: open } });
      mem = await db.query("SELECT local_only FROM memory_items WHERE moment_id = $1", [id]);
      expect(mem.rows[0].local_only).toBe(false);
    });

    it("aparece en /v1/audit con etiqueta legible", async () => {
      const id = await captureMoment(alice);
      await alice.inject({ method: "PATCH", url: `/v1/context/moments/${id}`, payload: { intent_text: "x" } });
      const res = await alice.inject({ method: "GET", url: "/v1/audit?event_type=moment.update" });
      expect(res.statusCode).toBe(200);
      expect(JSON.stringify(res.json())).toContain("Context Moment updated");
    });
  });
});
