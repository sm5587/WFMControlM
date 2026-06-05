/** True when notify is allowed (never sent, or cooldown elapsed). */
export function isNotifyEligible(emailSentAt: string | null | undefined, cooldownMins: number): boolean {
  if (!emailSentAt) return true;
  const elapsedMs = Date.now() - new Date(emailSentAt).getTime();
  return elapsedMs >= cooldownMins * 60 * 1000;
}

/** Minutes remaining until notify is available again (0 if eligible now). */
export function minutesUntilNotifyEligible(emailSentAt: string | null | undefined, cooldownMins: number): number {
  if (!emailSentAt) return 0;
  const remainingMs = cooldownMins * 60 * 1000 - (Date.now() - new Date(emailSentAt).getTime());
  return remainingMs > 0 ? Math.ceil(remainingMs / 60000) : 0;
}
