/**
 * Montants financiers du dashboard : réservés à « finance.revenue.view ».
 * Sans elle, seuls les compteurs restent visibles (permission stats.view).
 */
export function redactRevenue<TotalsRow, WithdrawalRow extends { status: string; _count: unknown; _sum: unknown }>(
  canSeeRevenue: boolean, totals: TotalsRow[], withdrawals: WithdrawalRow[],
): { totals: TotalsRow[]; withdrawals: Array<Pick<WithdrawalRow, 'status' | '_count'>> } {
  if (canSeeRevenue) return { totals, withdrawals };
  return { totals: [], withdrawals: withdrawals.map(({ status, _count }) => ({ status, _count })) };
}
