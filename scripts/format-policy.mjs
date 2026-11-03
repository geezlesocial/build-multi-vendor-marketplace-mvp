const legacyE2eFormatExceptions = new Set(["e2e/product-actions.spec.ts"]);

export function shouldFormatCandidate({ status, path }) {
  if (!path) return false;
  if (status.startsWith("A")) return true;

  const isLegacyApplicationSource = /^apps\/(?:api|web)\/src\//.test(path);
  return !isLegacyApplicationSource && !legacyE2eFormatExceptions.has(path);
}
