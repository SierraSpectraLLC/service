// The database half of platform appearance. lib/appearance holds the rules and
// the defaults and imports nothing, so the settings form can use the same
// validation in the browser that the server applies on save; this fetches the
// row. Separate for the same reason lib/house is separate from lib/houseRole.
import { cache } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings } from "@/db/schema";
import {
  DEFAULT_HEADER, DEFAULT_SPECTRUM_HEIGHT, DEFAULT_STOPS,
  clampHeight, gradientCss, headerColor, parseStops, type Stop,
} from "@/lib/appearance";

export type Appearance = {
  /** Always a real hex - the stored blank has already become the default. */
  headerColor: string;
  spectrumHeight: number;
  spectrumStops: Stop[];
  /** Ready to inline; every part of it has been validated. */
  spectrumCss: string;
  /** What is actually stored, for the settings form's "is this the default" test. */
  storedHeaderColor: string;
};

/**
 * cache() so the layout and the page it wraps share one lookup per request -
 * this is read on every render of every page, exactly like getBrand.
 *
 * Never throws: an instance whose settings row is missing, or whose schema
 * sync has not landed yet, renders in the stock colours rather than not at
 * all. A deploy that briefly precedes its migration must not be a white page.
 */
export const getAppearance = cache(async (): Promise<Appearance> => {
  try {
    const [s] = await db.select({
      headerColor: appSettings.headerColor,
      spectrumHeight: appSettings.spectrumHeight,
      spectrumStops: appSettings.spectrumStops,
    }).from(appSettings).where(eq(appSettings.id, 1));
    const stops = parseStops(s?.spectrumStops ?? "");
    return {
      headerColor: headerColor(s?.headerColor ?? ""),
      spectrumHeight: clampHeight(s?.spectrumHeight ?? DEFAULT_SPECTRUM_HEIGHT),
      spectrumStops: stops,
      spectrumCss: gradientCss(stops),
      storedHeaderColor: (s?.headerColor ?? "").trim(),
    };
  } catch {
    return {
      headerColor: DEFAULT_HEADER,
      spectrumHeight: DEFAULT_SPECTRUM_HEIGHT,
      spectrumStops: DEFAULT_STOPS,
      spectrumCss: gradientCss(DEFAULT_STOPS),
      storedHeaderColor: "",
    };
  }
});
