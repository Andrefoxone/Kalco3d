import { describe, expect, it } from "vitest";
import { dimsMm, longestFor, valueFor, fmtMm } from "./dimensions";

describe("misure reali", () => {
  const size = { x: 0.5, y: 1.5, z: 0.3 }; // statuina: alta 3 volte la larghezza
  it("dal lato più lungo alle tre misure", () => {
    expect(dimsMm(size, 150)).toEqual({ larghezza: 50, profondita: 30, altezza: 150 });
  });
  it("da una misura nota al lato più lungo, e ritorno", () => {
    expect(longestFor(size, "larghezza", 60)).toBeCloseTo(180);
    expect(longestFor(size, "altezza", 120)).toBeCloseTo(120);
    expect(valueFor(size, "profondita", 180)).toBeCloseTo(36);
  });
  it("formato italiano", () => {
    expect(fmtMm(36)).toBe("36");
    expect(fmtMm(12.34)).toBe("12,3");
    expect(fmtMm(150.4)).toBe("150");
  });
});
