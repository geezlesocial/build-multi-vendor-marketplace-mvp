# Content media and storage

## Local development

The local adapter stores files under `CONTENT_STORAGE_DIR` (default `storage/content`) using generated UUID keys. File bytes are not stored in PostgreSQL. The upload endpoint checks file signatures, not only browser MIME or filename extensions.

Defaults:

- Images: 5,000,000 bytes
- Video: 50,000,000 bytes
- Documents/captions: 10,000,000 bytes
- Allowed image signatures: PNG, JPEG, GIF, WebP
- Allowed video signatures: MP4, WebM, Ogg
- Allowed captions/documents: VTT, PDF, DOCX, XLSX, PPTX, CSV

Executables, HTML, scripts, and active-content formats are rejected. Public delivery requires `MediaScanStatus.APPROVED`; with `CONTENT_SCAN_REQUIRED=true` uploads remain quarantined because no scanner is bundled.

## Production requirements

Local disk is not production storage. Before staging, configure a private object store/CDN adapter with encrypted-at-rest storage, access logging, retention/backup policy, range requests for video, and a malware scanner or approved scanning service. Add only secret names to deployment configuration; do not place keys in the repository or database. The owner pays storage, CDN, scanning, and hosting costs.

Public media should be served from the approved CDN with safe content type and disposition headers. Private, draft, and quarantined media must remain authorized-only and absent from sitemap/indexable HTML. Orphan cleanup must check both structured body references and SEO/featured-image references before deletion.
