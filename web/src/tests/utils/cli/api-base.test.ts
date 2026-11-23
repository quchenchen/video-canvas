import { describe, expect, test } from "bun:test";

import { cliApiBase, cliSiteRoot } from "@/utils/cli/api-base";

describe("CLI 的 --base 动态识别", () => {
  test("相对地址按当前站点绝对化，不写死域名", () => {
    expect(cliApiBase("/api/v1", "https://lj.igeewa.com")).toBe("https://lj.igeewa.com/api/v1");
    expect(cliApiBase("/api/v1", "http://192.168.2.88:10800")).toBe(
      "http://192.168.2.88:10800/api/v1",
    );
  });

  test("绝对地址原样使用：API 挂在别的域名时不退回页面地址", () => {
    expect(cliApiBase("https://api.example.com/api/v1", "https://lj.igeewa.com")).toBe(
      "https://api.example.com/api/v1",
    );
  });

  test("带前缀的部署保留前缀", () => {
    expect(cliApiBase("/backend/api/v1", "https://lj.igeewa.com")).toBe(
      "https://lj.igeewa.com/backend/api/v1",
    );
  });

  test("末尾斜杠去掉；没配环境变量时回落到 /api/v1", () => {
    expect(cliApiBase("https://api.example.com/api/v1/", "")).toBe(
      "https://api.example.com/api/v1",
    );
    expect(cliApiBase(undefined, "http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173/api/v1");
  });

  test("站点根去掉 /api/v1，用于拼授权页地址", () => {
    expect(cliSiteRoot("/api/v1", "https://lj.igeewa.com")).toBe("https://lj.igeewa.com");
    expect(cliSiteRoot("https://api.example.com/api/v1")).toBe("https://api.example.com");
  });
});
