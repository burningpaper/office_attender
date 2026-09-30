/**
 * The public week.
 *
 * The one page here that shows anything to somebody who has not signed in. It
 * is a flat, static read: no filters, no links back into the application, no
 * way to ask it about a different week. Everything it knows is on the screen.
 */

import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { db } from "@/lib/db/client";
import { loadPublicWeek, type PublicDayState } from "@/lib/share/public-week";
import { isValidShareToken } from "@/lib/share/token";

export const dynamic = "force-dynamic";

/**
 * Belt and braces against indexing. The proxy sets the same thing as a header,
 * because a crawler that only reads headers should hear it too.
 */
export const metadata: Metadata = {
  title: "Office attendance",
  robots: { index: false, follow: false, nocache: true },
};

function dayLabel(date: string): { weekday: string; date: string } {
  const value = new Date(`${date}T00:00:00Z`);
  return {
    weekday: value.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }),
    date: value.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }),
  };
}

const MARK: Record<PublicDayState, { glyph: string; label: string; className: string }> = {
  IN: { glyph: "●", label: "In the office", className: "text-[var(--yes)]" },
  OUT: { glyph: "–", label: "Not in", className: "text-[var(--subtle)]" },
  EXCUSED: { glyph: "○", label: "Excused", className: "text-[var(--exempt)]" },
  NO_RECORD: { glyph: "·", label: "Not recorded", className: "text-[var(--subtle)] opacity-50" },
  CLOSED: { glyph: "—", label: "Office closed", className: "text-[var(--subtle)] opacity-40" },
};

function Cell({ state }: { state: PublicDayState }) {
  const mark = MARK[state];
  return (
    <td className="px-3 py-2 text-center tabular-nums">
      <span className={`text-lg leading-none ${mark.className}`} title={mark.label}>
        {mark.glyph}
      </span>
      <span className="sr-only">{mark.label}</span>
    </td>
  );
}

export default async function PublicWeekPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!isValidShareToken(token)) notFound();

  const week = await loadPublicWeek(db, new Date().toISOString().slice(0, 10));

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-16">
      <header className="mb-10">
        <p className="text-xs uppercase tracking-[0.12em] text-[var(--subtle)]">
          Office attendance
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">{week.label}</h1>
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-[var(--muted)]">
          Who was in on the required days last week. First names only, and no reasons are
          shown for an absence.
        </p>
      </header>

      {week.offices.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">Nothing was recorded for this week.</p>
      ) : (
        week.offices.map((office) => (
          <section key={office.name} className="mb-12">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 className="text-lg font-medium tracking-tight">{office.name}</h2>
              <p className="text-sm text-[var(--muted)] tabular-nums">
                {office.days
                  .map((day, i) =>
                    day.kind === "CLOSED"
                      ? null
                      : `${office.attended[i]} of ${office.expected[i]} on ${dayLabel(day.date).weekday}`,
                  )
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>

            <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] bg-[var(--surface-muted)]">
                    <th scope="col" className="px-4 py-2.5 text-left font-medium">
                      Name
                    </th>
                    {office.days.map((day) => {
                      const label = dayLabel(day.date);
                      return (
                        <th
                          key={day.date}
                          scope="col"
                          className="w-24 px-3 py-2.5 text-center font-medium"
                        >
                          {label.weekday}
                          <span className="block text-xs font-normal text-[var(--subtle)]">
                            {label.date}
                          </span>
                          {day.kind === "CLOSED" && (
                            <span className="mt-0.5 block text-xs font-normal text-[var(--exempt)]">
                              {day.label}
                            </span>
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {office.people.map((person) => (
                    <tr
                      key={person.name}
                      className="border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-muted)]"
                    >
                      <th scope="row" className="px-4 py-2 text-left font-normal">
                        {person.name}
                      </th>
                      {person.states.map((state, i) => (
                        <Cell key={i} state={state} />
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}

      <footer className="mt-12 border-t border-[var(--border)] pt-5 text-xs leading-relaxed text-[var(--subtle)]">
        <p className="mb-2 flex flex-wrap gap-x-5 gap-y-1">
          {(
            [
              "IN",
              "OUT",
              "EXCUSED",
              "NO_RECORD",
              ...(week.offices.some((o) => o.days.some((d) => d.kind === "CLOSED"))
                ? (["CLOSED"] as const)
                : []),
            ] as const
          ).map((state) => (
            <span key={state}>
              <span className={MARK[state].className}>{MARK[state].glyph}</span>{" "}
              {MARK[state].label}
            </span>
          ))}
        </p>
        <p>Required days are Wednesday and Friday. This page is not indexed by search engines.</p>
      </footer>
    </main>
  );
}
