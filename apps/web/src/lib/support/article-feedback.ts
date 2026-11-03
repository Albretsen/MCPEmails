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

/** Longer than any article id; a longer one is malformed, not unknown. */
export const MAX_ARTICLE_ID_LENGTH = 120;

export type ParsedArticleFeedback =
  | { kind: 'vote'; vote: ArticleFeedback }
  /** Well formed, but no such article: answered 204, nothing written. */
  | { kind: 'unknown_article' }
  /** Not a vote at all: answered 400. */
  | { kind: 'invalid'; error: 'invalid_body' | 'invalid_article_id' | 'invalid_helpful' | 'invalid_locale' };

/**
 * Classify a request body. A missing `locale` means English; a locale that is
 * present but not a help locale is malformed.
 */
export async function parseArticleFeedback(body: unknown): Promise<ParsedArticleFeedback> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'invalid', error: 'invalid_body' };
  const { articleId, locale, helpful } = body as Record<string, unknown>;
  if (typeof articleId !== 'string' || articleId.length === 0 || articleId.length > MAX_ARTICLE_ID_LENGTH) {
    return { kind: 'invalid', error: 'invalid_article_id' };
  }
  if (typeof helpful !== 'boolean') return { kind: 'invalid', error: 'invalid_helpful' };
  let loc = 'en';
  if (locale !== undefined && locale !== null) {
    if (typeof locale !== 'string' || !HELP_LOCALES.includes(locale)) return { kind: 'invalid', error: 'invalid_locale' };
    loc = locale;
  }
  if (!(await knownArticleIds()).has(articleId)) return { kind: 'unknown_article' };
  return { kind: 'vote', vote: { articleId, locale: loc, helpful } };
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
