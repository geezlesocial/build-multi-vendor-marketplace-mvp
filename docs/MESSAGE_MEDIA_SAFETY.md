# Message attachment scanning and previews

Message images and videos remain private until the malware scanner approves them. The local Compose setup provides ClamAV on `127.0.0.1:3310`; the port is bound to loopback because ClamAV's daemon protocol has no built-in authentication or transport encryption.

For local development:

1. Start the scanner with `docker compose up -d clamav` and wait until `docker compose ps clamav` reports it as healthy.
2. In both `.env` and `apps/api/.env`, set `CONTENT_SCAN_REQUIRED=true`, `CONTENT_SCANNER_AVAILABLE=true`, `CONTENT_SCANNER_HOST=127.0.0.1`, and `CONTENT_SCANNER_PORT=3310`.
3. Restart the API so it loads the scanner configuration.
4. For existing quarantined messages, the sender can choose **Retry safety scan** in the header message popover or full Messages page. After approval, both participants' refreshed views render the image or a muted, in-view video preview. Users can play/pause and enable sound with the player controls. Reduced-motion preferences disable automatic video preview.

Do not turn off the scan requirement to make uploads visible. A scanner error is not treated as approval; the attachment stays private until a successful scan.
