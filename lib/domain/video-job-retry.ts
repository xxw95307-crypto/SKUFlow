export function isReusableVideoJob(job: { status: string; error?: string | null }): boolean {
  if (['FAILED', 'CANCELED', 'TRIM_DRAFT'].includes(job.status)) return false;
  // Older releases recorded definitive account denials as an unknown submission.
  // Those requests were rejected before a provider task could be created.
  if (job.status === 'SUBMISSION_UNKNOWN' && /overdue-payment|account is in good standing|Arrearage/i.test(job.error ?? '')) return false;
  return true;
}
