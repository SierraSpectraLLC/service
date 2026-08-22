/**
 * A labelled form control: label, the control itself, then a hint or an
 * error - never both, the error takes the hint's place while it stands.
 * The control is `children`, so this works for inputs, selects, textareas
 * and anything else without knowing about them.
 */
export default function Field({ label, hint, required, optional, error, htmlFor, children }: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  required?: boolean;
  /** Says "optional" beside the label - for forms where most fields are required. */
  optional?: boolean;
  error?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>
        {label}
        {required && <span className="field-req"> *</span>}
        {optional && <span className="field-opt"> optional</span>}
      </label>
      {children}
      {error != null
        ? <div className="field-err">{error}</div>
        : hint != null && <div className="field-hint">{hint}</div>}
    </div>
  );
}
