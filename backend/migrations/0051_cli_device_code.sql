-- CLI 设备授权（RFC 8628 的简化版）：命令行开不了浏览器，也不该让用户手抄长期令牌。
-- 流程：CLI 申请一对码 → 用户在网页上确认 → CLI 轮询换 JWT。
--
-- 只存 device_code 的 sha256，明文只在申请时返回一次；user_code 是给人抄的短码，
-- 授权页要按它查，所以明文入库、唯一索引防撞。短期凭据不做软删除：过期直接清理，
-- 消费后保留状态（consumed）供排查重放。
CREATE TABLE cli_device_codes (
    id bigserial PRIMARY KEY,
    device_code_hash varchar(64) NOT NULL,
    user_code varchar(12) NOT NULL,
    client_name varchar(64) NOT NULL DEFAULT '',
    status varchar(16) NOT NULL DEFAULT 'pending',
    user_id bigint,
    interval_seconds bigint NOT NULL DEFAULT 5,
    poll_count bigint NOT NULL DEFAULT 0,
    last_polled_at timestamptz,
    expires_at timestamptz NOT NULL,
    approved_at timestamptz,
    consumed_at timestamptz,
    created_at timestamptz,
    updated_at timestamptz
);
CREATE UNIQUE INDEX uk_cli_device_codes_hash ON cli_device_codes (device_code_hash);
CREATE UNIQUE INDEX uk_cli_device_codes_user_code ON cli_device_codes (user_code);
CREATE INDEX idx_cli_device_codes_expires_at ON cli_device_codes (expires_at);
CREATE INDEX idx_cli_device_codes_user ON cli_device_codes (user_id);
