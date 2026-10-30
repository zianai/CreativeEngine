export const transitions: Record<string, string[]> = {
  draft: ['needs_input', 'planned'],
  needs_input: ['planned', 'blocked'],
  planned: ['queued', 'blocked'],
  queued: ['running', 'cancelled', 'blocked'],
  running: ['qa_pending', 'queued', 'reconciling', 'failed', 'cancelled', 'blocked'],
  reconciling: ['qa_pending', 'failed', 'cancelled'],
  qa_pending: ['review_pending', 'blocked', 'failed', 'cancelled', 'reconciling', 'queued'],
  review_pending: ['approved', 'rejected', 'revision_pending', 'cancelled'],
  approved: ['completed', 'rejected', 'revision_pending'],
  rejected: ['revision_pending'],
  revision_pending: ['cancelled'],
  completed: [],
  failed: ['queued', 'cancelled'],
  blocked: ['queued', 'cancelled'],
  cancelled: [],
};
export function transition(task: any, status: string) {
  if (task.status !== status && !transitions[task.status]?.includes(status))
    throw new Error(`Invalid task transition ${task.status} → ${status}`);
  return { ...task, status, updated_at: new Date().toISOString() };
}
