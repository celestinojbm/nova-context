"use client";

import * as React from "react";
import { submitContact, type ContactState } from "@/app/contact-action";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const initial: ContactState = { status: "idle", message: "" };

export function EmailForm() {
  const id = React.useId();
  const [state, action, pending] = React.useActionState(submitContact, initial);
  const invalid = state.status === "invalid";

  return (
    <form action={action} noValidate className="w-full max-w-md text-left">
      <FieldGroup>
        <Field data-invalid={invalid || undefined}>
          <FieldLabel htmlFor={id}>Correo</FieldLabel>
          <Input
            id={id}
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            aria-invalid={invalid || undefined}
            aria-describedby={`${id}-help`}
            placeholder="tu@correo"
          />
          <FieldDescription id={`${id}-help`}>Escríbenos. No abre una cuenta y no pasa por un pago.</FieldDescription>
          {state.message ? <FieldError>{state.message}</FieldError> : null}
        </Field>
        <Button type="submit" disabled={pending}>
          Enviar correo
        </Button>
      </FieldGroup>
    </form>
  );
}
