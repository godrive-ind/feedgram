import { describe, expect, it } from "vitest";

import { getOptions } from "@/lib/intake/brief-intake";
import {
  CONTENT_GOALS,
  VISUAL_STYLES,
  TONES,
  OUTPUT_FORMATS,
  VARIATION_COUNTS,
  MANDATORY_ELEMENTS,
} from "@/lib/types";

// Unit test for Brief_Intake.getOptions() — verifies the option lists match
// the spec enums exactly. Requirements: 1.4, 1.5, 1.6, 1.7, 1.8, 1.9
describe("Brief_Intake getOptions()", () => {
  const options = getOptions();

  it("returns content goals exactly as specified (Req 1.4)", () => {
    expect(options.contentGoals).toEqual([
      "Rekrutmen",
      "Promosi",
      "Branding",
      "Edukasi",
      "Engagement",
      "Report",
    ]);
    // Matches the canonical enum constant.
    expect(options.contentGoals).toEqual(CONTENT_GOALS);
  });

  it("returns visual styles exactly as specified (Req 1.5)", () => {
    expect(options.visualStyles).toEqual([
      "BoldDark",
      "VibrantCleanModern",
      "CorporateBlue",
      "Minimalis",
      "WarmEarth",
      "NeonCyber",
      "Luxury",
      "Gradient",
    ]);
    expect(options.visualStyles).toEqual(VISUAL_STYLES);
  });

  it("returns tones exactly as specified (Req 1.6)", () => {
    expect(options.tones).toEqual([
      "Profesional",
      "Energik",
      "Edukatif",
      "Minimalis",
      "Friendly",
      "Formal",
    ]);
    expect(options.tones).toEqual(TONES);
  });

  it("returns output formats with exact dimensions (Req 1.7)", () => {
    expect(options.outputFormats).toEqual([
      { name: "InstagramFeed", width: 1080, height: 1350 },
      { name: "Carousel", width: 1080, height: 1080 },
      { name: "StoryReel", width: 1080, height: 1920 },
      { name: "Square", width: 1080, height: 1080 },
      { name: "Landscape", width: 1200, height: 628 },
    ]);
    expect(options.outputFormats).toEqual(OUTPUT_FORMATS);
  });

  it("returns variation counts exactly as specified (Req 1.8)", () => {
    expect(options.variationCounts).toEqual([3, 6, 9]);
    expect(options.variationCounts).toEqual(VARIATION_COUNTS);
  });

  it("returns mandatory elements exactly as specified (Req 1.9)", () => {
    expect(options.mandatoryElements).toEqual([
      "LogoStrip",
      "CTAButton",
      "StatCards",
      "QRCode",
      "BadgeFloating",
      "ProgressBar",
    ]);
    expect(options.mandatoryElements).toEqual(MANDATORY_ELEMENTS);
  });
});
