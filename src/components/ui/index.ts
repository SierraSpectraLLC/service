/**
 * The component kit: every archetype is assembled from these. Rules of the
 * house: a kit component never carries an inline style (globals.css owns
 * every visual decision), and wraps an existing globals.css pattern where
 * one exists (.page-head, .empty, .seg, .tabs) rather than replacing it.
 */
export { default as Pill } from "@/components/ui/Pill";
export { default as Dot } from "@/components/ui/Dot";
export { default as Legend } from "@/components/ui/Legend";
export { default as Id } from "@/components/ui/Id";
export { default as PageHead } from "@/components/ui/PageHead";
export { default as Toolbar } from "@/components/ui/Toolbar";
export { default as FacetStrip } from "@/components/ui/FacetStrip";
export { default as SectionHead } from "@/components/ui/SectionHead";
export { default as RowActions } from "@/components/ui/RowActions";
export { default as Panel } from "@/components/ui/Panel";
export { default as EmptyState } from "@/components/ui/EmptyState";
export { default as Field } from "@/components/ui/Field";
export { default as Seg } from "@/components/ui/Seg";
export { default as Tabs } from "@/components/ui/Tabs";
export { default as Dialog } from "@/components/ui/Dialog";
export { ConfirmHost, confirmDialog } from "@/components/ui/ConfirmDialog";
export { ToastHost, toast } from "@/components/ui/Toast";
export type { Tone } from "@/lib/tones";
export type { Facet } from "@/components/ui/FacetStrip";
export type { RowAction } from "@/components/ui/RowActions";
export type { TabItem } from "@/components/ui/Tabs";
export type { DialogStep } from "@/components/ui/Dialog";
export type { ConfirmOptions } from "@/components/ui/ConfirmDialog";
export type { ToastOptions } from "@/components/ui/Toast";
