import { useEffect, useState } from 'react';

type Article = { id: string; title: string; body: string; updatedAt: string };

export function JimaKnowledgeArticle({ id }: { id: string }) {
  const [article, setArticle] = useState<Article | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    fetch(`/api/ai/knowledge/${encodeURIComponent(id)}`, { credentials: 'include' })
      .then(async response => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? 'Help article unavailable.');
        return body as Article;
      })
      .then(value => { if (active) { setArticle(value); document.title = `${value.title} | Market Lane Help`; } })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Help article unavailable.'); });
    return () => { active = false; };
  }, [id]);

  if (error) return <section className="page"><p className="eyebrow">Jima source</p><h1>Help article unavailable</h1><p className="notice" role="alert">{error}</p><a href="/">Return to Market Lane</a></section>;
  if (!article) return <section className="page" aria-busy="true"><p className="eyebrow">Jima source</p><h1>Loading approved help</h1></section>;
  return <article className="page jimaKnowledgePage"><p className="eyebrow">Published marketplace help · source for Jima AI</p><h1>{article.title}</h1><p className="muted">Updated {new Date(article.updatedAt).toLocaleDateString()}</p><div className="jimaKnowledgeBody">{article.body}</div><a href="/">Return to Market Lane</a></article>;
}
