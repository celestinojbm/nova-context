import type { Metadata } from "next";
import type { ReactNode } from "react";
import "../components/iso/iso.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nova Context",
  description: "La capa bajo los asistentes. Capturas lo que ves, dices qué significa y confirmas antes de que nada se guarde o salga.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
