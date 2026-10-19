import { ContentStatus } from '@prisma/client';
import { audit, prisma } from './security.js';

export async function publishDueContent() {
  const now = new Date();
  const [scheduledPosts, scheduledPages] = await Promise.all([
    prisma.blogPost.findMany({ where: { status: ContentStatus.SCHEDULED, scheduledAt: { lte: now } }, select: { id: true, bodyJson: true, featuredImageId: true, ogImageId: true } }),
    prisma.contentPage.findMany({ where: { status: ContentStatus.SCHEDULED, scheduledAt: { lte: now } }, select: { id: true, bodyJson: true, ogImageId: true } })
  ]);
  const mediaReady = async (ids: string[]) => {
    if (!ids.length) return true;
    const approved = await prisma.mediaAsset.count({ where: { id: { in: ids }, scanStatus: 'APPROVED' } });
    return approved === new Set(ids).size;
  };
  let postCount = 0;
  let pageCount = 0;
  for (const post of scheduledPosts) {
    const blocks = (Array.isArray(post.bodyJson) ? post.bodyJson : []) as Array<{ mediaId?: string; captionMediaId?: string }>;
    const ids = blocks.flatMap(block => [block.mediaId, block.captionMediaId]).filter((id): id is string => Boolean(id));
    if (!(await mediaReady([...ids, post.featuredImageId, post.ogImageId].filter((id): id is string => Boolean(id)))) ) continue;
    const result = await prisma.blogPost.updateMany({ where: { id: post.id, status: ContentStatus.SCHEDULED, scheduledAt: { lte: now } }, data: { status: ContentStatus.PUBLISHED, publishedAt: now, scheduledAt: null, archivedAt: null } });
    postCount += result.count;
  }
  for (const page of scheduledPages) {
    const blocks = (Array.isArray(page.bodyJson) ? page.bodyJson : []) as Array<{ mediaId?: string; captionMediaId?: string }>;
    const ids = blocks.flatMap(block => [block.mediaId, block.captionMediaId]).filter((id): id is string => Boolean(id));
    if (!(await mediaReady([...ids, page.ogImageId].filter((id): id is string => Boolean(id)))) ) continue;
    const result = await prisma.contentPage.updateMany({ where: { id: page.id, status: ContentStatus.SCHEDULED, scheduledAt: { lte: now } }, data: { status: ContentStatus.PUBLISHED, publishedAt: now, scheduledAt: null, archivedAt: null } });
    pageCount += result.count;
  }
  if (postCount) await audit(undefined, 'CONTENT_POSTS_SCHEDULED_PUBLISHED', 'BlogPost', undefined, { count: postCount });
  if (pageCount) await audit(undefined, 'CONTENT_PAGES_SCHEDULED_PUBLISHED', 'ContentPage', undefined, { count: pageCount });
  return { posts: postCount, pages: pageCount };
}
