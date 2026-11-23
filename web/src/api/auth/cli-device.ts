import service from "@/utils/requests/service";

/** 授权页展示的设备信息；不含发起方身份，此时还没绑定用户 */
export interface CLIDeviceInfo {
  /** 用户码（ABCD-EFGH），与命令行上显示的一致 */
  user_code: string;
  /** 命令行自报的客户端名称，可能为空 */
  client_name: string;
  /** pending / approved / denied / consumed / expired */
  status: string;
  created_at: string;
  expires_at: string;
}

/**
 * 读取一次设备授权申请。
 * @param code 用户在命令行上看到的用户码，大小写与连字符都不敏感
 */
export const getCLIDevice = (code: string) =>
  service.get<CLIDeviceInfo>("/auth/cli/device", { code });

/**
 * 同意授权：把这次申请绑定到当前登录用户，命令行下一次轮询就能拿到令牌。
 * @param userCode 用户码
 */
export const approveCLIDevice = (userCode: string) =>
  service.post<void>("/auth/cli/device/approve", { user_code: userCode });

/**
 * 拒绝授权：命令行会立刻收到 denied，不会再发令牌。
 * @param userCode 用户码
 */
export const denyCLIDevice = (userCode: string) =>
  service.post<void>("/auth/cli/device/deny", { user_code: userCode });
