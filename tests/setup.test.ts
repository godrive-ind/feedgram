import { describe, expect, it } from "vitest";
import fc from "fast-check";

// Placeholder smoke test verifying the test runner and fast-check (PBT) are
// wired up correctly. Real property/example/integration tests are added in
// later tasks.
describe("project scaffolding", () => {
  it("runs the Vitest test runner", () => {
    expect(1 + 1).toBe(2);
  });

  it("runs fast-check property-based tests", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        return a + b === b + a;
      }),
      { numRuns: 100 }
    );
  });
});
