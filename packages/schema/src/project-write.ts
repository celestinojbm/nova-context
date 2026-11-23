import { z } from "zod";
import { parsedIntentSchema } from "./intent.js";

/**
 * Escritura de proyectos y momentos (BUILD_PLAN §5):
 *   POST  /v1/projects              — crear proyecto
 *   PATCH /v1/context/moments/:id   — confirmar/cambiar el proyecto vinculado
 *                                      y editar la intención
 * Contratos puramente aditivos: ninguna ruta existente cambia de forma.
 */

/** Tope de proyectos activos por usuario (freno a abuso; no es un límite de producto). */
export const MAX_PROJECTS_PER_USER = 200;

const trimmed = (max: number) => z.string().trim().min(1).max(max);

export const createProjectRequestSchema = z
  .object({
    name: trimmed(120),
    description: z
      .string()
      .trim()
      .max(2_000)
      .nullable()
      .optional()
      .transform((v) => (v ? v : null)),
    // Proyecto "solo local": sus hechos de memoria nunca salen de la máquina (M20a).
    local_only: z.boolean().default(false),
  })
  .strict();
export type CreateProjectRequest = z.input<typeof createProjectRequestSchema>;

export const createProjectResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  local_only: z.boolean(),
  created_at: z.string().datetime({ offset: true }),
});
export type CreateProjectResponse = z.infer<typeof createProjectResponseSchema>;

/** Al menos un campo; `null` desvincula el proyecto / borra la intención. */
export const updateContextMomentRequestSchema = z
  .object({
    project_id: z.string().uuid().nullable().optional(),
    intent_text: z.string().max(10_000).nullable().optional(),
  })
  .strict()
  .refine((v) => v.project_id !== undefined || v.intent_text !== undefined, {
    message: "se requiere al menos project_id o intent_text",
  });
export type UpdateContextMomentRequest = z.input<typeof updateContextMomentRequestSchema>;

export const updateContextMomentResponseSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid().nullable(),
  intent_text: z.string().nullable(),
  intent_parsed: parsedIntentSchema.nullable(),
  redaction_state: z.enum(["pending", "applied", "skipped"]),
  /** Campos que realmente cambiaron (vacío = petición idempotente). */
  changed: z.array(z.enum(["project_id", "intent_text"])),
});
export type UpdateContextMomentResponse = z.infer<typeof updateContextMomentResponseSchema>;
