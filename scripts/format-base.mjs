const isZeroSha = (value) => /^0+$/.test(value);

export function selectFormatBase({ requestedBase, githubBaseRef, hasCommit }) {
  const candidates = [
    requestedBase,
    githubBaseRef ? `origin/${githubBaseRef}` : undefined,
    "origin/main",
  ];

  for (const candidate of candidates) {
    if (candidate && !isZeroSha(candidate) && hasCommit(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Could not find a valid Git base commit for the formatting check.",
  );
}
