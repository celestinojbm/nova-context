export const SHEET_ORIGIN = "nova-context";

export const MAX_EMAIL_LENGTH = 254;
export const MAX_HONEYPOT_LENGTH = 100;
export const MAX_BODY_BYTES = 2048;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const MESSAGE_INVALID = "Escribe un correo que podamos leer.";
export const MESSAGE_TOO_LONG = "Ese envío es demasiado largo.";
export const MESSAGE_UNCONFIGURED = "El envío no está configurado. No hemos guardado tu correo.";
export const MESSAGE_ERROR = "No pudimos guardar tu correo. Inténtalo de nuevo.";
export const MESSAGE_OK = "Listo. Guardamos tu correo.";
export const MESSAGE_UNREADABLE = "No pudimos leer el formulario.";

export type ContactStatus = "idle" | "invalid" | "unconfigured" | "error" | "ok";

export interface ContactState {
  status: ContactStatus;
  message: string;
}

export interface SubmitOptions {
  webhookUrl?: string;
  now?: Date;
  fetchImpl?: typeof fetch;
}

export interface SheetRow {
  email: string;
  submittedAt: string;
  origin: typeof SHEET_ORIGIN;
}

function blank(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : undefined;
}

/** https only. Bracket access so Next does not inline the value at build time. */
export function sheetsWebhookUrl(value: string | undefined = process.env["LANDING_SHEETS_WEBHOOK_URL"]): string | undefined {
  const raw = blank(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function contactHttpStatus(result: ContactState): number {
  if (result.status === "ok") return 200;
  if (result.status === "unconfigured") return 503;
  if (result.status === "invalid") return result.message === MESSAGE_TOO_LONG ? 413 : 400;
  return 502;
}

export async function submitLandingContact(formData: FormData, options: SubmitOptions = {}): Promise<ContactState> {
  const emailRaw = String(formData.get("email") ?? "");
  const honeypotRaw = String(formData.get("company") ?? "");

  if (emailRaw.length > MAX_EMAIL_LENGTH || honeypotRaw.length > MAX_HONEYPOT_LENGTH) {
    return { status: "invalid", message: MESSAGE_TOO_LONG };
  }

  if (honeypotRaw.trim() !== "") {
    return { status: "ok", message: MESSAGE_OK };
  }

  const email = emailRaw.trim();
  if (!EMAIL.test(email)) {
    return { status: "invalid", message: MESSAGE_INVALID };
  }

  const candidate = options.webhookUrl !== undefined ? options.webhookUrl : process.env["LANDING_SHEETS_WEBHOOK_URL"];
  const resolved = sheetsWebhookUrl(candidate);
  if (!resolved) {
    return { status: "unconfigured", message: MESSAGE_UNCONFIGURED };
  }

  const row: SheetRow = {
    email,
    submittedAt: (options.now ?? new Date()).toISOString(),
    origin: SHEET_ORIGIN,
  };

  try {
    const response = await (options.fetchImpl ?? fetch)(resolved, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(row),
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok || response.url.includes("accounts.google.com")) {
      return { status: "error", message: MESSAGE_ERROR };
    }
    return { status: "ok", message: MESSAGE_OK };
  } catch {
    return { status: "error", message: MESSAGE_ERROR };
  }
}

export async function handleContactPost(request: Request, options?: SubmitOptions): Promise<Response> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isFinite(size) || size < 0 || size > MAX_BODY_BYTES) {
      return Response.json({ status: "invalid", message: MESSAGE_TOO_LONG } satisfies ContactState, { status: 413 });
    }
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ status: "invalid", message: MESSAGE_UNREADABLE } satisfies ContactState, { status: 400 });
  }

  const result = await submitLandingContact(formData, options);
  return Response.json(result, { status: contactHttpStatus(result) });
}
