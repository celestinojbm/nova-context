import { cn } from "@/lib/utils";

/** Símbolo aprobado: estrella de cuatro puntas entre corchetes. No se separan. */
export function Symbol({
  className,
  variant = "negative",
}: {
  className?: string;
  variant?: "negative" | "hero";
}) {
  const stroke = variant === "hero" ? "rgba(255,255,255,.25)" : "#FAFAFA";
  const dot = variant === "hero" ? "#FAFAFA" : "#A1A1A1";
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true" focusable="false">
      <path d="M24 12H10v76h14M76 12h14v76H76" fill="none" stroke={stroke} strokeWidth="8" />
      <path d="M50 20Q50 50 80 50Q50 50 50 80Q50 50 20 50Q50 50 50 20z" fill="#FAFAFA" />
      <circle cx="68" cy="30" r="5" fill={dot} />
    </svg>
  );
}

/** Logotipo horizontal negativo. El wordmark es Geist 700, tracking −4 %. */
export function LogoLockup({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex min-w-24 items-center gap-[15px]", className)}>
      <Symbol className="size-[30px] shrink-0" />
      <span className="font-sans text-[19px] leading-none font-bold tracking-[-0.04em] whitespace-nowrap text-white">
        nova context
      </span>
    </span>
  );
}
