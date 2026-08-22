/**
 * An identifier: serial, part number, WO number, model code. Monospace so it
 * reads as a designation rather than prose. `dim` for the secondary
 * identifier on a line that already has a primary one.
 */
export default function Id({ dim, title, children }: {
  dim?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={`t-mono-id${dim ? " dim" : ""}`} title={title}>
      {children}
    </span>
  );
}
