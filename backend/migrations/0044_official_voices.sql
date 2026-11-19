-- 官方参考音色：把 seedance 官方音频与缩略图转存到平台自有存储后，以系统公共素材落在 assets 表。
-- thumbnail_key 指向同一张表里的一条缩略图素材（source=official_thumb），这样 /files/<key> 能反查到它所在的存储。
-- official_asset_id 是官方 asset-xxx 的溯源 ID，只用于展示与幂等去重，绝不用于生成（跨区无效）。
-- 复用 assets 体系而非新建音色表：卡片、试听、参考音频选取、签名 URL 全部原样可用。
ALTER TABLE assets ADD COLUMN thumbnail_key varchar(512) NOT NULL DEFAULT '';
ALTER TABLE assets ADD COLUMN official_asset_id varchar(128) NOT NULL DEFAULT '';

-- 导入器按官方 ID 幂等 upsert；空串不建索引条目没意义，但用普通索引保持与 AutoMigrate 结构一致。
CREATE INDEX idx_assets_official_asset_id ON assets USING btree (official_asset_id);
