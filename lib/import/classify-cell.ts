/**
 * Cell value -> attendance state. Pure rules, no model.
 *
 * The grid is already binary, so this is nearly trivial - which is the point.
 * The only judgement is that anything non-binary is an explanation rather than
 * a value, and under the agreed policy (DESIGN.md §10) an explanation excuses
 * the day. What the explanation *means* is stage 5's problem; that it exists is
 * decidable here, deterministically.
 */

export type CellClassification =
  | { state: "PRESENT"; reasonText: null }
  | { state: "ABSENT"; reasonText: null }
  | { state: "ABSENT_EXPLAINED"; reasonText: string };

export function classifyCell(rawValue: string): CellClassification {
  const value = rawValue.trim();

  if (value === "1") return { state: "PRESENT", reasonText: null };
  if (value === "0" || value === "") return { state: "ABSENT", reasonText: null };

  // Anything else is a human writing a reason where a value should be.
  return { state: "ABSENT_EXPLAINED", reasonText: value };
}
