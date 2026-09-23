import { describe, expect, it } from "vitest";
import { buildRecipients } from "../recipients";
import { renderEmail } from "../render";
import type {
  ComplianceResult,
  DayDetail,
  EmployeeRowWithDays,
  Verdict,
} from "../../compliance/types";

const result = (verdict: Verdict): ComplianceResult => ({
  verdict, attended: 0, required: 0, excused: 0, missed: [], unrecorded: [], attendedDates: [], excusedDates: [],
});

const day = (date: string, state: DayDetail["state"], extra: Partial<DayDetail> = {}): DayDetail => ({
  date, state, reasonText: null, reasonLabel: null, reasonCategory: null,
  outsideEmployment: false, ...extra,
});

function row(name: string, overrides: Partial<EmployeeRowWithDays> = {}): EmployeeRowWithDays {
  return {
    employeeId: name.length,
    displayName: name,
    isExempt: false,
    exemptionNote: null,
    hasLeft: false,
    onRosterThisMonth: true,
    monthly: result("NO"),
    twoWeek: result("NO"),
    longTerm: { ...result("NO"), wednesdayAverage: 0, fridayAverage: 0, monthsCounted: 3 },
    lastAttended: null,
    recent: { basis: "LAST_FEW_DAYS", since: null, result: result("NA") },
    improving: false,
    monthDays: [],
    ...overrides,
  };
}

const emails = (pairs: [number, string][]) => new Map(pairs);

describe("who never gets a message", () => {
  it("excludes exempt people, whatever their verdict says", () => {
    // Telling somebody on maternity leave they have not been in the office
    // would be worse than sending nothing at all.
    const rows = [
      row("Kevin Irwin", { isExempt: true, monthly: result("EXEMPT") }),
      row("Mary Rodrigues-Jack", { isExempt: true, monthly: result("NO") }),
      row("Ben Clay"),
    ];
    const { recipients, excluded } = buildRecipients(rows, "MONTHLY", emails([
      [11, "kevin@x.com"], [19, "mary@x.com"], [8, "ben@x.com"],
    ]));

    expect(recipients.map((r) => r.displayName)).toEqual(["Ben Clay"]);
    expect(excluded.filter((e) => e.reason === "EXEMPT").map((e) => e.displayName)).toEqual([
      "Kevin Irwin", "Mary Rodrigues-Jack",
    ]);
  });

  it("excludes anybody whose verdict is not NO", () => {
    // NA means the question could not be answered. It is not a failure and
    // must never be mailed as one - this is the September case.
    const rows = [
      row("Not Yet", { monthly: result("NA") }),
      row("Compliant", { monthly: result("YES") }),
      row("Failing"),
    ];
    const { recipients } = buildRecipients(rows, "MONTHLY", emails([
      [7, "a@x.com"], [9, "b@x.com"], [7, "c@x.com"],
    ]));
    expect(recipients.map((r) => r.displayName)).toEqual(["Failing"]);
  });

  it("excludes anybody with no address on file", () => {
    const rows = [row("No Email"), row("Has Email")];
    const { recipients, excluded } = buildRecipients(rows, "MONTHLY", emails([[9, "has@x.com"]]));
    expect(recipients.map((r) => r.displayName)).toEqual(["Has Email"]);
    expect(excluded).toContainEqual({ displayName: "No Email", reason: "NO_EMAIL" });
  });

  it("uses the right verdict for each category", () => {
    const person = row("Split", {
      monthly: result("YES"),
      twoWeek: result("NO"),
      longTerm: { ...result("YES"), wednesdayAverage: 3, fridayAverage: 3, monthsCounted: 3 },
    });
    const map = emails([[5, "split@x.com"]]);
    expect(buildRecipients([person], "MONTHLY", map).recipients).toHaveLength(0);
    expect(buildRecipients([person], "TWO_WEEK", map).recipients).toHaveLength(1);
    expect(buildRecipients([person], "LONG_TERM", map).recipients).toHaveLength(0);
  });
});

describe("the dates quoted to each person", () => {
  const person = row("Carlos Feyder", {
    monthly: {
      verdict: "NO",
      attended: 2,
      required: 3,
      excused: 1,
      attendedDates: ["2026-08-05", "2026-08-07"],
      excusedDates: ["2026-08-12"],
      missed: ["2026-08-26"],
      unrecorded: [],
    },
  });

  const [recipient] = buildRecipients([person], "MONTHLY", emails([[13, "carlos@x.com"]])).recipients;

  it("separates attended, missed and excused", () => {
    expect(recipient.attended).toEqual(["2026-08-05", "2026-08-07"]);
    expect(recipient.missed).toEqual(["2026-08-26"]);
    expect(recipient.excused).toEqual(["2026-08-12"]);
  });

  it("never counts an excused day as a miss", () => {
    // Telling somebody they failed to attend on a day they were signed off
    // sick is the kind of mistake that gets a system switched off.
    expect(recipient.missed).not.toContain("2026-08-12");
  });
});

describe("rendering", () => {
  const recipient = {
    employeeId: 1,
    displayName: "Nadine Pillay",
    email: "nadine@x.com",
    improving: false,
    recentNote: null,
    attended: ["2026-08-05"],
    missed: ["2026-08-26", "2026-08-28"],
    excused: ["2026-08-12"],
  };

  it("includes the two lines the spec asks for", () => {
    const { html } = renderEmail(recipient, "Office attendance", "Please come in.");
    expect(html).toContain("You attended at the office on");
    expect(html).toContain("You did not attend on");
    expect(html).toContain("Wed 5 Aug");
    expect(html).toContain("Wed 26 Aug, Fri 28 Aug");
  });

  it("lists excused days separately, and says they do not count", () => {
    const { html } = renderEmail(recipient, "s", "b");
    expect(html).toContain("not counted against you");
    expect(html).toContain("Wed 12 Aug");
  });

  it("greets by first name", () => {
    expect(renderEmail(recipient, "s", "b").html).toContain("Hi Nadine,");
  });

  it("escapes anything typed into the message", () => {
    const { html } = renderEmail(recipient, "s", "<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("keeps paragraph breaks from the typed body", () => {
    const { html } = renderEmail(recipient, "s", "First para.\n\nSecond para.");
    expect(html).toContain("First para.");
    expect(html).toContain("Second para.");
    expect((html.match(/<p style="margin:0 0 14px;">/g) ?? []).length).toBeGreaterThan(2);
  });

  it("shows a dash rather than an empty list", () => {
    const { html } = renderEmail({ ...recipient, attended: [] }, "s", "b");
    expect(html).toContain("—");
  });

  it("omits the excused row when there is nothing to excuse", () => {
    const { html } = renderEmail({ ...recipient, excused: [] }, "s", "b");
    expect(html).not.toContain("not counted against you");
  });
});

describe("the dates quoted come from the verdict, not a second calculation", () => {
  it("never disagrees with the verdict about what was missed", () => {
    /**
     * The bug this replaces: somebody was on the non-compliant list showing
     * "2 attended, 0 missed". The verdict counted two days with no record as
     * missed; this side skipped them. Reading the result directly makes that
     * impossible to reproduce.
     */
    const person = row("Mark Haefele", {
      monthly: {
        verdict: "NO",
        attended: 2,
        required: 4,
        excused: 0,
        attendedDates: ["2026-09-09", "2026-09-11"],
        excusedDates: [],
        missed: ["2026-09-02", "2026-09-04"],
        unrecorded: [],
      },
    });

    const { recipients } = buildRecipients([person], "MONTHLY", emails([[12, "m@x.com"]]));
    expect(recipients).toHaveLength(1);
    expect(recipients[0].attended).toEqual(["2026-09-09", "2026-09-11"]);
    expect(recipients[0].missed).toEqual(["2026-09-02", "2026-09-04"]);
  });

  it("quotes the fortnight's days for a two-week message, not the month's", () => {
    const person = row("Split Person", {
      monthly: {
        verdict: "YES", attended: 1, required: 1, excused: 0,
        attendedDates: ["2026-09-02"], excusedDates: [], missed: [], unrecorded: [],
      },
      twoWeek: {
        verdict: "NO", attended: 1, required: 2, excused: 0,
        attendedDates: ["2026-09-09"], excusedDates: [], missed: ["2026-09-11"], unrecorded: [],
      },
    });

    const { recipients } = buildRecipients([person], "TWO_WEEK", emails([[12, "s@x.com"]]));
    expect(recipients[0].attended).toEqual(["2026-09-09"]);
    expect(recipients[0].missed).toEqual(["2026-09-11"]);
  });
});

describe("flagging people who have mended their ways", () => {
  it("marks them improving and explains the window", () => {
    const person = row("Mark Haefele", {
      monthly: {
        verdict: "NO", attended: 4, required: 6, excused: 0,
        attendedDates: ["2026-09-09", "2026-09-11", "2026-09-16", "2026-09-18"],
        excusedDates: [], missed: ["2026-09-02", "2026-09-04"], unrecorded: [],
      },
      improving: true,
      recent: {
        basis: "SINCE_REMINDER",
        since: "2026-09-08",
        result: {
          verdict: "YES", attended: 4, required: 4, excused: 0,
          attendedDates: [], excusedDates: [], missed: [], unrecorded: [],
        },
      },
    });

    const { recipients } = buildRecipients([person], "MONTHLY", emails([[12, "m@x.com"]]));
    expect(recipients[0].improving).toBe(true);
    expect(recipients[0].recentNote).toBe(
      "4 of 4 recent required days, since the reminder on 2026-09-08",
    );
  });

  it("keeps them on the list rather than quietly dropping them", () => {
    // Flagged, not removed - whether to write is still your call.
    const person = row("Mark Haefele", { improving: true });
    const { recipients, excluded } = buildRecipients(
      [person], "MONTHLY", emails([[12, "m@x.com"]]),
    );
    expect(recipients).toHaveLength(1);
    expect(excluded).toHaveLength(0);
  });

  it("says nothing about somebody with no recent days to judge", () => {
    const person = row("Quiet Person");
    const { recipients } = buildRecipients(
      [person], "MONTHLY", emails([[person.employeeId, "q@x.com"]]),
    );
    expect(recipients[0].improving).toBe(false);
    expect(recipients[0].recentNote).toBeNull();
  });
});
