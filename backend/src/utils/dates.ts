/** Âge en années révolues à la date `now` (UTC). */
export function ageOn(birth: Date, now = new Date()): number {
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const m = now.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age;
}
export const toDateOnly = (d: Date) => d.toISOString().slice(0, 10);
