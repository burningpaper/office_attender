/**
 * Names on a page anybody can read.
 */
import { describe, expect, it } from "vitest";
import { publicNames } from "../display-names";

const person = (firstName: string, lastName = "") => ({ firstName, lastName });

describe("public names", () => {
  it("leaves an unambiguous first name alone", () => {
    const names = publicNames([person("Mark", "Haefele"), person("Francesca", "Tiganis")]);
    expect(names).toEqual(["Mark", "Francesca"]);
  });

  it("tells Cape Town's three Matthews apart", () => {
    // The real clash. Showing "Matthew" three times conceals nothing and
    // misattributes: a colleague reading it cannot tell which one missed.
    const names = publicNames([
      person("Matthew", "Bannatyne"),
      person("Matthew", "Rudd"),
      person("Matthew", "van Niekerk"),
    ]);
    expect(names).toEqual(["Matthew B.", "Matthew R.", "Matthew v.N."]);
  });

  it("keeps a particle's own case", () => {
    // "V.N." is a small act of vandalism against somebody's name.
    expect(publicNames([person("Matthew", "van Niekerk"), person("Matthew", "Rudd")])[0]).toBe(
      "Matthew v.N.",
    );
  });

  it("only escalates the people in the clash", () => {
    const names = publicNames([
      person("Ben", "Clay"),
      person("Ben", "Wiid"),
      person("Kevin", "Irwin"),
    ]);
    expect(names).toEqual(["Ben C.", "Ben W.", "Kevin"]);
  });

  it("falls back to the full surname when initials still collide", () => {
    const names = publicNames([person("Ben", "Clay"), person("Ben", "Cohen")]);
    expect(names).toEqual(["Ben Clay", "Ben Cohen"]);
  });

  it("does not drag a third person into a clash between two others", () => {
    const names = publicNames([
      person("Ben", "Clay"),
      person("Ben", "Cohen"),
      person("Ben", "Wiid"),
    ]);
    // Clay and Cohen need their surnames; Wiid is already distinct at W.
    expect(names).toEqual(["Ben Clay", "Ben Cohen", "Ben W."]);
  });

  it("leaves somebody with no recorded surname as a bare first name", () => {
    // Weslee is one word in the register. There is nothing to add.
    expect(publicNames([person("Weslee"), person("Kevin", "Irwin")])).toEqual([
      "Weslee",
      "Kevin",
    ]);
  });

  it("does not number two people it cannot tell apart", () => {
    // "Ben (2)" reads as a fact about a person and is not one.
    expect(publicNames([person("Ben"), person("Ben")])).toEqual(["Ben", "Ben"]);
  });
});
