import { describe, expect, it } from "vitest";
import { matchAddresses, parseAddressText, type KnownPerson } from "../import-addresses";

const people: KnownPerson[] = [
  { id: 1, displayName: "Zoe Flanegan", normalisedKey: "zoe flanegan", email: null, aliases: ["Zoe Flanegan", "zoe Flanegan"] },
  { id: 2, displayName: "Zakiya Karim", normalisedKey: "zakiya karim", email: "old@vml.com", aliases: ["Zakiya Karim", "Zakiyya Karim"] },
  { id: 3, displayName: "Anthea O'Neill'", normalisedKey: "anthea oneill", email: null, aliases: ["Anthea O'Neill'"] },
];

describe("parsing pasted addresses", () => {
  it("accepts comma, tab and semicolon separated lines", () => {
    const { rows } = parseAddressText(
      "Zoe Flanegan, zoe@vml.com\nZakiya Karim\tzakiya@vml.com\nAnthea O'Neill';anthea@vml.com",
    );
    expect(rows).toEqual([
      { rawName: "Zoe Flanegan", email: "zoe@vml.com" },
      { rawName: "Zakiya Karim", email: "zakiya@vml.com" },
      { rawName: "Anthea O'Neill'", email: "anthea@vml.com" },
    ]);
  });

  it("skips a header row and blank lines", () => {
    const { rows } = parseAddressText("Name,Email\n\nZoe Flanegan,zoe@vml.com\n\n");
    expect(rows).toHaveLength(1);
  });

  it("lowercases addresses", () => {
    const { rows } = parseAddressText("Zoe Flanegan,ZOE@VML.COM");
    expect(rows[0].email).toBe("zoe@vml.com");
  });

  it("reports a line with no address rather than dropping it", () => {
    const { rows, invalid } = parseAddressText("Zoe Flanegan\nBen Clay,ben@vml.com");
    expect(rows).toHaveLength(1);
    expect(invalid[0].line).toBe("Zoe Flanegan");
  });

  it("guesses a name from a bare address", () => {
    const { rows } = parseAddressText("zoe.flanegan@vml.com");
    expect(rows[0]).toEqual({ rawName: "zoe flanegan", email: "zoe.flanegan@vml.com" });
  });
});

describe("matching to people", () => {
  it("matches through the same normalisation that resolved the roster", () => {
    const { matched } = matchAddresses(
      [{ rawName: "zoe FLANEGAN", email: "zoe@vml.com" }],
      people,
    );
    expect(matched[0]).toMatchObject({ employeeId: 1, displayName: "Zoe Flanegan" });
  });

  it("matches a known misspelling through the alias list", () => {
    const { matched } = matchAddresses(
      [{ rawName: "Zakiyya Karim", email: "zakiya@vml.com" }],
      people,
    );
    expect(matched[0].employeeId).toBe(2);
  });

  it("flags an address that replaces an existing one", () => {
    const { matched } = matchAddresses(
      [{ rawName: "Zakiya Karim", email: "new@vml.com" }],
      people,
    );
    expect(matched[0].replaces).toBe("old@vml.com");
  });

  it("reports an unknown name rather than creating a person", () => {
    const { matched, unmatched } = matchAddresses(
      [{ rawName: "Someone Else", email: "x@vml.com" }],
      people,
    );
    expect(matched).toHaveLength(0);
    expect(unmatched[0].reason).toMatch(/no employee matches/i);
  });

  it("refuses a second address for the same person in one paste", () => {
    const { matched, unmatched } = matchAddresses(
      [
        { rawName: "Zoe Flanegan", email: "one@vml.com" },
        { rawName: "zoe Flanegan", email: "two@vml.com" },
      ],
      people,
    );
    expect(matched).toHaveLength(1);
    expect(unmatched[0].reason).toMatch(/already has an address/i);
  });
});
