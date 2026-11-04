type StoreContent = {
  posts: { slug: string; title: string; excerpt: string | null }[];
  pages: { slug: string; title: string }[];
};

export function StoreContentLinks({
  slug,
  content,
}: {
  slug: string;
  content?: StoreContent;
}) {
  if (!content || content.posts.length + content.pages.length === 0)
    return null;

  return (
    <section className="storeContentLinks">
      <h2>From this store</h2>
      {content.pages.map((page) => (
        <p key={`page-${page.slug}`}>
          <a href={`/store/${slug}/pages/${page.slug}`}>{page.title}</a>
        </p>
      ))}
      {content.posts.map((post) => (
        <article className="card cardBody" key={`post-${post.slug}`}>
          <h3>
            <a href={`/store/${slug}/blog/${post.slug}`}>{post.title}</a>
          </h3>
          {post.excerpt && <p>{post.excerpt}</p>}
        </article>
      ))}
    </section>
  );
}
