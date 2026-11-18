-- 虚拟人像库：归集两类来源的角色图片（短剧拆解角色卡 / 个人资产库图片），统一做方舟备案。
-- 与来源解耦：source_type + source_ref 指向来源，asset 存图片本身；从库移除只删本表行，不碰来源。
-- 备案走模型配置：哪个模型开启了虚拟人像库（body.filing.enabled）、用哪个站点（body.filing.site），
-- AK/SK 存 ai_secrets（filing:<model_key>:access_key / :secret_key），签名见 filing service。
CREATE TABLE virtual_avatars (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL,
    -- 来源类型：drama_character（画布角色卡节点）/ library_asset（个人资产库条目）
    source_type varchar(24) NOT NULL,
    -- 来源指针：角色卡为 canvas_id:node_id，资产库为 asset_library_items.id
    source_ref varchar(128) NOT NULL,
    -- 展示名（角色名 / 文件名）
    name varchar(255) NOT NULL DEFAULT '',
    -- 图片资产 ID（项目内 assets.id，字符串形态），本地预览与上传方舟都用它
    asset_id varchar(64) NOT NULL DEFAULT '',
    -- 图片可访问 URL（快照；上传方舟时用它）
    url text NOT NULL DEFAULT '',
    -- 备案状态：none / pending / active / failed
    filing_status varchar(16) NOT NULL DEFAULT 'none',
    -- 备案所用模型 key（决定站点与 AK/SK），空表示尚未指定
    filing_model_key varchar(128) NOT NULL DEFAULT '',
    -- 方舟返回的 asset:// ID
    ark_asset_id varchar(128) NOT NULL DEFAULT '',
    -- 最近错误（脱敏）
    error text NOT NULL DEFAULT '',
    created_at timestamptz,
    updated_at timestamptz
);
CREATE INDEX idx_virtual_avatars_user ON virtual_avatars (user_id);
-- 同一用户对同一来源只归集一次
CREATE UNIQUE INDEX uk_virtual_avatar_source ON virtual_avatars (user_id, source_type, source_ref);
