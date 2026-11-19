-- 公开音色按“资源域”划分：方舟国内站（ark-cn）与 BytePlus 国际站（byteplus）各有一套素材库，
-- 同一套里 asset-xxx 所有账号通用，跨域则报 "The specified asset ... is not found"。
-- 所以判定依据是资源域，不是某个具体渠道行、也不是账号私有素材：
-- 同一资源域下换渠道（甚至删掉重建）仍然可用；跨域必须回退成音频文件 URL。
ALTER TABLE assets ADD COLUMN official_scope varchar(32) NOT NULL DEFAULT '';

-- 已有 80 条来自方舟国内站，按其来源渠道的 base_url 推导资源域回填。
UPDATE assets a
SET official_scope = CASE
        WHEN c.base_url LIKE '%ap-southeast%.bytepluses.com%' THEN 'byteplus'
        WHEN c.base_url LIKE '%ark.cn-beijing.volces.com%' THEN 'ark-cn'
        ELSE ''
    END
FROM ai_channels c
WHERE c.key = a.official_channel_key
  AND a.source = 'official'
  AND a.official_scope = '';

CREATE INDEX idx_assets_official_scope ON assets USING btree (official_scope);
