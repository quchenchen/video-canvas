// crypto.randomUUID 只在安全上下文（HTTPS / localhost）可用；
// 非安全上下文（明文 HTTP 域名、局域网 IP）下该 API 不存在，而 crypto.getRandomValues 仍可用。
// 这里用 RFC 4122 v4 规则补一个实现，保证任何上下文下 randomUUID 都可用。
// 必须在业务代码之前引入（见 main.tsx 顶部）。
if (
  typeof globalThis.crypto !== "undefined" &&
  typeof globalThis.crypto.randomUUID !== "function"
) {
  const cryptoObj: Crypto = globalThis.crypto;

  Object.defineProperty(cryptoObj, "randomUUID", {
    configurable: true,
    value(): `${string}-${string}-${string}-${string}-${string}` {
      const bytes = new Uint8Array(16);
      cryptoObj.getRandomValues(bytes);

      // RFC 4122 v4：版本号置 0100，变体位置 10xx
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;

      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as `${string}-${string}-${string}-${string}-${string}`;
    },
  });
}
