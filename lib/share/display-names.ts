/**
 * Names for a page anybody can read.
 *
 * The public week shows first names, because a colleague scanning it needs to
 * recognise themselves and each other, and a stranger who is forwarded the link
 * should not be handed a staff directory.
 *
 * First names alone are not quite enough. Cape Town has three Matthews, two
 * Bens and two Jasons, and a list showing "Matthew - missed both days" three
 * times over is worse than a full name: it does not conceal anything, it
 * misattributes. So a surname initial is added, and only to the people who
 * need one. Sixty-one of sixty-eight stay a bare first name.
 */

export type Named = { firstName: string; lastName: string };

/**
 * A surname reduced to initials: "Bannatyne" to "B.", "van Niekerk" to "v.N.".
 *
 * Particles keep their own case, because that is how the name is written and
 * "V.N." would be a small act of vandalism against somebody's name.
 */
function initials(lastName: string): string {
  const parts = lastName.trim().split(/\s+/).filter(Boolean);
  return parts.map((part) => `${[...part][0]}.`).join("");
}

/**
 * Public names for a group, in the order given.
 *
 * Escalates only where it has to, and only for the people in the clash: a bare
 * first name, then a surname initial, then the full surname. Everybody else in
 * the list is untouched, so one pair of unlucky Bens cannot turn the whole page
 * into a directory.
 *
 * Two people with the same first name and no recorded surname cannot be told
 * apart. They are left identical rather than numbered, because "Ben (2)" reads
 * as a fact about a person and is not one.
 */
export function publicNames(people: Named[]): string[] {
  const names = people.map((person) => person.firstName.trim());

  const escalate = (
    current: string[],
    nameFor: (person: Named) => string,
  ): string[] => {
    const groups = new Map<string, number[]>();
    current.forEach((name, index) => {
      groups.set(name, [...(groups.get(name) ?? []), index]);
    });

    const next = [...current];
    for (const indexes of groups.values()) {
      if (indexes.length === 1) continue;
      for (const index of indexes) {
        const longer = nameFor(people[index]).trim();
        // An empty surname has nothing to escalate to; leave the name as it is.
        if (longer !== people[index].firstName.trim()) next[index] = longer;
      }
    }
    return next;
  };

  const withInitials = escalate(names, (p) =>
    p.lastName.trim() ? `${p.firstName.trim()} ${initials(p.lastName)}` : p.firstName.trim(),
  );

  return escalate(withInitials, (p) =>
    p.lastName.trim() ? `${p.firstName.trim()} ${p.lastName.trim()}` : p.firstName.trim(),
  );
}
