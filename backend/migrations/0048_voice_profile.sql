-- 公开音色的分类：年龄段（child / teen / young / middle / older）、性别（male / female）、语言（zh / en）。
-- 不是猜的，来自官方标签：
--   - 方舟国内 80 条：官方素材库的卡片标签就是「年龄-性别-名字」（如 少年_少女-女-少儿故事），
--     按 official_asset_id 一一对应回填；导入时名字被截短过（小何2.0 → 小何），不能按名字对；
--   - BytePlus 101 条：名字本身就是「Age - Gender - Name」，按分隔符拆。
-- 语言没有官方字段，按来源推定：方舟国内=中文、BytePlus=英文。将来出现跨语言音色只能人工改数据。
ALTER TABLE assets ADD COLUMN voice_age varchar(16) NOT NULL DEFAULT '';
ALTER TABLE assets ADD COLUMN voice_gender varchar(8) NOT NULL DEFAULT '';
ALTER TABLE assets ADD COLUMN voice_lang varchar(8) NOT NULL DEFAULT '';

-- BytePlus：Child / Teen / Young / Middle-aged / Older × Male / Female
UPDATE assets
SET voice_age = CASE split_part(file_name, ' - ', 1)
        WHEN 'Child' THEN 'child'
        WHEN 'Teen' THEN 'teen'
        WHEN 'Young' THEN 'young'
        WHEN 'Middle-aged' THEN 'middle'
        WHEN 'Older' THEN 'older'
        ELSE ''
    END,
    voice_gender = CASE split_part(file_name, ' - ', 2)
        WHEN 'Male' THEN 'male'
        WHEN 'Female' THEN 'female'
        ELSE ''
    END,
    voice_lang = 'en'
WHERE source = 'official'
  AND official_scope = 'byteplus'
  AND file_name LIKE '% - % - %';

-- 方舟国内：按 official_asset_id 对齐官方素材库标签（少年_少女 归入 teen）
UPDATE assets a
SET voice_age = v.age,
    voice_gender = v.gender,
    voice_lang = 'zh'
FROM (VALUES
    ('asset-20260224190656-dw78f', 'teen', 'female'),
    ('asset-20260224190656-7nvns', 'young', 'female'),
    ('asset-20260224190656-qr992', 'young', 'female'),
    ('asset-20260224190656-f5wvc', 'young', 'female'),
    ('asset-20260224190656-8t7zs', 'young', 'female'),
    ('asset-20260224190656-tnphs', 'young', 'male'),
    ('asset-20260224190656-7n7cg', 'young', 'male'),
    ('asset-20260224190656-k9d7r', 'young', 'male'),
    ('asset-20260224190656-mdwbp', 'teen', 'female'),
    ('asset-20260224190656-ddltv', 'young', 'female'),
    ('asset-20260224190656-mcs77', 'middle', 'female'),
    ('asset-20260224190656-6g84r', 'teen', 'male'),
    ('asset-20260224190656-srtjr', 'child', 'male'),
    ('asset-20260224190656-jtswz', 'young', 'female'),
    ('asset-20260224190656-hczx4', 'middle', 'male'),
    ('asset-20260224190656-tqq2h', 'middle', 'male'),
    ('asset-20260224190656-gz5kb', 'child', 'female'),
    ('asset-20260224190656-rb4s7', 'middle', 'female'),
    ('asset-20260224190656-7r964', 'child', 'female'),
    ('asset-20260224190656-mrbs2', 'teen', 'male'),
    ('asset-20260224190656-sq5tk', 'young', 'male'),
    ('asset-20260224190656-6gkjj', 'child', 'male'),
    ('asset-20260224190656-zrb6k', 'young', 'female'),
    ('asset-20260224190656-q8n9n', 'young', 'male'),
    ('asset-20260224190656-ld557', 'young', 'male'),
    ('asset-20260224190656-459nf', 'young', 'female'),
    ('asset-20260224190656-pc9ns', 'young', 'female'),
    ('asset-20260224190656-wbz44', 'young', 'male'),
    ('asset-20260224190656-dqph5', 'middle', 'male'),
    ('asset-20260224190656-k7px4', 'young', 'male'),
    ('asset-20260224190656-kl5gf', 'child', 'male'),
    ('asset-20260224190656-ccgx8', 'older', 'male'),
    ('asset-20260224190656-5rq88', 'young', 'male'),
    ('asset-20260224190656-qltvl', 'young', 'male'),
    ('asset-20260224190657-j7z55', 'young', 'male'),
    ('asset-20260224190657-qx2rl', 'young', 'female'),
    ('asset-20260224190657-6z7hn', 'young', 'female'),
    ('asset-20260224190657-558cg', 'young', 'female'),
    ('asset-20260224190657-nd59k', 'young', 'male'),
    ('asset-20260224190657-kdxqk', 'young', 'male'),
    ('asset-20260224190657-jk6vd', 'young', 'female'),
    ('asset-20260224190657-9lsgk', 'young', 'female'),
    ('asset-20260224190657-6kzhw', 'young', 'female'),
    ('asset-20260224190657-fjfcj', 'young', 'female'),
    ('asset-20260224190657-pljvq', 'young', 'male'),
    ('asset-20260224190657-bj5zq', 'teen', 'male'),
    ('asset-20260224190657-4hks7', 'young', 'female'),
    ('asset-20260224190657-dw6jj', 'young', 'male'),
    ('asset-20260224190657-8tcfp', 'young', 'female'),
    ('asset-20260224190657-smk6c', 'young', 'female'),
    ('asset-20260224190657-x2g8f', 'teen', 'male'),
    ('asset-20260224190657-w9bjq', 'young', 'male'),
    ('asset-20260224190657-qm7zm', 'teen', 'female'),
    ('asset-20260224190657-dk6kj', 'young', 'male'),
    ('asset-20260224190657-qn26k', 'young', 'male'),
    ('asset-20260224190657-7dgr4', 'young', 'male'),
    ('asset-20260224190657-t55r8', 'young', 'male'),
    ('asset-20260224190657-tx5bj', 'young', 'female'),
    ('asset-20260224190657-jjj56', 'young', 'male'),
    ('asset-20260224190657-79wft', 'young', 'female'),
    ('asset-20260224190657-dtx47', 'middle', 'female'),
    ('asset-20260224190657-hjk6p', 'young', 'female'),
    ('asset-20260224190657-dmrnn', 'young', 'female'),
    ('asset-20260224190657-kvrll', 'young', 'female'),
    ('asset-20260224190657-c25mw', 'teen', 'female'),
    ('asset-20260224190657-zzv99', 'young', 'male'),
    ('asset-20260224190658-8h2gv', 'young', 'female'),
    ('asset-20260224190657-4vxtg', 'young', 'female'),
    ('asset-20260224190658-wg7vs', 'young', 'male'),
    ('asset-20260224190658-mwq8b', 'young', 'female'),
    ('asset-20260224190658-l5jhn', 'young', 'female'),
    ('asset-20260224190658-mdd62', 'young', 'female'),
    ('asset-20260224190658-xf6fq', 'young', 'female'),
    ('asset-20260224190658-llks5', 'young', 'male'),
    ('asset-20260224190658-k8s4v', 'young', 'male'),
    ('asset-20260224190658-cfzpd', 'young', 'male'),
    ('asset-20260224190658-7kss5', 'young', 'female'),
    ('asset-20260224190658-dbmhj', 'child', 'female'),
    ('asset-20260224190658-wx5qt', 'young', 'male'),
    ('asset-20260224190658-9xwll', 'young', 'female')
) AS v(asset_id, age, gender)
WHERE a.official_asset_id = v.asset_id
  AND a.source = 'official';

-- 有一条的显示名被导入工具写成了占位名：asset-20260224190657-bj5zq 官方叫「炀炀」（少年_少女-男）。
-- 名字只用于展示，顺手改正；只在仍是占位名时改，不覆盖人工改过的名字。
UPDATE assets
SET file_name = '炀炀'
WHERE source = 'official'
  AND official_asset_id = 'asset-20260224190657-bj5zq'
  AND file_name = 'premium-default-avatar';
