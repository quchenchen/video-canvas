-- 渠道的公开素材资源域：方舟国内站（ark-cn）与 BytePlus 国际站（byteplus）各自维护一套公开音色 / 素材，
-- 同一域内 asset-xxx 通用，跨域直接报 "The specified asset ... is not found"。
-- 原来按 base_url 的域名推断，遇到自建代理、私有网关就识别不出来；改成渠道上显式声明，
-- 域名推断降级为兜底（没填的渠道照旧跑，行为不变）。
-- 空串 = 该渠道不声明，按 base_url 推断；推断不出来时公开音色一律按音频文件地址参考，不发 asset://。
ALTER TABLE ai_channels ADD COLUMN voice_scope varchar(32) NOT NULL DEFAULT '';

-- 现有渠道按 base_url 回填，结果与改动前的域名推断一致，运行行为不变。
UPDATE ai_channels
SET voice_scope = CASE
        WHEN base_url LIKE '%bytepluses.com%' THEN 'byteplus'
        WHEN base_url LIKE '%ark.cn-beijing.volces.com%' THEN 'ark-cn'
        ELSE ''
    END;
