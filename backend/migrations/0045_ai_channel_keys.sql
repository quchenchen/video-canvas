-- 渠道多 Key：同一个渠道可以配多把 API Key，请求按槽位轮转。
-- 上游按 Key 限并发时，N 把 Key 让有效并发成倍放大；某把被限流或余额不足时先冷却、换下一把继续发。
--
-- 密文仍然只存 ai_secrets（和其它凭证一样 AES-256-GCM 加密），这里只放元信息：
--   slot 1 的凭证名沿用历史的 channel:<渠道 key>，槽位 2 起是 channel:<渠道 key>:key<N>。
CREATE TABLE ai_channel_keys (
    channel_key varchar(64) NOT NULL,
    slot bigint NOT NULL,
    -- Key 的末四位，只用于运营辨认，不含明文
    hint varchar(16) NOT NULL DEFAULT '',
    remark varchar(64) NOT NULL DEFAULT '',
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    PRIMARY KEY (channel_key, slot)
);

-- 回填：升级前已经设置过 Key 的渠道补一条槽位 1，升级后行为不变（仍然只有一把 Key）。
-- hint 留空，由服务第一次读列表时解密补末四位。
INSERT INTO ai_channel_keys (channel_key, slot, hint, remark, enabled, created_at, updated_at)
SELECT c.key, 1, '', '', true, now(), now()
FROM ai_channels c
WHERE EXISTS (SELECT 1 FROM ai_secrets s WHERE s.name = 'channel:' || c.key)
ON CONFLICT (channel_key, slot) DO NOTHING;
