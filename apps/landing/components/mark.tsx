/** Four-point star inside brackets. Paths match brand/logo-final.svg. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" className="mark-icon">
      <path d="M24 12H10v76h14" fill="none" stroke="currentColor" strokeWidth="8" />
      <path d="M76 12h14v76H76" fill="none" stroke="currentColor" strokeWidth="8" />
      <path d="M50 20Q50 50 80 50Q50 50 50 80Q50 50 20 50Q50 50 50 20z" fill="currentColor" />
      <circle cx="68" cy="30" r="5" fill="#A1A1A1" />
    </svg>
  );
}
