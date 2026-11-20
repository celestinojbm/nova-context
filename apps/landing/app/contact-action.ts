"use server";

import { submitLandingContact, type ContactState } from "@/lib/sheets-contact";

export type { ContactState };

export async function submitContact(_previous: ContactState, formData: FormData): Promise<ContactState> {
  return submitLandingContact(formData);
}
