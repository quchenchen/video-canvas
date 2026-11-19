-- 官方参考音色的 asset-xxx 只在导入它的那个方舟账号下有效：换到别的渠道（例如 BytePlus 国际站）会直接报
-- "The specified asset asset-xxx is not found"。所以生成时只有任务渠道与导入渠道一致，才能把引用换成 asset://。
-- official_channel_key 记录导入时的渠道 key（ai_channels.key），空串表示来源未知，一律按不可用处理、回退文件 URL。
ALTER TABLE assets ADD COLUMN official_channel_key varchar(64) NOT NULL DEFAULT '';

-- 已有 80 条音色是从国内方舟（cn-beijing）导进来的；按渠道 base_url 反查它的 key 回填，不写死 key。
-- BytePlus 是另一套独立音色资源，将来导它们的音色时同样按各自渠道回填，互不通用。
-- 找不到对应渠道时留空：宁可退化成文件 URL，也不要把 asset:// 发给用不了它的渠道。
UPDATE assets
SET official_channel_key = COALESCE((
    SELECT c.key FROM ai_channels c
    WHERE c.base_url LIKE '%ark.cn-beijing.volces.com%'
    ORDER BY c.sort, c.key
    LIMIT 1
), '')
WHERE source = 'official'
  AND official_asset_id <> ''
  AND official_channel_key = '';

CREATE INDEX idx_assets_official_channel ON assets USING btree (official_channel_key);
