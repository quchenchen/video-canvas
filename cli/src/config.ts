import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Credentials } from "./types.ts";

/**
 * 凭据目录。遵循 XDG：Linux/macOS 默认 ~/.config/video-canvas。
 * 令牌等同账号密码，目录 0700、文件 0600，写入时用 wx 之外的保守权限。
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "video-canvas");
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), "credentials.json");
}

/** 读取已保存的凭据；不存在或损坏都返回 null，不抛错。 */
export function loadCredentials(env: NodeJS.ProcessEnv = process.env): Credentials | null {
  try {
    return JSON.parse(fs.readFileSync(credentialsPath(env), "utf8")) as Credentials;
  } catch {
    return null;
  }
}

/** 保存凭据：目录 0700、文件 0600，避免同机其他用户读到令牌。 */
export function saveCredentials(creds: Credentials, env: NodeJS.ProcessEnv = process.env): string {
  const dir = configDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = credentialsPath(env);
  fs.writeFileSync(file, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  // 文件已存在时 mode 不生效，显式再改一次
  fs.chmodSync(file, 0o600);
  return file;
}

/** 删除凭据；本来就没有也算成功。 */
export function clearCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    fs.unlinkSync(credentialsPath(env));
    return true;
  } catch {
    return false;
  }
}
