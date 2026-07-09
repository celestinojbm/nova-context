"use client";

import type { ReactNode } from "react";

/**
 * Destructive-action guard (M4): wraps a form submit button with a native
 * confirmation dialog. Server actions do the deleting; this ensures no
 * destructive delete happens on a single stray click.
 */
export function ConfirmSubmit({
  message,
  className,
  children,
}: {
  message: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="submit"
      className={className}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
