/**
 * The button, as a component rather than a class.
 *
 * `.btn` has been the house button for a long time and 79 raw <button>s were
 * still styled by hand next to it - because a CSS class is something you have
 * to REMEMBER, and nothing pushes you onto it. A component in the kit does the
 * pushing: it is the shortest thing to reach for, and it is the only place the
 * variants are enumerated.
 *
 * `danger` is the variant the app was missing. Every destructive action was
 * either a plain button or, worse, a link - "Close order" and "Delete" styled
 * as quietly as "Add note", with ConfirmDialog carrying the whole weight of
 * saying "this one is different". It says it now before the click as well.
 */
export default function Button({
  variant = "default", size, type = "button", className, children, ...rest
}: {
  variant?: "default" | "primary" | "accent" | "danger" | "link";
  size?: "sm";
  children: React.ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className"> & { className?: string }) {
  const cls = ["btn", variant === "default" ? "" : variant, size ?? "", className ?? ""]
    .filter(Boolean).join(" ");
  return <button type={type} className={cls} {...rest}>{children}</button>;
}
