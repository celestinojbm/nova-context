"use server";

export type ContactStatus = "idle" | "invalid" | "pending";

export interface ContactState {
  status: ContactStatus;
  message: string;
}

/**
 * PENDIENTE: no hay endpoint, buzón ni tabla para este formulario.
 * No llama a ninguna red, no escribe el correo y no usa servicios de pago.
 */
export async function submitContact(_previous: ContactState, formData: FormData): Promise<ContactState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { status: "invalid", message: "Escribe un correo que podamos leer." };
  }
  return {
    status: "pending",
    message: "Pendiente: en este repositorio no hay un endpoint de correo. No hemos enviado ni guardado tu dirección.",
  };
}
