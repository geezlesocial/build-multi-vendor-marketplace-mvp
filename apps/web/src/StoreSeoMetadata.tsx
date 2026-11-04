import { useEffect, useState } from "react";
import { applySeoMeta } from "./seo-meta.js";

type StoreSeo = { seoTitle: string | null; seoDescription: string | null };

export function StoreSeoMetadata({
  slug,
  store,
}: {
  slug: string;
  store: { name: string; theme: { description: string } };
}) {
  const storeName = store.name;
  const fallbackDescription = store.theme.description;
  const [seo, setSeo] = useState<StoreSeo | null>(null);

  useEffect(() => {
    let active = true;
    setSeo(null);
    fetch(`/api/public/seo/stores/${encodeURIComponent(slug)}`, {
      credentials: "omit",
    })
      .then((response) =>
        response.ok ? (response.json() as Promise<StoreSeo>) : null,
      )
      .then((result) => {
        if (active && result) setSeo(result);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [slug]);

  const fallbackTitle = `${storeName} | Market Lane`;
  useEffect(
    () =>
      applySeoMeta(
        seo?.seoTitle || fallbackTitle,
        seo?.seoDescription || fallbackDescription || `Shop at ${storeName}.`,
        fallbackTitle,
      ),
    [fallbackDescription, fallbackTitle, seo, storeName],
  );

  return null;
}
