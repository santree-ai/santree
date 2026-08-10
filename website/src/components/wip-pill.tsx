/** Inline "Soon" chip for anything not shipped yet (Download, Docs). Sits in
 * the text flow next to its label — never rotated, never absolutely
 * positioned. */
export function WipPill({ className = "" }: { className?: string }) {
  return <span className={`chip ${className}`}>soon</span>;
}
