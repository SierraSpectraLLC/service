/**
 * The three layout primitives, and the reason they exist.
 *
 * The app carries 3,297 inline `style={{}}` blocks, and about nine in ten of
 * them are a flex direction, a gap and some padding - a layout decision
 * re-made in every file, by feel, at whichever of eighteen spacing values
 * looked right that afternoon. A 223-commit sweep normalized those values once
 * and they drifted straight back, because nothing made the consistent way the
 * EASY way. These do: `<Stack gap={3}>` is shorter to write than the style
 * attribute it replaces, and it cannot land off the grid.
 *
 * Gaps are steps on the scale (1 = 4px … 7 = 48px), never pixels. There is no
 * escape hatch on purpose - a layout that genuinely needs 18px is an argument
 * for a step, not a reason to write 18.
 */
export type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Vertical flow: the default shape of a page's body. */
export function Stack({ gap = 3, children, className }: {
  gap?: Step;
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`stack sp-${gap}${className ? ` ${className}` : ""}`}>{children}</div>;
}

/**
 * Horizontal flow. `wrap` is the honest default for a row of controls on a
 * phone; pass `nowrap` for a row that must stay one line (and scroll instead).
 */
export function Row({ gap = 2, align = "center", wrap = true, children, className }: {
  gap?: Step;
  align?: "center" | "start" | "baseline";
  wrap?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`row sp-${gap} al-${align}${wrap ? "" : " nowrap"}${className ? ` ${className}` : ""}`}>
      {children}
    </div>
  );
}

/**
 * A grid of equal cells that collapses to one column on a phone. `cols` is the
 * widest it goes; narrower viewports get fewer, because a three-up row of
 * metric tiles at 380px is three columns of wrapped text.
 */
export function Grid({ cols = 3, gap = 3, children, className }: {
  cols?: 2 | 3 | 4;
  gap?: Step;
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`grid-${cols} sp-${gap}${className ? ` ${className}` : ""}`}>{children}</div>;
}
