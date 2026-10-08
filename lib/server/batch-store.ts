import type { TaskStatus } from '../domain/task';

export interface BatchItemSummary {
  taskId: string;
  conversationId: string;
  folder: string;
  productName: string;
  fileCount: number;
  taskStatus: TaskStatus;
  conflictCount: number;
  draftCount: number;
  approvedCount: number;
  publishedCount: number;
  reviewCount: number;
  mediaPlanId: string | null;
  selectedAssetIds: string[];
  lastError: string | null;
  stage: 'NEW' | 'PROCESSING' | 'NEEDS_ATTENTION' | 'READY_TO_PUBLISH' | 'PUBLISHED' | 'FAILED';
  reason: string;
}

export interface BatchSummary {
  id: string;
  name: string;
  sourceLabel: string;
  targets: Array<{ platformId: string; market: string }>;
  createdAt: string;
  items: BatchItemSummary[];
}

interface ItemRow {
  task_id: string; conversation_id: string; folder: string; product_name: string;
  task_status: TaskStatus; file_count: number; conflict_count: number; draft_count: number;
  approved_count: number; published_count: number; review_count: number;
  media_plan_id: string | null; selected_assets_json: string | null;
  needs_media: number; last_error: string | null;
}

export function classifyBatchItem(row: ItemRow): Pick<BatchItemSummary, 'stage' | 'reason'> {
  if (row.task_status === 'FAILED') return { stage: 'FAILED', reason: '资料处理失败，请打开商品任务检查' };
  if (row.draft_count > 0 && row.published_count === row.draft_count) return { stage: 'PUBLISHED', reason: '所有目标已交付' };
  if (row.task_status === 'CREATED') return { stage: 'NEW', reason: '等待开始资料分析' };
  if (row.conflict_count > 0) return { stage: 'NEEDS_ATTENTION', reason: `${row.conflict_count} 处资料冲突待确认` };
  if (['FACTS_EXTRACTED', 'NEEDS_CONFIRMATION'].includes(row.task_status)
    && row.draft_count > 0 && row.review_count === 0 && row.approved_count === 0 && row.published_count === 0) {
    return { stage: 'NEEDS_ATTENTION', reason: '商品资料已整理，请打开任务确认上新方式' };
  }
  if (row.review_count > 0) {
    return { stage: 'NEEDS_ATTENTION', reason: `${row.draft_count - row.approved_count - row.published_count} 份 Listing 待审核` };
  }
  if (row.draft_count > 0 && row.approved_count + row.published_count === row.draft_count && row.approved_count > 0) {
    if (row.needs_media && (!row.media_plan_id || !row.selected_assets_json || row.selected_assets_json === '[]')) return { stage: 'NEEDS_ATTENTION', reason: '请确认图片/视频与媒体顺序' };
    return { stage: 'READY_TO_PUBLISH', reason: '已通过人工审核，可批量交付' };
  }
  return { stage: 'PROCESSING', reason: '资料分析或 Listing 生成中' };
}

export async function getBatchSummary(DB: D1Database, userId: string, batchId: string): Promise<BatchSummary | null> {
  const batch = await DB.prepare('SELECT id,name,source_label,targets_json,created_at FROM batch_jobs WHERE id=? AND user_id=?')
    .bind(batchId, userId).first<{ id: string; name: string; source_label: string; targets_json: string; created_at: string }>();
  if (!batch) return null;
  const result = await DB.prepare(`SELECT bi.task_id,bi.conversation_id,bi.product_name AS folder,bi.last_error,t.product_name,t.status AS task_status,
    (SELECT COUNT(*) FROM task_files f WHERE f.task_id=bi.task_id) AS file_count,
    (SELECT COUNT(*) FROM fact_conflicts c JOIN product_passports p ON p.id=c.passport_id WHERE p.task_id=bi.task_id AND p.version=(SELECT MAX(version) FROM product_passports WHERE task_id=bi.task_id) AND c.status='OPEN') AS conflict_count,
    (SELECT COUNT(*) FROM platform_drafts d WHERE d.task_id=bi.task_id) AS draft_count,
    (SELECT COUNT(*) FROM platform_drafts d WHERE d.task_id=bi.task_id AND d.status='APPROVED') AS approved_count,
    (SELECT COUNT(*) FROM platform_drafts d WHERE d.task_id=bi.task_id AND d.status='DRAFT_CREATED') AS published_count,
    (SELECT COUNT(*) FROM platform_drafts d WHERE d.task_id=bi.task_id AND d.status IN ('NEEDS_REVIEW','VALIDATED','FAILED')) AS review_count,
    (SELECT CASE WHEN m.status='CONFIRMED' THEN m.id ELSE NULL END FROM media_order_plans m WHERE m.task_id=bi.task_id ORDER BY created_at DESC LIMIT 1) AS media_plan_id,
    c.selected_assets_json,
    (SELECT COUNT(*) FROM platform_drafts d WHERE d.task_id=bi.task_id AND d.platform_id IN ('amazon','shopify')) AS needs_media
    FROM batch_items bi JOIN tasks t ON t.id=bi.task_id JOIN agent_conversations c ON c.id=bi.conversation_id
    WHERE bi.batch_id=? ORDER BY bi.row_number`).bind(batchId).all<ItemRow>();
  return {
    id: batch.id, name: batch.name, sourceLabel: batch.source_label,
    targets: JSON.parse(batch.targets_json), createdAt: batch.created_at,
    items: result.results.map((row) => {
      let selectedAssetIds: string[] = [];
      try { const parsed = JSON.parse(row.selected_assets_json || '[]'); if (Array.isArray(parsed)) selectedAssetIds = parsed.filter((id): id is string => typeof id === 'string'); } catch { /* ignore corrupted historical selection */ }
      return {
        taskId: row.task_id, conversationId: row.conversation_id, folder: row.folder,
        productName: row.product_name === '等待模型识别商品' ? row.folder : row.product_name,
        fileCount: row.file_count, taskStatus: row.task_status, conflictCount: row.conflict_count,
        draftCount: row.draft_count, approvedCount: row.approved_count, publishedCount: row.published_count,
        reviewCount: row.review_count, mediaPlanId: row.media_plan_id, selectedAssetIds, lastError: row.last_error,
        ...classifyBatchItem(row),
      };
    }),
  };
}
