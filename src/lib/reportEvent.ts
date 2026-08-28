// The one string that lets anything on a page open the report box.
//
// Same pattern as the layout toggle in ui/HeroKebab: a window event rather
// than lifted state, because the opener (an error page, a header item) and the
// dialog (mounted once in the root layout) have no component tree in common,
// and threading a callback through the layout to reach them would be a prop on
// every page for a button on two.
export const REPORT_EVENT = "ridgeline:report";
