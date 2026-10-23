-- Platform branding and Store theme references must be raster image assets.
-- Store favicon is stored in the existing theme JSON, so this remains additive
-- and does not rewrite Store or PlatformBranding records.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM (
            SELECT s."id" AS expected_store_id, s."logoMediaId" AS media_id, TRUE AS allow_global
              FROM "Store" s WHERE s."logoMediaId" IS NOT NULL
            UNION ALL
            SELECT s."id", s."bannerMediaId", TRUE
              FROM "Store" s WHERE s."bannerMediaId" IS NOT NULL
            UNION ALL
            SELECT s."id", refs.value, TRUE
              FROM "Store" s
              CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(s."themeDraftJson") = 'object' THEN s."themeDraftJson" ELSE '{}'::jsonb END) refs
             WHERE refs.key IN ('logoMediaId', 'faviconMediaId', 'bannerMediaId') AND refs.value NOT IN ('', 'null')
            UNION ALL
            SELECT s."id", refs.value, TRUE
              FROM "Store" s
              CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(s."themePublishedJson") = 'object' THEN s."themePublishedJson" ELSE '{}'::jsonb END) refs
             WHERE refs.key IN ('logoMediaId', 'faviconMediaId', 'bannerMediaId') AND refs.value NOT IN ('', 'null')
            UNION ALL
            SELECT NULL::TEXT, refs.value, FALSE
              FROM "PlatformBranding" b
              CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(b."draftJson") = 'object' THEN b."draftJson" ELSE '{}'::jsonb END) refs
             WHERE refs.key IN ('logoMediaId', 'alternateLogoMediaId', 'faviconMediaId', 'defaultAvatarMediaId', 'socialImageMediaId') AND refs.value NOT IN ('', 'null')
            UNION ALL
            SELECT NULL::TEXT, refs.value, FALSE
              FROM "PlatformBranding" b
              CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(b."publishedJson") = 'object' THEN b."publishedJson" ELSE '{}'::jsonb END) refs
             WHERE refs.key IN ('logoMediaId', 'alternateLogoMediaId', 'faviconMediaId', 'defaultAvatarMediaId', 'socialImageMediaId') AND refs.value NOT IN ('', 'null')
        ) AS refs
        LEFT JOIN "MediaAsset" media ON media."id" = refs.media_id
        WHERE media."id" IS NULL
           OR media."kind" <> 'IMAGE'
           OR media."uploadStatus" <> 'COMPLETE'
           OR (refs.allow_global AND media."storeId" IS NOT NULL AND media."storeId" IS DISTINCT FROM refs.expected_store_id)
           OR (NOT refs.allow_global AND media."storeId" IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'Cannot install branding image guards: an existing logo, favicon, banner, avatar, or social image reference is missing, incomplete, non-image, or outside its tenant scope. Correct the references, then retry this additive migration.';
    END IF;
END;
$$;

CREATE FUNCTION validate_branding_media_reference_set(media_ids TEXT[], expected_store_id TEXT, platform_only BOOLEAN) RETURNS VOID AS $$
DECLARE
    media_id TEXT;
    media_store_id TEXT;
    media_upload_status "MediaUploadStatus";
    media_kind "MediaKind";
BEGIN
    -- Serialize reference writes against MediaAsset kind changes. Acquire locks
    -- in media-id order so a theme with several images has a stable lock order.
    FOR media_id IN
        SELECT DISTINCT candidate
          FROM unnest(COALESCE(media_ids, ARRAY[]::TEXT[])) AS refs(candidate)
         WHERE candidate IS NOT NULL
         ORDER BY candidate
    LOOP
        PERFORM pg_advisory_xact_lock(hashtext('branding-media-reference'), hashtext(media_id));
        SELECT "storeId", "uploadStatus", "kind"
          INTO media_store_id, media_upload_status, media_kind
          FROM "MediaAsset" WHERE "id" = media_id;
        IF NOT FOUND OR media_kind IS DISTINCT FROM 'IMAGE' OR media_upload_status IS DISTINCT FROM 'COMPLETE'
           OR (platform_only AND media_store_id IS NOT NULL)
           OR (NOT platform_only AND media_store_id IS NOT NULL AND media_store_id IS DISTINCT FROM expected_store_id) THEN
            RAISE EXCEPTION 'Branding references must use complete image media within the permitted tenant scope';
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE FUNCTION enforce_store_branding_image_scope() RETURNS trigger AS $$
DECLARE
    media_ids TEXT[];
BEGIN
    media_ids := ARRAY[NEW."logoMediaId", NEW."bannerMediaId"] || ARRAY(
        SELECT value FROM (
            SELECT refs.value
              FROM jsonb_each_text(CASE WHEN jsonb_typeof(NEW."themeDraftJson") = 'object' THEN NEW."themeDraftJson" ELSE '{}'::jsonb END) refs
             WHERE refs.key IN ('logoMediaId', 'faviconMediaId', 'bannerMediaId') AND refs.value NOT IN ('', 'null')
            UNION ALL
            SELECT refs.value
              FROM jsonb_each_text(CASE WHEN jsonb_typeof(NEW."themePublishedJson") = 'object' THEN NEW."themePublishedJson" ELSE '{}'::jsonb END) refs
             WHERE refs.key IN ('logoMediaId', 'faviconMediaId', 'bannerMediaId') AND refs.value NOT IN ('', 'null')
        ) all_refs
    );
    PERFORM validate_branding_media_reference_set(media_ids, NEW."id", FALSE);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Store_branding_image_scope_guard"
BEFORE INSERT OR UPDATE OF "id", "logoMediaId", "bannerMediaId", "themeDraftJson", "themePublishedJson" ON "Store"
FOR EACH ROW EXECUTE FUNCTION enforce_store_branding_image_scope();

CREATE FUNCTION enforce_platform_branding_image_kind() RETURNS trigger AS $$
DECLARE
    media_ids TEXT[];
BEGIN
    media_ids := ARRAY(
        SELECT value FROM (
            SELECT refs.value
              FROM jsonb_each_text(CASE WHEN jsonb_typeof(NEW."draftJson") = 'object' THEN NEW."draftJson" ELSE '{}'::jsonb END) refs
             WHERE refs.key IN ('logoMediaId', 'alternateLogoMediaId', 'faviconMediaId', 'defaultAvatarMediaId', 'socialImageMediaId') AND refs.value NOT IN ('', 'null')
            UNION ALL
            SELECT refs.value
              FROM jsonb_each_text(CASE WHEN jsonb_typeof(NEW."publishedJson") = 'object' THEN NEW."publishedJson" ELSE '{}'::jsonb END) refs
             WHERE refs.key IN ('logoMediaId', 'alternateLogoMediaId', 'faviconMediaId', 'defaultAvatarMediaId', 'socialImageMediaId') AND refs.value NOT IN ('', 'null')
        ) all_refs
    );
    PERFORM validate_branding_media_reference_set(media_ids, NULL, TRUE);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PlatformBranding_image_kind_guard"
BEFORE INSERT OR UPDATE OF "draftJson", "publishedJson" ON "PlatformBranding"
FOR EACH ROW EXECUTE FUNCTION enforce_platform_branding_image_kind();

-- A referenced branding asset cannot later be reclassified as video/document
-- through a direct MediaAsset update, bypassing the reference-side guards.
CREATE FUNCTION prevent_retyping_referenced_branding_media() RETURNS trigger AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('branding-media-reference'), hashtext(OLD."id"));
    IF NEW."kind" <> 'IMAGE' AND (
        EXISTS (SELECT 1 FROM "Store" WHERE "logoMediaId" = OLD."id" OR "bannerMediaId" = OLD."id") OR
        EXISTS (
            SELECT 1 FROM "Store" s
             WHERE EXISTS (SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(s."themeDraftJson") = 'object' THEN s."themeDraftJson" ELSE '{}'::jsonb END) refs WHERE refs.key IN ('logoMediaId', 'faviconMediaId', 'bannerMediaId') AND refs.value = OLD."id")
                OR EXISTS (SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(s."themePublishedJson") = 'object' THEN s."themePublishedJson" ELSE '{}'::jsonb END) refs WHERE refs.key IN ('logoMediaId', 'faviconMediaId', 'bannerMediaId') AND refs.value = OLD."id")
        ) OR
        EXISTS (
            SELECT 1 FROM "PlatformBranding" b
             WHERE EXISTS (SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(b."draftJson") = 'object' THEN b."draftJson" ELSE '{}'::jsonb END) refs WHERE refs.key IN ('logoMediaId', 'alternateLogoMediaId', 'faviconMediaId', 'defaultAvatarMediaId', 'socialImageMediaId') AND refs.value = OLD."id")
                OR EXISTS (SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(b."publishedJson") = 'object' THEN b."publishedJson" ELSE '{}'::jsonb END) refs WHERE refs.key IN ('logoMediaId', 'alternateLogoMediaId', 'faviconMediaId', 'defaultAvatarMediaId', 'socialImageMediaId') AND refs.value = OLD."id")
        )
    ) THEN
        RAISE EXCEPTION 'Referenced branding media must remain a complete image';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MediaAsset_branding_kind_immutable_guard"
BEFORE UPDATE OF "kind" ON "MediaAsset"
FOR EACH ROW EXECUTE FUNCTION prevent_retyping_referenced_branding_media();
