-- Add database-level tenant checks for media references. This preserves
-- existing platform/global media references while preventing future
-- cross-Store assignments and quarantined public delivery.

CREATE FUNCTION enforce_media_reference_scope() RETURNS trigger AS $$
DECLARE
    expected_store_id TEXT;
    media_id TEXT;
    media_store_id TEXT;
    media_upload_status "MediaUploadStatus";
    media_scan_status "MediaScanStatus";
    media_kind "MediaKind";
    product_seller_id TEXT;
BEGIN
    IF TG_TABLE_NAME IN ('BlogPost', 'ContentPage') THEN
        expected_store_id := NEW."storeId";
        IF TG_TABLE_NAME = 'BlogPost' THEN
            FOREACH media_id IN ARRAY ARRAY[NEW."featuredImageId", NEW."ogImageId"] LOOP
                IF media_id IS NOT NULL THEN
                    SELECT "storeId", "uploadStatus" INTO media_store_id, media_upload_status FROM "MediaAsset" WHERE "id" = media_id;
                    IF NOT FOUND OR media_store_id IS DISTINCT FROM expected_store_id OR media_upload_status <> 'COMPLETE' THEN
                        RAISE EXCEPTION 'Content media must be complete and owned by the same Store scope';
                    END IF;
                END IF;
            END LOOP;
        ELSE
            media_id := NEW."ogImageId";
            IF media_id IS NOT NULL THEN
                SELECT "storeId", "uploadStatus" INTO media_store_id, media_upload_status FROM "MediaAsset" WHERE "id" = media_id;
                IF NOT FOUND OR media_store_id IS DISTINCT FROM expected_store_id OR media_upload_status <> 'COMPLETE' THEN
                    RAISE EXCEPTION 'Content media must be complete and owned by the same Store scope';
                END IF;
            END IF;
        END IF;

        FOR media_id IN
            SELECT block->>'mediaId' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW."bodyJson") = 'array' THEN NEW."bodyJson" ELSE '[]'::jsonb END) AS block
            WHERE block ? 'mediaId'
            UNION
            SELECT block->>'captionMediaId' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW."bodyJson") = 'array' THEN NEW."bodyJson" ELSE '[]'::jsonb END) AS block
            WHERE block ? 'captionMediaId'
        LOOP
            SELECT "storeId", "uploadStatus" INTO media_store_id, media_upload_status FROM "MediaAsset" WHERE "id" = media_id;
            IF NOT FOUND OR media_store_id IS DISTINCT FROM expected_store_id OR media_upload_status <> 'COMPLETE' THEN
                RAISE EXCEPTION 'Content media must be complete and owned by the same Store scope';
            END IF;
        END LOOP;
        RETURN NEW;
    ELSIF TG_TABLE_NAME = 'ProductImage' THEN
        IF NEW."mediaAssetId" IS NULL THEN RETURN NEW; END IF;
        SELECT p."sellerId" INTO product_seller_id FROM "Product" p WHERE p."id" = NEW."productId";
        IF NOT FOUND THEN RAISE EXCEPTION 'Product image product does not exist'; END IF;
        IF product_seller_id IS NULL THEN
            expected_store_id := NULL;
        ELSE
            SELECT "id" INTO expected_store_id FROM "Store" WHERE "sellerId" = product_seller_id;
            IF NOT FOUND THEN RAISE EXCEPTION 'Seller product has no Store for media ownership'; END IF;
        END IF;
        SELECT "storeId", "uploadStatus" INTO media_store_id, media_upload_status FROM "MediaAsset" WHERE "id" = NEW."mediaAssetId";
        IF NOT FOUND OR media_store_id IS DISTINCT FROM expected_store_id OR media_upload_status <> 'COMPLETE' THEN
            RAISE EXCEPTION 'Product media must be complete and owned by the same Store scope';
        END IF;
        RETURN NEW;
    ELSIF TG_TABLE_NAME = 'Store' THEN
        FOREACH media_id IN ARRAY ARRAY[NEW."logoMediaId", NEW."bannerMediaId"] LOOP
            IF media_id IS NOT NULL THEN
                SELECT "storeId", "uploadStatus" INTO media_store_id, media_upload_status FROM "MediaAsset" WHERE "id" = media_id;
                IF NOT FOUND OR (media_store_id IS NOT NULL AND media_store_id IS DISTINCT FROM NEW."id") OR media_upload_status <> 'COMPLETE' THEN
                    RAISE EXCEPTION 'Store branding media must be complete and global or owned by this Store';
                END IF;
            END IF;
        END LOOP;
        FOR media_id IN
            SELECT value FROM jsonb_each_text(CASE WHEN jsonb_typeof(NEW."themeDraftJson") = 'object' THEN NEW."themeDraftJson" ELSE '{}'::jsonb END)
            WHERE key IN ('logoMediaId', 'bannerMediaId') AND value NOT IN ('', 'null')
            UNION
            SELECT value FROM jsonb_each_text(CASE WHEN jsonb_typeof(NEW."themePublishedJson") = 'object' THEN NEW."themePublishedJson" ELSE '{}'::jsonb END)
            WHERE key IN ('logoMediaId', 'bannerMediaId') AND value NOT IN ('', 'null')
        LOOP
            SELECT "storeId", "uploadStatus" INTO media_store_id, media_upload_status FROM "MediaAsset" WHERE "id" = media_id;
            IF NOT FOUND OR (media_store_id IS NOT NULL AND media_store_id IS DISTINCT FROM NEW."id") OR media_upload_status <> 'COMPLETE' THEN
                RAISE EXCEPTION 'Store theme media must be complete and global or owned by this Store';
            END IF;
        END LOOP;
        RETURN NEW;
    ELSIF TG_TABLE_NAME = 'User' THEN
        IF NEW."avatarMediaId" IS NULL THEN RETURN NEW; END IF;
        SELECT "storeId", "uploaderId", "uploadStatus", "scanStatus", "kind"
          INTO media_store_id, media_id, media_upload_status, media_scan_status, media_kind
          FROM "MediaAsset" WHERE "id" = NEW."avatarMediaId";
        IF NOT FOUND OR media_store_id IS NOT NULL OR media_id IS DISTINCT FROM NEW."id"
           OR media_upload_status <> 'COMPLETE' OR media_scan_status <> 'APPROVED' OR media_kind <> 'IMAGE' THEN
            RAISE EXCEPTION 'Avatar media must be an approved image uploaded by the same user';
        END IF;
        RETURN NEW;
    ELSIF TG_TABLE_NAME = 'PlatformBranding' THEN
        FOR media_id IN
            SELECT value FROM jsonb_each_text(CASE WHEN jsonb_typeof(NEW."draftJson") = 'object' THEN NEW."draftJson" ELSE '{}'::jsonb END)
            WHERE key IN ('logoMediaId', 'alternateLogoMediaId', 'faviconMediaId', 'defaultAvatarMediaId', 'socialImageMediaId') AND value NOT IN ('', 'null')
            UNION
            SELECT value FROM jsonb_each_text(CASE WHEN jsonb_typeof(NEW."publishedJson") = 'object' THEN NEW."publishedJson" ELSE '{}'::jsonb END)
            WHERE key IN ('logoMediaId', 'alternateLogoMediaId', 'faviconMediaId', 'defaultAvatarMediaId', 'socialImageMediaId') AND value NOT IN ('', 'null')
        LOOP
            SELECT "storeId", "uploadStatus" INTO media_store_id, media_upload_status FROM "MediaAsset" WHERE "id" = media_id;
            IF NOT FOUND OR media_store_id IS NOT NULL OR media_upload_status <> 'COMPLETE' THEN
                RAISE EXCEPTION 'Platform branding media must be complete and platform-owned';
            END IF;
        END LOOP;
        RETURN NEW;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BlogPost_media_scope_guard" BEFORE INSERT OR UPDATE OF "storeId", "bodyJson", "featuredImageId", "ogImageId" ON "BlogPost"
FOR EACH ROW EXECUTE FUNCTION enforce_media_reference_scope();
CREATE TRIGGER "ContentPage_media_scope_guard" BEFORE INSERT OR UPDATE OF "storeId", "bodyJson", "ogImageId" ON "ContentPage"
FOR EACH ROW EXECUTE FUNCTION enforce_media_reference_scope();
CREATE TRIGGER "ProductImage_media_scope_guard" BEFORE INSERT OR UPDATE OF "productId", "mediaAssetId" ON "ProductImage"
FOR EACH ROW EXECUTE FUNCTION enforce_media_reference_scope();
CREATE TRIGGER "Store_media_scope_guard" BEFORE INSERT OR UPDATE OF "id", "logoMediaId", "bannerMediaId", "themeDraftJson", "themePublishedJson" ON "Store"
FOR EACH ROW EXECUTE FUNCTION enforce_media_reference_scope();
CREATE TRIGGER "User_avatar_media_scope_guard" BEFORE INSERT OR UPDATE OF "avatarMediaId" ON "User"
FOR EACH ROW EXECUTE FUNCTION enforce_media_reference_scope();
CREATE TRIGGER "PlatformBranding_media_scope_guard" BEFORE INSERT OR UPDATE OF "draftJson", "publishedJson" ON "PlatformBranding"
FOR EACH ROW EXECUTE FUNCTION enforce_media_reference_scope();

CREATE FUNCTION prevent_media_tenant_reassignment() RETURNS trigger AS $$
BEGIN
    IF NEW."storeId" IS DISTINCT FROM OLD."storeId" AND (
        EXISTS (SELECT 1 FROM "BlogPost" p WHERE p."featuredImageId" = OLD."id" OR p."ogImageId" = OLD."id" OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p."bodyJson") = 'array' THEN p."bodyJson" ELSE '[]'::jsonb END) b WHERE b->>'mediaId' = OLD."id" OR b->>'captionMediaId' = OLD."id")) OR
        EXISTS (SELECT 1 FROM "ContentPage" p WHERE p."ogImageId" = OLD."id" OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p."bodyJson") = 'array' THEN p."bodyJson" ELSE '[]'::jsonb END) b WHERE b->>'mediaId' = OLD."id" OR b->>'captionMediaId' = OLD."id")) OR
        EXISTS (SELECT 1 FROM "ProductImage" WHERE "mediaAssetId" = OLD."id") OR
        EXISTS (SELECT 1 FROM "Store" WHERE "logoMediaId" = OLD."id" OR "bannerMediaId" = OLD."id") OR
        EXISTS (SELECT 1 FROM "Store" s WHERE EXISTS (SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(s."themeDraftJson") = 'object' THEN s."themeDraftJson" ELSE '{}'::jsonb END) m WHERE m.value = OLD."id") OR EXISTS (SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(s."themePublishedJson") = 'object' THEN s."themePublishedJson" ELSE '{}'::jsonb END) m WHERE m.value = OLD."id")) OR
        EXISTS (SELECT 1 FROM "PlatformBranding" b WHERE EXISTS (SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(b."draftJson") = 'object' THEN b."draftJson" ELSE '{}'::jsonb END) m WHERE m.value = OLD."id") OR EXISTS (SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(b."publishedJson") = 'object' THEN b."publishedJson" ELSE '{}'::jsonb END) m WHERE m.value = OLD."id")) OR
        EXISTS (SELECT 1 FROM "User" WHERE "avatarMediaId" = OLD."id")
    ) THEN
        RAISE EXCEPTION 'Referenced media tenant ownership cannot be changed';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "MediaAsset_tenant_immutable_when_referenced" BEFORE UPDATE OF "storeId" ON "MediaAsset"
FOR EACH ROW EXECUTE FUNCTION prevent_media_tenant_reassignment();

CREATE FUNCTION prevent_referenced_media_delete() RETURNS trigger AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM "BlogPost" p WHERE p."featuredImageId" = OLD."id" OR p."ogImageId" = OLD."id" OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p."bodyJson") = 'array' THEN p."bodyJson" ELSE '[]'::jsonb END) b WHERE b->>'mediaId' = OLD."id" OR b->>'captionMediaId' = OLD."id")) OR
       EXISTS (SELECT 1 FROM "ContentPage" p WHERE p."ogImageId" = OLD."id" OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p."bodyJson") = 'array' THEN p."bodyJson" ELSE '[]'::jsonb END) b WHERE b->>'mediaId' = OLD."id" OR b->>'captionMediaId' = OLD."id")) OR
       EXISTS (SELECT 1 FROM "ProductImage" WHERE "mediaAssetId" = OLD."id") OR
       EXISTS (SELECT 1 FROM "Store" WHERE "logoMediaId" = OLD."id" OR "bannerMediaId" = OLD."id") OR
       EXISTS (SELECT 1 FROM "Store" s WHERE EXISTS (SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(s."themeDraftJson") = 'object' THEN s."themeDraftJson" ELSE '{}'::jsonb END) m WHERE m.value = OLD."id") OR EXISTS (SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(s."themePublishedJson") = 'object' THEN s."themePublishedJson" ELSE '{}'::jsonb END) m WHERE m.value = OLD."id")) OR
       EXISTS (SELECT 1 FROM "PlatformBranding" b WHERE EXISTS (SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(b."draftJson") = 'object' THEN b."draftJson" ELSE '{}'::jsonb END) m WHERE m.value = OLD."id") OR EXISTS (SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(b."publishedJson") = 'object' THEN b."publishedJson" ELSE '{}'::jsonb END) m WHERE m.value = OLD."id")) OR
       EXISTS (SELECT 1 FROM "User" WHERE "avatarMediaId" = OLD."id") THEN
        RAISE EXCEPTION 'Referenced media cannot be deleted';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "MediaAsset_referenced_delete_guard" BEFORE DELETE ON "MediaAsset"
FOR EACH ROW EXECUTE FUNCTION prevent_referenced_media_delete();
