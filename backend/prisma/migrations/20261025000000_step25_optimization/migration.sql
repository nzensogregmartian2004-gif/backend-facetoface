-- Étape 25 — Optimisation : index spécialisés pour les feeds, classements et recherches textuelles.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "Video_feed_recent_idx"
  ON "Video" ("status", "visibility", "publishedAt" DESC, "id" DESC)
  WHERE "deletedAt" IS NULL;

CREATE INDEX "Video_feed_popular_idx"
  ON "Video" ("status", "visibility", "viewCount" DESC, "likeCount" DESC, "id" DESC)
  WHERE "deletedAt" IS NULL;

CREATE INDEX "Short_feed_recent_idx"
  ON "Short" ("status", "visibility", "publishedAt" DESC, "id" DESC)
  WHERE "deletedAt" IS NULL;

CREATE INDEX "Short_feed_popular_idx"
  ON "Short" ("status", "visibility", "viewCount" DESC, "likeCount" DESC, "id" DESC)
  WHERE "deletedAt" IS NULL;

CREATE INDEX "Video_author_feed_idx"
  ON "Video" ("authorId", "status", "visibility", "publishedAt" DESC, "id" DESC)
  WHERE "deletedAt" IS NULL;

CREATE INDEX "Short_author_feed_idx"
  ON "Short" ("authorId", "status", "visibility", "publishedAt" DESC, "id" DESC)
  WHERE "deletedAt" IS NULL;

CREATE INDEX "User_username_trgm_idx"
  ON "User" USING GIN ("username" gin_trgm_ops);

CREATE INDEX "User_displayName_trgm_idx"
  ON "User" USING GIN ("displayName" gin_trgm_ops);

CREATE INDEX "Video_title_trgm_idx"
  ON "Video" USING GIN ("title" gin_trgm_ops);

CREATE INDEX "Video_description_trgm_idx"
  ON "Video" USING GIN ("description" gin_trgm_ops);

CREATE INDEX "Short_title_trgm_idx"
  ON "Short" USING GIN ("title" gin_trgm_ops);

CREATE INDEX "Short_description_trgm_idx"
  ON "Short" USING GIN ("description" gin_trgm_ops);
