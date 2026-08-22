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
export { default as DataTable } from "@/components/ui/DataTable";
export { CardGrid, EntityCard } from "@/components/ui/CardGrid";
export { default as InlineEdit } from "@/components/ui/InlineEdit";
export { default as SaveBar } from "@/components/ui/SaveBar";
export { default as RecordHero } from "@/components/ui/RecordHero";
export { default as PrintHeader } from "@/components/ui/PrintHeader";
export { default as PublicShell } from "@/components/ui/PublicShell";
export { default as HeroKebab } from "@/components/ui/HeroKebab";
export type { HeroStat } from "@/components/ui/RecordHero";
export type { HeroKebabItem } from "@/components/ui/HeroKebab";
export type { Tone } from "@/lib/tones";
export type { Facet } from "@/components/ui/FacetStrip";
export type { RowAction } from "@/components/ui/RowActions";
export type { TabItem } from "@/components/ui/Tabs";
export type { DialogStep } from "@/components/ui/Dialog";
export type { ConfirmOptions } from "@/components/ui/ConfirmDialog";
export type { ToastOptions } from "@/components/ui/Toast";
export type { DataCol, DataRow } from "@/components/ui/DataTable";
