/**
 * Agnes AI 图片插件（内置，契约 v1）。
 *
 * 对接 Agnes AI 的 OpenAI Images 兼容接口（国际站渠道 base_url 填 https://apihub.agnes-ai.com，不带路径；
 *   国内站填 https://api.agnes-ai.cn）：
 *   - 文生图 / 图生图 / 多图合成都走 POST /v1/images/generations（同步出图）
 *   - 图生图的输入图片不是走 /images/edits，而是放在 extra_body.image 数组里
 *
 * 模型（upstreamModel）：agnes-image-2.0-flash / agnes-image-2.1-flash / agnes-image-2.5-flash
 *
 * 鉴权：bearer，渠道 Key 由宿主按 Authorization: Bearer 注入。
 *
 * agnes 与标准 OpenAI Images 的差异（本插件专门处理）：
 *   1. response_format 必须放在 extra_body 内；放顶层会报 UnsupportedParamsError。
 *   2. size 推荐档位式 "1K"/"2K"/"3K"/"4K"，配合 ratio（1:1/3:4/4:3/16:9/9:16/2:3/3:2/21:9）；
 *      也兼容 "1024x768" 这类精确尺寸写法，但可能被标准化到最近档位。
 *   3. 图生图 / 多图合成：图片放 extra_body.image（公网 URL 或 Data URI），不是 edits 的 multipart。
 *   4. 响应 data[].url 或 data[].b64_json；b64_json 可能是空字符串（无内容），要当没有。
 *   5. 图生图不需要 tags:["img2img"]。
 *
 * 用户输入（宿主按模型 capabilities 校验后传入）：
 *   prompt（必填）、op（t2i / i2i）、images（参考图，宿主按渠道设置转换）、
 *   resolution（清晰度档位，宿主按 capabilities 传这个名）/ size（老写法）、aspect_ratio / ratio、
 *   n / count、seed；return_base64（可选）。
 *
 * 写法说明：goja 只保证 ES5.1 + 部分 ES6，所以用 var / function，不用可选链与空值合并。
 */

module.exports = {
  meta: {
    apiVersion: 1,
    key: "agnes-image",
    name: "Agnes AI · 图片",
    version: "1.0.2",
    vendor: "agnes",
    description: "Agnes AI 图片生成：文生图、图生图、多图合成（同步，支持 URL 与 base64）",
    auth: { type: "bearer" },
    endpoints: {
      image: { mode: "sync", method: "POST", path: "/v1/images/generations" },
    },
    channelSettings: {
      as: {
        type: "enum",
        label: "参考图传输格式",
        description: "选择图片、视频和音频引用的传输格式，默认使用存储 URL。",
        options: ["url", "dataUrl", "base64"],
        required: true,
        default: "url",
      },
    },
  },

  buildSubmitRequest: function (ctx) {
    var input = ctx.input || {};
    var referenceFormat = (ctx.channel && ctx.channel.settings && ctx.channel.settings.as) || "url";
    var body = { model: ctx.model.upstreamModel };
    if (input.prompt !== undefined && input.prompt !== "") {
      body.prompt = String(input.prompt);
    }

    // 宿主按模型 capabilities 传的是 resolution 档位（1K/2K/3K/4K），size 是老写法；
    // 两个都认，否则清晰度选什么都只会走下面的 1K 兜底。
    var size = firstString(input.size, input.resolution);
    if (size) {
      body.size = size;
    } else {
      // 没给 size 时按 ratio 推一个 1K 档位；都没有就不发，让上游用默认
      var ratio0 = firstString(input.aspect_ratio, input.ratio);
      if (ratio0) {
        body.size = "1K";
      }
    }

    var ratio = firstString(input.aspect_ratio, input.ratio);
    if (ratio) {
      body.ratio = ratio;
    }

    var n = imageCount(input);
    if (n !== undefined) {
      body.n = n;
    }
    if (typeof input.seed === "number") {
      body.seed = input.seed;
    }

    // extra_body：agnes 把 response_format 与图生图 image 都放这里
    var extra = {};
    var wantBase64 = input.return_base64 === true || firstString(input.response_format) === "b64_json";
    extra.response_format = wantBase64 ? "b64_json" : "url";

    var images = isArray(input.images) ? input.images : [];
    if (images.length > 0) {
      var refs = [];
      for (var i = 0; i < images.length; i++) {
        refs.push({ __fileRef: images[i], as: referenceFormat });
      }
      extra.image = refs;
    }
    body.extra_body = extra;

    return {
      method: "POST",
      path: "/v1/images/generations",
      json: body,
      responseType: "image_json",
      timeout: 180,
    };
  },

  parseSubmitResponse: function (ctx, resp) {
    var body = resp.body || {};
    var data = isArray(body.data) ? body.data : [];
    if (data.length === 0) {
      var msg = errorMessageOf(body) || (resp.text || "").slice(0, 300);
      if (msg) {
        return { immediate: failed(msg) };
      }
      throw new Error("Agnes 图片响应没有 data");
    }
    var outputs = [];
    for (var i = 0; i < data.length; i++) {
      var item = data[i] || {};
      // 宿主已把 b64_json 抽成内联图片并在 item 上打 asset_index（b64_json 字段已删除）。
      // agnes 的 url 可能是 null，b64 项 url 为空 —— 只收有 url 或带 asset_index 的那一个。
      if (typeof item.asset_index === "number") {
        outputs.push({ type: "asset", asset_index: item.asset_index });
      } else if (typeof item.url === "string" && /^https?:\/\//i.test(item.url)) {
        outputs.push({ type: "url", url: item.url, media_type: "image" });
      }
    }
    if (outputs.length === 0) {
      return { immediate: failed("Agnes 返回成功，但没有图片地址") };
    }
    return { immediate: { status: "succeeded", progress: 100, outputs: outputs } };
  },

  // 非 2xx：OpenAI 风格 {error:{message,code}} 或 agnes 的 {detail}。
  classifyError: function (ctx, resp) {
    var body = resp.body && typeof resp.body === "object" ? resp.body : {};
    var msg = errorMessageOf(body) || detailOf(body) || (resp.text || "").slice(0, 300);
    var code = body.error && typeof body.error === "object" && typeof body.error.code === "string" ? body.error.code : "";
    if (!msg) {
      msg = "上游返回 HTTP " + resp.status;
    }
    var out = { class: classifyOf(msg, code, resp.status), message: msg };
    if (code) {
      out.code = code;
    }
    return out;
  },

  buildCheckRequest: function (ctx) {
    return { method: "GET", path: "/v1/models", timeout: 15 };
  },

  buildImportRequest: function (ctx) {
    return { method: "GET", path: "/v1/models", timeout: 30 };
  },

  parseImportResponse: function (ctx, resp) {
    var list = resp.body && isArray(resp.body.data) ? resp.body.data : [];
    var drafts = [];
    for (var i = 0; i < list.length; i++) {
      var id = list[i] && list[i].id;
      if (typeof id !== "string" || id.indexOf("agnes-image-") !== 0) {
        continue;
      }
      drafts.push({ upstreamModel: id, kind: "image", label: id });
    }
    return drafts;
  },
};

function imageCount(input) {
  var n = input.n !== undefined ? input.n : input.count;
  if (typeof n === "number" && n > 0) {
    return Math.floor(n);
  }
  return undefined;
}

function classifyOf(msg, code, status) {
  var s = (String(msg || "") + " " + String(code || "")).toLowerCase();
  if (/moderation|content[ _-]?policy|violat|safety|sensitive|违规|审核|敏感/.test(s)) {
    return "moderation";
  }
  if (/insufficient|billing|balance|quota|credit|arrears|余额|额度|欠费/.test(s)) {
    return "provider_balance";
  }
  if (status === 429 || /rate.?limit|too many|429/.test(s)) {
    return "retryable";
  }
  if (status >= 500) {
    return "retryable";
  }
  return "terminal";
}

function failed(message) {
  return { status: "failed", error: { class: classifyOf(message, "", 400), message: message } };
}

function errorMessageOf(body) {
  if (!body || typeof body !== "object") {
    return "";
  }
  var e = body.error;
  if (e && typeof e === "object" && typeof e.message === "string" && e.message) {
    return e.message;
  }
  if (typeof e === "string" && e) {
    return e;
  }
  return "";
}

function detailOf(body) {
  if (!body || typeof body !== "object") {
    return "";
  }
  return typeof body.detail === "string" ? body.detail : "";
}

function firstString() {
  for (var i = 0; i < arguments.length; i++) {
    if (typeof arguments[i] === "string" && arguments[i] !== "") {
      return arguments[i];
    }
  }
  return "";
}

function isArray(v) {
  return Object.prototype.toString.call(v) === "[object Array]";
}
