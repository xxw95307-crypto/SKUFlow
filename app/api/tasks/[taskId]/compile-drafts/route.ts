import { ensureSchema, getBindings } from '@/db/client';
import type { DraftValidationIssue, ProductPassport } from '@/lib/domain/product-passport';
import { getPlatformProfile } from '@/lib/platforms/registry';
import { platformAdapterRegistry } from '@/lib/platform-sdk';
import { getProductPassport, saveCompiledDrafts } from '@/lib/server/passport-store';

export const dynamic = 'force-dynamic';

interface DraftCompileSummary {
  draftId: string;
  platformId: string;
  market: string;
  adapterId: string;
  mappedFields: number;
  skippedFields: number;
  issues: DraftValidationIssue[];
  status: 'NEEDS_REVIEW' | 'VALIDATED';
}

export async function POST(_request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await context.params;
    const { DB } = getBindings();
    const task = await DB.prepare('SELECT id FROM tasks WHERE id = ?').bind(taskId).first<{ id: string }>();
    if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });
    const passport = await getProductPassport(DB, taskId);
    if (!passport) return Response.json({ error: 'Task not found' }, { status: 404 });
    if (passport.status === 'LOCKED') return Response.json({ error: 'Product passport is locked' }, { status: 409 });
    if (passport.platformDrafts.length === 0) {
      return Response.json({ error: '当前任务没有平台草稿' }, { status: 409 });
    }

    const writes = [];
    const summaries: DraftCompileSummary[] = [];
    for (const draft of passport.platformDrafts) {
      const platform = getPlatformProfile(draft.platformId);
      const adapter = platformAdapterRegistry.resolve(draft.platformId);
      const result = await adapter.compile({ passport, platform, draft });
      const payload: Record<string, unknown> = {
        ...result.payload,
        adapter: {
          id: adapter.id,
          version: adapter.version,
          kind: adapter.kind,
          ruleId: adapter.rules.id,
          ruleVersion: adapter.rules.version,
        },
      };
      const status = result.validationIssues.some((issue) => issue.severity === 'error')
        ? 'NEEDS_REVIEW' as const
        : 'VALIDATED' as const;

      writes.push({
        draftId: draft.id,
        status,
        schemaVersion: result.schemaVersion,
        payload,
        validationIssues: result.validationIssues,
      });
      summaries.push({
        draftId: draft.id,
        platformId: draft.platformId,
        market: draft.market,
        adapterId: adapter.id,
        mappedFields: result.mappedFields,
        skippedFields: result.skippedFields,
        issues: result.validationIssues,
        status,
      });
    }

    await saveCompiledDrafts(DB, passport.id, writes);
    const refreshedPassport = await getProductPassport(DB, taskId) as ProductPassport;
    return Response.json({
      passport: refreshedPassport,
      summary: {
        compiledDrafts: summaries.length,
        validatedDrafts: summaries.filter((item) => item.status === 'VALIDATED').length,
        reviewDrafts: summaries.filter((item) => item.status === 'NEEDS_REVIEW').length,
        mappedFields: summaries.reduce((sum, item) => sum + item.mappedFields, 0),
        issueCount: summaries.reduce((sum, item) => sum + item.issues.length, 0),
        drafts: summaries,
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unable to compile platform drafts' },
      { status: 500 },
    );
  }
}
