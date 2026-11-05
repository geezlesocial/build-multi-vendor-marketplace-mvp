import { MediaKind } from "@prisma/client";

type DetectedFile = { kind: MediaKind; mime: string; extension: string };

const fail = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });

export const supportedStoreMediaTypes: Record<
  string,
  { kind: MediaKind; extensions: string[] }
> = {
  "image/png": { kind: MediaKind.IMAGE, extensions: ["png"] },
  "image/jpeg": { kind: MediaKind.IMAGE, extensions: ["jpg", "jpeg"] },
  "image/webp": { kind: MediaKind.IMAGE, extensions: ["webp"] },
  "image/avif": { kind: MediaKind.IMAGE, extensions: ["avif"] },
  "image/heic": { kind: MediaKind.IMAGE, extensions: ["heic"] },
  "image/heif": { kind: MediaKind.IMAGE, extensions: ["heic", "heif"] },
  "image/gif": { kind: MediaKind.IMAGE, extensions: ["gif"] },
  "video/mp4": { kind: MediaKind.VIDEO, extensions: ["mp4", "m4v"] },
  "video/quicktime": { kind: MediaKind.VIDEO, extensions: ["mov"] },
  "video/x-m4v": { kind: MediaKind.VIDEO, extensions: ["m4v"] },
  "video/3gpp": { kind: MediaKind.VIDEO, extensions: ["3gp"] },
  "video/webm": { kind: MediaKind.VIDEO, extensions: ["webm"] },
  "video/x-matroska": { kind: MediaKind.VIDEO, extensions: ["mkv"] },
  "video/matroska": { kind: MediaKind.VIDEO, extensions: ["mkv"] },
  "video/ogg": { kind: MediaKind.VIDEO, extensions: ["ogv", "ogg"] },
  "application/pdf": { kind: MediaKind.DOCUMENT, extensions: ["pdf"] },
  "application/msword": { kind: MediaKind.DOCUMENT, extensions: ["doc"] },
  "text/csv": { kind: MediaKind.DOCUMENT, extensions: ["csv"] },
  "text/vtt": { kind: MediaKind.CAPTION, extensions: ["vtt"] },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    kind: MediaKind.DOCUMENT,
    extensions: ["docx"],
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    kind: MediaKind.DOCUMENT,
    extensions: ["xlsx"],
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    kind: MediaKind.DOCUMENT,
    extensions: ["pptx"],
  },
};

export function detectStoreMedia(
  bytes: Buffer,
  extension: string,
  claimedMime: string,
): DetectedFile {
  let detected: DetectedFile | null = null;
  const isIsoBmff = bytes.subarray(4, 8).toString("ascii") === "ftyp";
  const brands = isIsoBmff
    ? bytes
        .subarray(8, Math.min(bytes.length, 256))
        .toString("ascii")
        .toLowerCase()
    : "";
  const ebmlHeader = bytes
    .subarray(0, 4)
    .equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  const ebmlDocumentType = ebmlHeader
    ? bytes
        .subarray(0, Math.min(bytes.length, 1024))
        .toString("ascii")
        .toLowerCase()
    : "";
  if (
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    detected = { kind: MediaKind.IMAGE, mime: "image/png", extension: "png" };
  else if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
    detected = { kind: MediaKind.IMAGE, mime: "image/jpeg", extension: "jpg" };
  else if (
    ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
  )
    detected = { kind: MediaKind.IMAGE, mime: "image/gif", extension: "gif" };
  else if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    detected = { kind: MediaKind.IMAGE, mime: "image/webp", extension: "webp" };
  else if (isIsoBmff && /(avif|avis)/.test(brands))
    detected = { kind: MediaKind.IMAGE, mime: "image/avif", extension: "avif" };
  else if (isIsoBmff && /(heic|heix|hevc|hevx|mif1|msf1)/.test(brands))
    detected = {
      kind: MediaKind.IMAGE,
      mime: claimedMime === "image/heif" ? "image/heif" : "image/heic",
      extension,
    };
  else if (
    isIsoBmff &&
    supportedStoreMediaTypes[claimedMime]?.kind === MediaKind.VIDEO
  )
    detected = { kind: MediaKind.VIDEO, mime: claimedMime, extension };
  else if (
    ebmlHeader &&
    extension === "webm" &&
    ebmlDocumentType.includes("webm")
  )
    detected = { kind: MediaKind.VIDEO, mime: "video/webm", extension: "webm" };
  else if (
    ebmlHeader &&
    extension === "mkv" &&
    ebmlDocumentType.includes("matroska") &&
    supportedStoreMediaTypes[claimedMime]?.kind === MediaKind.VIDEO
  )
    detected = { kind: MediaKind.VIDEO, mime: claimedMime, extension: "mkv" };
  else if (bytes.subarray(0, 4).toString("ascii") === "OggS")
    detected = { kind: MediaKind.VIDEO, mime: "video/ogg", extension: "ogv" };
  else if (bytes.subarray(0, 5).toString("ascii") === "%PDF-")
    detected = {
      kind: MediaKind.DOCUMENT,
      mime: "application/pdf",
      extension: "pdf",
    };
  else if (
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) &&
    extension === "doc"
  )
    detected = {
      kind: MediaKind.DOCUMENT,
      mime: "application/msword",
      extension: "doc",
    };
  else if (
    bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) &&
    ["docx", "xlsx", "pptx"].includes(extension)
  )
    detected = {
      kind: MediaKind.DOCUMENT,
      mime: (
        {
          docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        } as const
      )[extension as "docx" | "xlsx" | "pptx"],
      extension,
    };
  else if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
    throw fail(
      415,
      "File extension does not match a supported Office document content type.",
    );
  else if (
    bytes.subarray(0, 7).toString("utf8").toUpperCase().startsWith("WEBVTT")
  )
    detected = { kind: MediaKind.CAPTION, mime: "text/vtt", extension: "vtt" };
  else if (
    extension === "csv" &&
    /^[\x09\x0a\x0d\x20-\x7e]*$/.test(bytes.toString("utf8"))
  )
    detected = { kind: MediaKind.DOCUMENT, mime: "text/csv", extension: "csv" };
  if (!detected || detected.mime !== claimedMime)
    throw fail(415, "File content does not match a supported media type.");
  const allowed = supportedStoreMediaTypes[claimedMime];
  if (!allowed || !allowed.extensions.includes(extension))
    throw fail(415, "File extension does not match its verified content type.");
  return detected;
}
