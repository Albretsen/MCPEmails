/**
 * "Was this helpful?" under each help article.
 *
 * One vote per voter per article (see the help_article_feedback migration):
 * the voter is the signed-in user, else an HMAC of the client IP, and voting
 * again overwrites the earlier answer. Only ids of articles that exist are
 * stored, so the table holds a bounded vocabulary.
 */
import { flattenArticles } from '@/lib/support/articles.mjs';
import { getHelpCenterData } from '@/lib/support/help-center-data.mjs';
import { HELP_LOCALES } from '@/lib/support/help-content.mjs';

export interface ArticleFeedback {
  articleId: string;
  locale: string;
  helpful: boolean;
}

export interface ArticleFeedbackRow {
  article_id: string;
  locale: string;
  helpful: boolean;
  voter_key: string;
  user_id: string | null;
  updated_at: string;
}

export interface ArticleFeedbackStore {
  upsert(row: ArticleFeedbackRow): Promise<boolean>;
}

let knownIds: Promise<Set<string>> | null = null;

/** Every article id in the help center (ids are the same in every locale). */
export function knownArticleIds(): Promise<Set<string>> {
  knownIds ??= (async () => {
    const { categories } = await getHelpCenterData('en');
    return new Set(flattenArticles(categories).map((a: { id: string }) => a.id));
  })();
  return knownIds;
}

/** The vote in the body, or null when it is not one. */
export async function parseArticleFeedback(body: unknown): Promise<ArticleFeedback | null> {
  if (!body || typeof body !== 'object') return null;
  const { articleId, locale, helpful } = body as Record<string, unknown>;
  if (typeof articleId !== 'string' || typeof helpful !== 'boolean') return null;
  if (!(await knownArticleIds()).has(articleId)) return null;
  const loc = typeof locale === 'string' && HELP_LOCALES.includes(locale) ? locale : 'en';
  return { articleId, locale: loc, helpful };
}

/** `u:<id>` for a signed-in voter, `ip:<hash>` otherwise, null when neither is known. */
export function voterKey(userId: string | null, ipHash: string | null): string | null {
  if (userId) return `u:${userId}`;
  if (ipHash) return `ip:${ipHash}`;
  return null;
}

export function createSupabaseArticleFeedbackStore(db: {
  from: (table: string) => {
    upsert: (row: ArticleFeedbackRow, opts: { onConflict: string }) => PromiseLike<{ error: { message: string } | null }>;
  };
}): ArticleFeedbackStore {
  return {
    async upsert(row) {
      const { error } = await db
        .from('help_article_feedback')
        .upsert(row, { onConflict: 'article_id,voter_key' });
      if (error) console.error('[help-feedback] upsert failed', { error: error.message });
      return !error;
    },
  };
}
