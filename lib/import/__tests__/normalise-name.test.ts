import { describe, expect, it } from "vitest";
import { isProbablySamePerson, levenshtein, normaliseName, splitName } from "../normalise-name";

const same = (a: string, b: string) =>
  isProbablySamePerson(normaliseName(a), normaliseName(b));

describe("normaliseName", () => {
  it("collapses the case and whitespace variants in the sheets", () => {
    expect(normaliseName("zoe Flanegan")).toBe(normaliseName("Zoe Flanegan"));
    expect(normaliseName("Ben ")).toBe(normaliseName("Ben"));
    expect(normaliseName("Ricardo  Thompson")).toBe(normaliseName("Ricardo Thompson"));
  });

  it("strips stray punctuation without merging distinct people", () => {
    expect(normaliseName("Anthea O'Neill'")).toBe("anthea oneill");
    expect(normaliseName("Ashley O'Neill'")).toBe("ashley oneill");
    expect(normaliseName("Anthea O'Neill'")).not.toBe(normaliseName("Ashley O'Neill'"));
  });

  it("treats hyphens as spaces", () => {
    expect(normaliseName("Kelly-Ann Tabone")).toBe("kelly ann tabone");
    expect(normaliseName("Mary Rodrigues-Jack")).toBe("mary rodrigues jack");
    expect(normaliseName("Abdul-Maalik Jacobs")).toBe("abdul maalik jacobs");
  });

  it("keeps multi-part surnames intact", () => {
    expect(normaliseName("Matthew van Niekerk")).toBe("matthew van niekerk");
    expect(normaliseName("Robynne Rowlinson Bisset")).toBe("robynne rowlinson bisset");
  });
});

describe("levenshtein", () => {
  it("measures the edits the sheets actually contain", () => {
    expect(levenshtein("zakiya karim", "zakiyya karim")).toBe(1);
    expect(levenshtein("weslee johannesen", "weslee johanneson")).toBe(1);
    expect(levenshtein("same", "same")).toBe(0);
  });
});

describe("isProbablySamePerson", () => {
  it("merges the real spelling variants", () => {
    expect(same("Zakiya Karim", "Zakiyya Karim")).toBe(true);
    expect(same("Weslee Johannesen", "Weslee Johanneson")).toBe(true);
    expect(same("zoe Flanegan", "Zoe Flanegan")).toBe(true);
  });

  it("refuses the traps in this roster", () => {
    // Same surname, different people.
    expect(same("Anthea O'Neill'", "Ashley O'Neill'")).toBe(false);
    // Same first name, different people - both on the April and May sheets.
    expect(same("Jason Tucker", "Jason Khubeka")).toBe(false);
    expect(same("Ben Clay", "Ben Wiid")).toBe(false);
    expect(same("Matthew Rudd", "Matthew Bannatyne")).toBe(false);
  });

  it("refuses to absorb a longer name into a shorter one", () => {
    expect(same("Matthew Rudd", "Matthew van Niekerk")).toBe(false);
  });

  it("never matches a name with no surname", () => {
    // "Brian" and "Intern" must reach a human, not a best guess.
    expect(same("Brian", "Brian Wiid")).toBe(false);
    expect(same("Brian", "Bruan")).toBe(false);
    expect(same("Intern", "Intern")).toBe(true); // identical is still identical
  });

  it("refuses two edits on a short name", () => {
    expect(same("Al Bo", "Al Ba")).toBe(false);
  });
});

describe("splitName", () => {
  it("splits a full name wrongly placed in the first-name column", () => {
    // June row 80 puts "Weslee Johannesen" in column A with B empty.
    expect(splitName("Weslee Johannesen", "")).toEqual({
      first: "Weslee",
      last: "Johannesen",
    });
  });

  it("leaves a proper first/last pair alone", () => {
    expect(splitName("Zoe", "Flanegan")).toEqual({ first: "Zoe", last: "Flanegan" });
  });

  it("keeps a multi-part surname together", () => {
    expect(splitName("Matthew", "van Niekerk")).toEqual({
      first: "Matthew",
      last: "van Niekerk",
    });
  });

  it("leaves a single name with no surname alone", () => {
    expect(splitName("Brian", "")).toEqual({ first: "Brian", last: "" });
  });
});
