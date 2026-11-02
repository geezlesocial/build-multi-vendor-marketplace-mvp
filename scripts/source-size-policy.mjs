export function countPhysicalLines(source) {
  if (source.length === 0) return 0;

  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

export function evaluateSourceSize(fileLines, baseline) {
  if (
    !Number.isInteger(baseline.defaultMaxLines) ||
    baseline.defaultMaxLines < 1
  ) {
    throw new TypeError(
      "Source-size baseline defaultMaxLines must be a positive integer.",
    );
  }
  if (
    !baseline.files ||
    typeof baseline.files !== "object" ||
    Array.isArray(baseline.files)
  ) {
    throw new TypeError(
      "Source-size baseline files must be a path-to-line-count object.",
    );
  }

  return Object.entries(fileLines)
    .filter(([path, lines]) => {
      if (!Number.isInteger(lines) || lines < 0) {
        throw new TypeError(`Invalid source line count for ${path}.`);
      }
      const limit = baseline.files[path] ?? baseline.defaultMaxLines;
      if (!Number.isInteger(limit) || limit < 1) {
        throw new TypeError(`Invalid source-size limit for ${path}.`);
      }
      return lines > limit;
    })
    .map(([path, lines]) => ({
      path,
      lines,
      limit: baseline.files[path] ?? baseline.defaultMaxLines,
    }));
}

export function findStaleSourceSizeExceptions(fileLines, baseline) {
  return Object.keys(baseline.files).filter(
    (path) =>
      fileLines[path] === undefined ||
      fileLines[path] <= baseline.defaultMaxLines,
  );
}
