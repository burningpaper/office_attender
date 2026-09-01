/**
 * The controlled vocabulary for absence reasons, and what each one means.
 *
 * The categories are descriptive only. What a category *does* to someone's
 * compliance is a separate, editable policy decision (DESIGN.md §10): today
 * every recorded reason excuses the day, whatever it says. That split is
 * deliberate - it means a misclassification changes a label in the interface
 * rather than a verdict about a person.
 */

export const REASON_CATEGORIES = [
  "SICK",
  "ANNUAL_LEAVE",
  "FAMILY_RESPONSIBILITY",
  "TRAVEL_OTHER_OFFICE",
  "WFH_APPROVED",
  "PUBLIC_HOLIDAY_OR_CLOSURE",
  "PERSONAL_EMERGENCY",
  "UNKNOWN",
] as const;

export type ReasonCategory = (typeof REASON_CATEGORIES)[number];

export const CATEGORY_GUIDE: Record<ReasonCategory, string> = {
  SICK: "Illness of the employee themselves, including booking off sick.",
  ANNUAL_LEAVE:
    "Planned, approved time off: annual leave, birthday leave, or 'booked off' with no illness mentioned.",
  FAMILY_RESPONSIBILITY:
    "Time off for a family member — a sick child, a bereavement, a family emergency. In South African labour law this is a distinct entitlement, often abbreviated 'Fam Res'.",
  TRAVEL_OTHER_OFFICE:
    "Working, but from another city, office or a work trip. The person is on duty, just not in this building.",
  WFH_APPROVED: "Working from home.",
  PUBLIC_HOLIDAY_OR_CLOSURE:
    "The office was shut — a public holiday, a shutdown, or a closure. Nobody could have attended.",
  PERSONAL_EMERGENCY:
    "An unplanned personal disruption that is not illness and not family: car trouble, a burst pipe, moving house, a storm.",
  UNKNOWN:
    "The note does not say why the person was absent. Use this rather than guessing.",
};
