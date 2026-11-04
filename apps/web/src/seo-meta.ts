export function applySeoMeta(
  title: string,
  description: string,
  fallbackTitle: string,
) {
  const previousTitle = document.title;
  const descriptionMeta = document.querySelector<HTMLMetaElement>(
    'meta[name="description"]',
  );
  const createdDescription = !descriptionMeta;
  const metaDescription = descriptionMeta ?? document.createElement("meta");
  if (createdDescription) {
    metaDescription.name = "description";
    document.head.append(metaDescription);
  }
  const previousDescription = metaDescription.content;
  const safeTitle = title.trim();
  const safeDescription = description.trim();
  document.title = safeTitle || fallbackTitle;
  if (safeDescription) metaDescription.content = safeDescription;

  return () => {
    document.title = previousTitle;
    if (createdDescription) metaDescription.remove();
    else metaDescription.content = previousDescription;
  };
}
