import { describe, expect, it } from "vitest";

import {
  buildBriefInput,
  createEmptyBriefFormState,
  isVariationCountEnabled,
  resolveOutputFormat,
  toggleMandatoryElement,
} from "@/app/components/brief-form-helpers";
import { validateBrief } from "@/lib/intake/brief-intake";
import { OUTPUT_FORMATS } from "@/lib/types";

// Unit tests for the Left Panel (Brief/Configurator) pure helpers (task 11.1).
// Requirements: 1.1, 1.3, 8.4, 8.5
describe("brief-form-helpers", () => {
  describe("createEmptyBriefFormState", () => {
    it("starts with an empty brand name and 3 variations", () => {
      const state = createEmptyBriefFormState();
      expect(state.brandName).toBe("");
      expect(state.variationCount).toBe(3);
      expect(state.mandatoryElements).toEqual([]);
    });
  });

  describe("isVariationCountEnabled (Req 8.4, 8.5)", () => {
    it("disables 9 variations for Free plan", () => {
      expect(isVariationCountEnabled("Free", 3)).toBe(true);
      expect(isVariationCountEnabled("Free", 6)).toBe(true);
      expect(isVariationCountEnabled("Free", 9)).toBe(false);
    });

    it("enables 9 variations for Pro plan", () => {
      expect(isVariationCountEnabled("Pro", 3)).toBe(true);
      expect(isVariationCountEnabled("Pro", 6)).toBe(true);
      expect(isVariationCountEnabled("Pro", 9)).toBe(true);
    });
  });

  describe("resolveOutputFormat (Req 1.7)", () => {
    it("resolves each format name to its full object", () => {
      for (const format of OUTPUT_FORMATS) {
        expect(resolveOutputFormat(format.name)).toEqual(format);
      }
    });
  });

  describe("toggleMandatoryElement", () => {
    it("adds then removes an element immutably", () => {
      const added = toggleMandatoryElement([], "LogoStrip");
      expect(added).toEqual(["LogoStrip"]);
      const removed = toggleMandatoryElement(added, "LogoStrip");
      expect(removed).toEqual([]);
      // original array is untouched
      expect(added).toEqual(["LogoStrip"]);
    });
  });

  describe("buildBriefInput (Req 1.1, 1.3)", () => {
    it("omits blank optional fields and resolves the output format", () => {
      const state = createEmptyBriefFormState();
      state.brandName = "Acme";
      const brief = buildBriefInput(state);
      expect(brief.brandName).toBe("Acme");
      expect(brief.tagline).toBeUndefined();
      expect(brief.mainMessage).toBeUndefined();
      expect(brief.outputFormat).toEqual(resolveOutputFormat(state.outputFormatName));
    });

    it("preserves the brand name unchanged so validation can reject it (Req 1.3)", () => {
      const state = createEmptyBriefFormState();
      state.brandName = "   "; // whitespace-only
      const brief = buildBriefInput(state);
      const result = validateBrief(brief);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "brandName")).toBe(true);
      // preservedValues echoes the input unchanged
      expect(result.preservedValues.brandName).toBe("   ");
    });

    it("passes through filled optional fields", () => {
      const state = createEmptyBriefFormState();
      state.brandName = "Acme";
      state.tagline = "Just do it";
      state.mainMessage = "Hiring now";
      const brief = buildBriefInput(state);
      expect(brief.tagline).toBe("Just do it");
      expect(brief.mainMessage).toBe("Hiring now");
    });
  });
});
