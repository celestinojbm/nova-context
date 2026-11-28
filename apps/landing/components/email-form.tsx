"use client";

import * as React from "react";
import { submitContact, type ContactState } from "@/app/contact-action";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { EmailCopy } from "@/content/types";

const initial: ContactState = { status: "idle", message: "" };

export function EmailForm({ copy }: { copy: EmailCopy }) {
  const id = React.useId();
  const [state, action, pending] = React.useActionState(submitContact, initial);
  const invalid = state.status === "invalid";
  const message = state.message ? (copy.messages[state.message] ?? state.message) : "";

  return (
    <form action={action} noValidate className="w-full max-w-xl text-left">
      <FieldGroup>
        <Field className="relative" data-invalid={invalid || undefined}>
          <FieldLabel htmlFor={id}>{copy.label}</FieldLabel>
          <Input
            id={id}
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            maxLength={254}
            aria-invalid={invalid || undefined}
            aria-describedby={`${id}-help`}
            placeholder={copy.placeholder}
          />
          <div aria-hidden="true" className="pointer-events-none absolute -left-[9999px] h-px w-px overflow-hidden opacity-0">
            <label htmlFor={`${id}-company`}>{copy.honeypot}</label>
            <input id={`${id}-company`} name="company" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
          </div>
          <FieldDescription id={`${id}-help`}>{copy.help}</FieldDescription>
          {state.status === "ok" ? (
            <p role="status" className="text-lg text-foreground">
              {message}
            </p>
          ) : message ? (
            <FieldError>{message}</FieldError>
          ) : null}
        </Field>
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {copy.submit}
        </Button>
      </FieldGroup>
    </form>
  );
}
