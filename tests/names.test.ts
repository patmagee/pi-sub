import { describe, expect, it } from "vitest";
import { UniqueNameAllocator } from "../src/names.js";

describe("UniqueNameAllocator", () => {
  it("normalizes names and assigns stable suffixes across reuse", () => {
    const names = new UniqueNameAllocator();

    expect(names.allocate("Explore")).toBe("explore");
    expect(names.allocate("explore")).toBe("explore-2");
    expect(names.allocate(" explore! ")).toBe("explore-3");
    expect(names.allocate("security review")).toBe("security-review");
  });

  it("collapses punctuation and repeated separators to single hyphens", () => {
    const names = new UniqueNameAllocator();

    expect(names.allocate("API___security...review")).toBe("api-security-review");
  });

  it("avoids collisions with names that already contain numeric suffixes", () => {
    const names = new UniqueNameAllocator();

    expect(names.allocate("explore")).toBe("explore");
    expect(names.allocate("explore-2")).toBe("explore-2");
    expect(names.allocate("explore")).toBe("explore-3");
  });

  it("rejects names without an ASCII letter or number", () => {
    const names = new UniqueNameAllocator();

    expect(() => names.allocate(" !!! ")).toThrow(
      "Agent names must contain a letter or number.",
    );
  });
});
