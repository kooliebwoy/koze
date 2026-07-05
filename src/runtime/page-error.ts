/**
 * PageError — throw from a route's load scope to return a specific HTTP status page.
 *
 * Without PageError, any thrown error becomes a 500. PageError lets you return
 * the correct HTTP status (404, 403, 401, etc.) and an optional message.
 *
 * @example
 * const post = await db.posts.findOne({ id: params.id });
 * if (!post) throw new PageError(404);
 * if (!post.isPublished) throw new PageError(403, 'This post is not published');
 */
export class PageError extends Error {
  readonly isPageError = true;
  readonly status: number;
  constructor(status: number, message?: string) {
    super(message);
    this.name = 'PageError';
    this.status = status;
  }
}
