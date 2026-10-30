// ==UserScript==
// @name         MAS-Runner (spec interpreter v0.1)
// @namespace    mas-runner
// @version      0.4.2
// @description  声明式 spec 解释器：读 spec.json → 按步骤执行 api/navigate 步骤 → 断言 → 抽取 → dry_run 报告。业务逻辑全部来自 spec（数据），本脚本不含任何业务。
// @author       MAS
// @homepageURL  https://github.com/liuzheng2014/mas-runner
// @supportURL   https://github.com/liuzheng2014/mas-runner/issues
// @updateURL    https://raw.githubusercontent.com/liuzheng2014/mas-runner/main/mas-runner.user.js
// @downloadURL  https://raw.githubusercontent.com/liuzheng2014/mas-runner/main/mas-runner.user.js
// @match        https://ads.huawei.com/*
// @match        https://*.ads.huawei.com/*
// @match        https://*.feishu.cn/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      svc-drcn.ads.huawei.com
// @connect      raw.githubusercontent.com
// @connect      cdn.jsdelivr.net
// @connect      open.feishu.cn
// @connect      *
// @connect      self
// @run-at       document-start
// ==/UserScript==

/*
 * MAS-Runner v0.1 — 范围与边界（务必与 specs/README.md 的 Runner 契约对照）
 *
 * 已实现（v0.1）：
 *   - spec 解释引擎：占位符解析、cookie 派生变量、api 步骤（fetch 优先 / GM_xhr 兜底）、
 *     断言引擎（specs/README.md 全部断言语法）、extract、on_fail 结构化错误
 *   - navigate 步骤 + 跨页续跑（GM 存储保存运行态，导航后新页面自动恢复）
 *   - dry_run 门禁：status=draft 的 spec 只允许纯读执行，任何 write:true 步骤直接拦截
 *   - 悬浮球 UI：粘贴 spec（dev 模式）、参数表单、步骤时间线、原始响应查看、结果导出
 *   - 风控：rate_limit（max_rps + jitter）、no_retry_paths、cache_ttl 步骤缓存
 *   - 自检：cookie 派生变量在位检查、传输通道探测
 *   - v0.1.7：面板标题/悬浮球提示显示完整三位版本号（原硬编码 v0.1）
 *   - v0.1.8：cookie 派生变量改为按步骤懒求值（原启动全量求值+缺失即终止，
 *     会在"起点尚无派生 cookie"（如重新登录后 dsp_csrf_token 未生成）时误拦 S1；
 *     现在哪个步骤用到哪个变量就在那步执行时现取，报错信息指明步骤与补救方式）
 *   - v0.1.9：日志持久化——GM 跨页存储环形缓冲（300 条），页面加载/跳转/刷新后
 *     自动回放全部历史日志并以分隔线标记本页会话起点；新增「清空日志」按钮。
 *     修复真实痛点：跳转后日志清零无法追溯（2026-10-30 用户反馈）
 *   - v0.1.10：navigate 步骤支持 open:"new-tab"（window.open 复刻 UI 进入方式，
 *     保留 opener——对照实验证明 UI 新标签页进入的会话 trackingportal 全通，
 *     同页 location.href 替换进入的会话缺 trackingportal 会话 101133）。
 *     弹窗被拦截时报 E_SESSION 并提示放行（票据未消费可安全重跑）；
 *     新标签页模式下当前页保留，续跑发生在新标签页（RunState 跨标签共享）
 *   - v0.1.11：no_retry 路径超时/断连时报错附带 WAF 限流冷却指引（防用户反复重试加重惩罚；
 *     2026-10-30 17:22 实测 permission 请求被 WAF 挂起 2 分 10 秒）
 *   - v0.1.12：pageFetch 加 AbortController 快速失败（默认 25s）——WAF 挂起时 fetch 原本
 *     要挂 ~100s 才被断连，再兜底 GM_xhr 30s，一次挂死白等 2 分多钟；现在 ~55s 内出结果
 *   - v0.1.13：单点击全自动（业务可用性修复，2026-10-30 用户验收指出三宗罪：
 *     两次人工续跑 / 辅助标签页不自毁 / 不回代理页）。①落地页 boot 检测到 await_nav_check
 *     且 URL 匹配 expect、状态新鲜（10 分钟内）时自动续跑（2.5s 后），无需点击；
 *     ②弹窗被拦自动降级为当前页导航（自动链路无用户手势，被拦是常态）；
 *     ③完成后广播 final 到 GM 存储：辅助页 2s 自毁（window.close 仅对脚本打开的页有效），
 *     发起页轮询接收并展示结果（代理页全程不跳转，天然"回到代理页"）。
 *     角色标记走 sessionStorage（origin=发起页 / helper=落地页），GM 存储跨页共享结果
 *
 *   - v0.1.14：自更新通道（业务同学装一次永远最新）——头部声明 @updateURL/@downloadURL 指向
 *     公开分发仓库 liuzheng2014/mas-runner（油猴静默自动更新）；面板加「检查更新」按钮，
 *     拉 manifest.json 比对版本并给更新链接（raw 主通道 + jsDelivr 备用）；active spec
 *     的执行按钮不再显示 draft→dry_run 字样
 *
 *   - v0.1.15：spec 与参数自动记忆——上次加载的 spec 原文存 GM，页面刷新/跳转落地/新标签页
 *     打开时自动恢复（粘贴框、badge、参数表都回来），参数按 spec_id 记住上次填的值并回填；
 *     恢复走静默路径（不往跨页日志灌噪音），加载失败也不阻断手动粘贴
 *
 *   - v0.1.16：启动静默自检更新——每 6 小时最多一次在后台拉 manifest，发现新版只在悬浮球
 *     右上角点一颗脉冲红点（不弹窗、不打断、不写日志噪音）；面板「检查更新」按钮保留为
 *     手动立即查询入口。配合油猴自身的 @updateURL 自动升级，业务同学日常零操作
 *
 * 未实现（v0.2，需先建 spec_index/task 表 + 实测鉴权通道）：
 *   - Bitable 轮询领任务、结果回写（在线模式）
 *   - spec_index hash 核对（当前 dev 模式只能展示 paste 内容的 SHA-256 供人工比对）
 *   - human 断点原语、ui 原语（DOM 操作）
 *   - datasource 自动取参（v0.1 参数手填）
 */

(function () {
  'use strict';

  /* ==================== ENGINE-START（纯函数区，可被 Node 冒烟测试加载） ==================== */

  const ENGINE = {};

  // ---------- 路径解析：data.list[0].corpId ----------
  ENGINE.resolvePath = function (obj, path) {
    if (typeof path !== 'string') return undefined;
    const segs = [];
    path.replace(/([^.\[\]]+)|\[(\d+)\]/g, (_, name, idx) => {
      if (name !== undefined) segs.push(name); else segs.push(Number(idx));
      return '';
    });
    let cur = obj;
    for (const s of segs) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[s];
    }
    return cur;
  };

  // ---------- 占位符解析 ----------
  // scope: { name: value }；未定义的占位符 → 抛错（禁止猜测式兼容）
  ENGINE.resolvePlaceholders = function (tpl, scope) {
    if (typeof tpl === 'string') {
      return tpl.replace(/\{\{([\w.\[\]-]+)\}\}/g, (whole, name) => {
        if (!(name in scope)) throw new Error('E_SPEC: 未定义占位符 {{' + name + '}}');
        const v = scope[name];
        return (v === null || v === undefined) ? '' : String(v);
      });
    }
    if (Array.isArray(tpl)) return tpl.map(x => ENGINE.resolvePlaceholders(x, scope));
    if (tpl && typeof tpl === 'object') {
      const out = {};
      for (const k of Object.keys(tpl)) out[k] = ENGINE.resolvePlaceholders(tpl[k], scope);
      return out;
    }
    return tpl;
  };

  ENGINE.findUnresolvedPlaceholders = function (tpl, scope, acc) {
    acc = acc || [];
    const scan = (node) => {
      if (typeof node === 'string') {
        node.replace(/\{\{([\w.\[\]-]+)\}\}/g, (_, name) => {
          if (!(name in scope) && acc.indexOf(name) < 0) acc.push(name);
          return '';
        });
      } else if (Array.isArray(node)) node.forEach(scan);
      else if (node && typeof node === 'object') Object.keys(node).forEach(k => scan(node[k]));
    };
    scan(tpl);
    return acc;
  };

  // ---------- cookie 派生变量 ----------
  ENGINE.readCookie = function (docCookie, name) {
    const m = docCookie.match(new RegExp('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  };
  ENGINE.parseCookieVar = function (docCookie, varDef) {
    const raw = ENGINE.readCookie(docCookie, varDef.name);
    if (raw === null) return { ok: false, reason: 'cookie 不存在: ' + varDef.name };
    if (!varDef.parse || varDef.parse === 'raw') return { ok: true, value: raw };
    const mPath = varDef.parse.match(/^json\.(.+)$/);
    if (mPath) {
      try {
        const v = ENGINE.resolvePath(JSON.parse(raw), mPath[1]);
        if (v === undefined || v === null) return { ok: false, reason: 'cookie JSON 中路径为空: ' + varDef.parse };
        return { ok: true, value: String(v) };
      } catch (e) { return { ok: false, reason: 'cookie JSON 解析失败(' + varDef.name + '): ' + e.message }; }
    }
    return { ok: false, reason: '不支持的 parse 规则: ' + varDef.parse };
  };

  // ---------- 断言引擎（语法 = specs/README.md「断言语法」唯一合法形式） ----------
  // 返回 {pass: bool, detail: string}
  ENGINE.evalAssert = function (raw, data, scope) {
    const a = raw.trim();
    const err = (msg) => ({ pass: false, detail: msg });

    // len(path) OP N
    let m = a.match(/^len\((.+)\)\s*(>=|<=|==|!=|>|<)\s*(\d+)$/);
    if (m) {
      const v = ENGINE.resolvePath(data, m[1].trim());
      const len = (typeof v === 'string' || Array.isArray(v)) ? v.length : NaN;
      if (Number.isNaN(len)) return err('len() 作用对象不是字符串/数组: ' + m[1] + ' → ' + JSON.stringify(v));
      const n = Number(m[3]);
      return { pass: ENGINE.cmpNum(len, m[2], n), detail: 'len=' + len + ' ' + m[2] + ' ' + n };
    }

    // path in [ ... ]
    m = a.match(/^(.+?)\s+in\s+\[(.*)\]$/);
    if (m) {
      const v = ENGINE.resolvePath(data, m[1].trim());
      const items = m[2].split(',').map(s => s.trim()).filter(Boolean)
        .map(s => ENGINE.parseScalar(s, scope));
      const pass = items.some(it => ENGINE.looseEq(v, it));
      return { pass, detail: JSON.stringify(v) + ' in [' + items.map(x => JSON.stringify(x)) + ']' };
    }

    // path (!?)matches /re/    —— 正则体内允许空格，放最后用贪婪匹配
    m = a.match(/^(.+?)\s+(!?)matches\s+\/([\s\S]*)\/$/);
    if (m) {
      const v = ENGINE.resolvePath(data, m[1].trim());
      if (typeof v !== 'string') return err('matches 作用对象不是字符串: ' + m[1]);
      let re; try { re = new RegExp(m[3]); } catch (e) { return err('正则非法: /' + m[3] + '/ ' + e.message); }
      const hit = re.test(v);
      const pass = m[2] === '!' ? !hit : hit;
      return { pass, detail: (m[2] === '!' ? 'NOT ' : '') + 'matches /' + m[3] + '/ → ' + (hit ? '命中' : '未命中') + '（值长度 ' + v.length + '）' };
    }

    // path (!?)contains "s"
    m = a.match(/^(.+?)\s+(!?)contains\s+"([^"]*)"$/);
    if (m) {
      const v = ENGINE.resolvePath(data, m[1].trim());
      const s = String(v === undefined || v === null ? '' : (typeof v === 'object' ? JSON.stringify(v) : v));
      const hit = s.indexOf(m[3]) >= 0;
      return { pass: m[2] === '!' ? !hit : hit, detail: (m[2] === '!' ? 'NOT ' : '') + 'contains "' + m[3] + '" → ' + (hit ? '命中' : '未命中') };
    }

    // path exists
    m = a.match(/^(.+?)\s+exists$/);
    if (m) {
      const v = ENGINE.resolvePath(data, m[1].trim());
      return { pass: v !== undefined && v !== null, detail: m[1].trim() + ' → ' + (v === undefined ? 'undefined' : (v === null ? 'null' : '存在')) };
    }

    // path OP value
    m = a.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
    if (m) {
      const v = ENGINE.resolvePath(data, m[1].trim());
      const target = ENGINE.parseScalar(m[3], scope);
      if (m[2] === '==' || m[2] === '!=') {
        const eq = ENGINE.looseEq(v, target);
        return { pass: m[2] === '==' ? eq : !eq, detail: ENGINE.trimShow(v) + ' ' + m[2] + ' ' + JSON.stringify(target) };
      }
      const nv = Number(v), nt = Number(target);
      if (v === undefined || v === null || nv === undefined || Number.isNaN(nv) || Number.isNaN(nt)) {
        return err('数值比较遇到非数值: ' + ENGINE.trimShow(v) + ' ' + m[2] + ' ' + JSON.stringify(target));
      }
      return { pass: ENGINE.cmpNum(nv, m[2], nt), detail: ENGINE.trimShow(v) + ' ' + m[2] + ' ' + JSON.stringify(target) };
    }

    return err('无法识别的断言语法: ' + a);
  };

  ENGINE.parseScalar = function (s, scope) {
    s = s.trim();
    const ph = s.match(/^\{\{([\w.\[\]-]+)\}\}$/);
    if (ph) {
      if (!scope || !(ph[1] in scope)) throw new Error('E_SPEC: 断言中引用未定义占位符 {{' + ph[1] + '}}');
      return scope[ph[1]];
    }
    if (/^".*"$/.test(s) || /^'.*'$/.test(s)) return s.slice(1, -1);
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    return s; // 裸字符串按原值
  };
  ENGINE.looseEq = function (a, b) {
    if (a === b) return true;
    // JS == 语义：undefined 与 null 相等（断言 path == null 覆盖字段缺失场景）
    if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
    if (a === null || a === undefined || b === null || b === undefined) return false;
    const na = Number(a), nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && String(na) === String(a) && String(nb) === String(b)) return na === nb;
    return String(a) === String(b);
  };
  ENGINE.cmpNum = (a, op, b) => op === '>=' ? a >= b : op === '<=' ? a <= b : op === '>' ? a > b : op === '<' ? a < b : op === '==' ? a === b : a !== b;
  ENGINE.trimShow = (v) => { const s = JSON.stringify(v); return s === undefined ? 'undefined' : (s.length > 80 ? s.slice(0, 80) + '…(' + s.length + ')' : s); };

  // ---------- 脱敏（日志落表/落屏前必须过这里） ----------
  ENGINE.SENSITIVE_KEY = /(api_?key|secret|token|password|passwd|ticket|authorization|cookie)/i;
  ENGINE.redact = function (obj, depth) {
    depth = depth || 0;
    if (depth > 6) return '…';
    if (typeof obj === 'string') return obj;
    if (Array.isArray(obj)) return obj.map(x => ENGINE.redact(x, depth + 1));
    if (obj && typeof obj === 'object') {
      const out = {};
      for (const k of Object.keys(obj)) {
        out[k] = ENGINE.SENSITIVE_KEY.test(k) ? ENGINE.maskValue(obj[k]) : ENGINE.redact(obj[k], depth + 1);
      }
      return out;
    }
    return obj;
  };
  ENGINE.maskValue = function (v) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s === undefined || s === null) return v;
    if (s.length <= 8) return '***';
    return s.slice(0, 4) + '…***…' + s.slice(-4) + ' (' + s.length + 'ch)';
  };

  // ---------- SHA-256（crypto.subtle 包装，dev 模式展示 paste 内容指纹） ----------
  ENGINE.sha256Hex = async function (text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  };

  /* ==================== ENGINE-END ==================== */

  const GV = {
    RUN_KEY: 'masr_run_v1',          // 运行态（跨页续跑）
    CACHE_KEY: 'masr_cache_v1',      // 步骤缓存
    TRANSPORT_KEY: 'masr_transport', // 通道探测结论（fetch / gm）
    LAST_SPEC_KEY: 'masr_last_spec_v1',     // 上次加载的 spec 原文（刷新/重开自动恢复）
    LAST_PARAMS_KEY: 'masr_last_params_v1', // 按 spec_id 记住的参数值
    SCHEMA_SUPPORTED: '0.1',
    RUNNER_VERSION: '0.4.2',
    // 自更新通道：manifest 与脚本本体同源（公开分发仓库）。raw 为主，jsDelivr 为备——
    // 油猴自身按 @updateURL 静默更新，此处的 manifest 只用于「检查更新」按钮的显式查询与版本提示。
    UPDATE_MANIFEST: [
      'https://raw.githubusercontent.com/liuzheng2014/mas-runner/main/manifest.json',
      'https://cdn.jsdelivr.net/gh/liuzheng2014/mas-runner@main/manifest.json'
    ],
    INSTALL_URL: 'https://raw.githubusercontent.com/liuzheng2014/mas-runner/main/mas-runner.user.js',
  };

  // ---------- 运行态存取（GM 存储跨域共享，导航后由新页面恢复） ----------
  const RunState = {
    get() { try { return JSON.parse(GM_getValue(GV.RUN_KEY, 'null')); } catch (e) { return null; } },
    set(st) { GM_setValue(GV.RUN_KEY, JSON.stringify(st)); },
    clear() { GM_deleteValue(GV.RUN_KEY); },
  };
  const StepCache = {
    all() { try { return JSON.parse(GM_getValue(GV.CACHE_KEY, '{}')); } catch (e) { return {}; } },
    get(specId, stepId, bodyKey) {
      const c = this.all()[specId + '/' + stepId + '/' + bodyKey];
      if (!c) return null;
      if (Date.now() > c.expireAt) return null;
      return c;
    },
    put(specId, stepId, bodyKey, data, ttlSec) {
      const c = this.all();
      c[specId + '/' + stepId + '/' + bodyKey] = { data, expireAt: Date.now() + ttlSec * 1000 };
      GM_setValue(GV.CACHE_KEY, JSON.stringify(c));
    },
  };

  /* ==================== 飞书 HTTP 通道 ====================
   * 2026-10-30：整套「登录飞书」OAuth（user_access_token / PKCE / 回调页）已删除。
   * 原因已实证：业务同学的飞书是外部个人号，进不了自建应用的可用范围，
   * 永远换不到 user_access_token。身份一律走「填表单登记 → 创建人 = 本人」那条路。
   * 这里只留一个 GM_xhr 封装：OpenAPI 无 CORS 头，页面内 fetch 会被拦。
   */
  // OpenAPI 无 CORS 头，必须走 GM_xhr（服务端与直连共用）
  function fsHttp(method, url, opts) {
    const o = opts || {};
    return new Promise((resolve, reject) => {
      const req = {
        method,
        url,
        headers: o.headers || {},
        timeout: o.timeout || 20000,
        onload: (r) => resolve({ status: r.status, text: r.responseText || '' }),
        onerror: () => reject(new Error('E_NETWORK ' + method + ' ' + url.replace(/\?.*/, ''))),
        ontimeout: () => reject(new Error('E_TIMEOUT ' + method + ' ' + url.replace(/\?.*/, ''))),
      };
      if (o.body) req.data = o.body;
      GM_xmlhttpRequest(req);
    });
  }

  /* ---------- 业务表只读（拉 spec 用） ----------
   * 只保留读：应用身份可以读，但按项目铁律，应用身份不得对业务表做写操作。
   * 回写一律走 SVC.writeResult / FL.writeResult（后者还带 record_id 白名单守卫）。
   */
  const FS_BIZ = {
    APP: 'OC2LbUsiLaRyhcse8P2cZyXintf',
    SPEC_TABLE: 'tblKAlQwYgLT3fys',
  };

  async function fsApi(method, path, body) {
    const access = await FL.token();
    const res = await fsHttp(method, FL.API + path, {
      headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json; charset=utf-8' },
      body: body ? JSON.stringify(body) : null,
    });
    let j;
    try { j = JSON.parse(res.text); } catch (e) { throw new Error('E_FS_PARSE ' + res.text.slice(0, 120)); }
    if (j.code !== 0) throw new Error('E_FS_API ' + j.code + ' ' + (j.msg || '') + ' path=' + path);
    return j.data;
  }

  /* ---------- 业务表读写（复用既有 Base，只写约定字段，不改表结构） ---------- */
  async function fsSearchRecords(tableId, payload) {
    const d = await fsApi('POST', '/bitable/v1/apps/' + FS_BIZ.APP + '/tables/' + tableId + '/records/search',
      Object.assign({ page_size: 100 }, payload || {}));
    return (d && d.items) || [];
  }

  // ---------- 风控限速器 ----------
  function makeLimiter(rateLimit) {
    const rl = rateLimit || {};
    const minGap = rl.max_rps ? 1000 / rl.max_rps : 0;
    let lastAt = 0;
    return async function gate(noRetry) {
      const jitter = (rl.jitter_ms && !noRetry) ? rl.jitter_ms[0] + Math.random() * (rl.jitter_ms[1] - rl.jitter_ms[0]) : 0;
      const wait = Math.max(0, lastAt + minGap + jitter - Date.now());
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
    };
  }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function isNoRetryPath(spec, url) {
    const paths = (spec.rate_limit && spec.rate_limit.no_retry_paths) || [];
    return paths.some(p => url.indexOf(p) >= 0);
  }

  // ---------- 传输通道：页面 fetch 优先（自动带同源 Cookie），失败兜底 GM_xhr ----------
  async function detectTransport() {
    const saved = GM_getValue(GV.TRANSPORT_KEY, '');
    if (saved) return saved;
    return 'auto';
  }
  function pageFetch(url, opt) {
    // 快速失败：WAF 挂起时 fetch 会无限挂住（实测 ~100s 才被断连），用 AbortController 限时
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opt.timeoutMs || 25000);
    return fetch(url, {
      method: opt.method || 'GET',
      headers: opt.headers || {},
      body: opt.bodyText,
      credentials: 'include',
      signal: ctrl.signal,
    }).then(async (res) => {
      clearTimeout(timer);
      const text = await res.text();
      return { status: res.status, text };
    }).catch((e) => {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('fetch timeout(' + ((opt.timeoutMs || 25000) / 1000) + 's，疑似WAF挂起)');
      throw e;
    });
  }
  function gmFetch(url, opt) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: opt.method || 'GET',
        url,
        headers: opt.headers || {},
        data: opt.bodyText,
        timeout: 30000,
        onload: (r) => resolve({ status: r.status, text: r.responseText }),
        onerror: () => reject(new Error('GM_xhr network error')),
        ontimeout: () => reject(new Error('GM_xhr timeout(30s)')),
      });
    });
  }
  async function httpOnce(url, opt) {
    const mode = await detectTransport();
    if (mode === 'gm') return gmFetch(url, opt);
    if (mode === 'fetch') return pageFetch(url, opt);
    // auto：先 fetch，网络层失败（CORS/断网）再走 GM
    try {
      return await pageFetch(url, opt);
    } catch (e) {
      return await gmFetch(url, opt);
    }
  }

  // ---------- HTTP 响应体定位（页面 fetch 复现时可能拿到包了 http* 键的信封） ----------
  function unwrapBody(json) {
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      for (const k of Object.keys(json)) {
        if (/^http/.test(k) && json[k] && typeof json[k] === 'object') return json[k];
      }
    }
    return json;
  }

  /* ---------- 核心执行器 ---------- */

  function buildScope(spec, params, extracted, extra) {
    const scope = Object.assign({}, extra || {});
    for (const p of spec.params || []) scope[p.name] = params[p.name];
    for (const k of Object.keys(extracted)) scope[k] = extracted[k];
    scope.task_id = scope.task_id || 'dev-' + Date.now();
    scope.now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    return scope;
  }

  function prepareVars(spec) {
    // 启动时尽力派生（仅作初始值）；缺失不致命——真实判定在每步执行前 ensureStepVars
    const got = {};
    const problems = [];
    for (const name of Object.keys(spec.vars || {})) {
      const r = ENGINE.parseCookieVar(document.cookie, spec.vars[name]);
      if (r.ok) got[name] = r.value; else problems.push(name + ': ' + r.reason);
    }
    return { vars: got, problems };
  }

  function stepVarNames(spec, step) {
    const hay = JSON.stringify(step.request || {}) + (step.url || '') +
      JSON.stringify(step.assert || []) + JSON.stringify(step.expect || {});
    return Object.keys(spec.vars || {}).filter(n => hay.indexOf('{{' + n) >= 0);
  }

  function ensureStepVars(spec, step, vars) {
    // 按步骤懒派生：哪步用哪个变量，就在那一步执行时现取 cookie。
    // 原因：派生 cookie 可能由前序 navigate 步骤的跳转链才生成（如 dsp_csrf_token），
    // 启动时全量求值会对"起点尚不存在"的 cookie 误报 E_SESSION（v0.1.7 及之前的真实缺陷，2026-10-30 16:49 复现）。
    for (const name of stepVarNames(spec, step)) {
      const r = ENGINE.parseCookieVar(document.cookie, spec.vars[name]);
      if (!r.ok) {
        throw new RunnerError('E_SESSION', step.id + ' 需要派生变量 ' + name + '，但 ' + r.reason +
          '。该 cookie 通常在进入对应平台上下文后才生成；请从流程起点（服务商平台首页）发起完整执行，而不是在中间页面直接续跑');
      }
      vars[name] = r.value; // 每步现取，cookie 轮换后取到的是新值
    }
  }

  function validateSpecShape(spec) {
    if (spec.schema_version !== GV.SCHEMA_SUPPORTED) {
      throw new Error('E_SPEC: schema_version=' + spec.schema_version + '，本 Runner 仅支持 ' + GV.SCHEMA_SUPPORTED + '（版本协商：宁可停也不猜）');
    }
    if (!spec.spec_id || !spec.version || !Array.isArray(spec.steps) || !spec.steps.length) {
      throw new Error('E_SPEC: spec_id/version/steps 缺失');
    }
    if (spec.last_verified_at) {
      const days = (Date.now() - new Date(spec.last_verified_at).getTime()) / 86400000;
      if (days > 30) throw new Error('E_SPEC: spec 已 ' + Math.floor(days) + ' 天未验证（last_verified_at=' + spec.last_verified_at + '），疑似失效，拒绝执行');
    }
  }

  function checkDryRunPermission(spec) {
    if (spec.status === 'draft') {
      const hasWrite = spec.steps.some(s => s.write === true || s.mode === 'human');
      if (hasWrite) {
        // draft 允许跑到写操作前一步：执行引擎会在遇 write 步骤时停下（见 runSpec）
        return { dryRun: true, stopAtWrite: true };
      }
      return { dryRun: true, stopAtWrite: true }; // 纯读 draft：dry_run 即正常执行读步骤
    }
    return { dryRun: false, stopAtWrite: false };
  }

  async function runSpec(spec, params, hooks) {
    // hooks: {onLog(entry), onStep(stepId, phase, info)}
    const log = (entry) => { hooks.onLog(entry); };
    const onStep = hooks.onStep || (() => {});
    validateSpecShape(spec);
    const { dryRun } = checkDryRunPermission(spec);

    const { vars, problems } = prepareVars(spec);
    if (problems.length) {
      log({ t: Date.now(), level: 'info', msg: '派生变量延后求值（在使用它的步骤执行时现取）: ' + problems.join('；') });
    }
    log({ t: Date.now(), level: 'info', msg: '派生变量就绪: ' + Object.keys(vars).join(', ') });
    log({ t: Date.now(), level: 'info', msg: (dryRun ? '[dry_run] ' : '[run] ') + spec.spec_id + ' v' + spec.version + ' (' + spec.status + ')' });

    const gate = makeLimiter(spec.rate_limit);
    const extracted = {};
    const stepLogs = [];
    let scope = buildScope(spec, params, extracted, vars);

    // 预检：全部步骤的占位符当前可解析吗（除引用后步产物的）？——尽力预检，允许执行期再补
    const missing = ENGINE.findUnresolvedPlaceholders(
      spec.steps.map(s => s.request || { url: s.url }), scope);
    if (missing.length) {
      log({ t: Date.now(), level: 'warn', msg: '预检发现待运行期变量（若来自后步 extract 属正常）: ' + missing.join(', ') });
    }

    for (let i = 0; i < spec.steps.length; i++) {
      const step = spec.steps[i];
      try {
        ensureStepVars(spec, step, vars);
        scope = buildScope(spec, params, extracted, vars); // 懒派生后重建作用域（vars 可能刚更新）
        if (step.write === true) {
          if (dryRun || true /* v0.1 一律拦截写操作：confirm 机制在 v0.2 随 human 原语一起上 */) {
            log({ t: Date.now(), level: 'fatal', msg: 'S' + i + ' 写操作被 v0.1 Runner 拦截（写操作需 v0.2 confirm 机制）' });
            throw new RunnerError('E_PERM', 'v0.1 Runner 不执行写操作: ' + step.id);
          }
        }
        if (step.mode === 'human') {
          throw new RunnerError('E_PERM', 'human 断点原语 v0.2 提供，本步骤无法执行: ' + step.id);
        }
        if (step.mode === 'navigate') {
          const nav = await execNavigate(spec, step, scope, extracted, stepLogs, log, onStep, i);
          if (nav && nav.initiated) {
            // 导航发起是正常信号，不是失败。同页跳转：本页即将卸载；新标签页：本页保留
            const tip = nav.openedTab
              ? '=== ' + step.id + ' 已在新标签页打开子客门户（本页保留）。请切换到新标签页 → 打开悬浮球 → 点「执行」完成落地校验并续跑 ==='
              : '=== ' + step.id + ' 导航已发起（这不是错误）。页面跳转后请打开悬浮球点「执行」完成落地校验并续跑；若 5 秒后页面仍未跳转，请截图日志反馈 ===';
            log({ t: Date.now(), level: 'warn', msg: tip });
            return { ok: true, navInitiated: true, openedTab: !!nav.openedTab, stepId: step.id, stepLogs, extracted, dryRun };
          }
          continue;
        }
        if (step.mode !== 'api') {
          throw new RunnerError('E_SPEC', '未知步骤 mode: ' + step.mode);
        }
        await execApi(spec, step, scope, extracted, stepLogs, log, onStep, i, gate);
        // 关键：每步执行完重建作用域，把本步抽取产物并入变量表（前步产物 {{Sn.x}} 通道）
        scope = buildScope(spec, params, extracted, vars);
      } catch (e) {
        if (e instanceof RunnerError) {
          log({ t: Date.now(), level: 'fatal', msg: step.id + ' 失败: [' + e.code + '] ' + e.message });
          throw e;
        }
        // spec 定义的 on_fail 优先，但底层原因永远保留（三要素：期望/实际/差异）
        const of = step.on_fail || {};
        const code = /未定义占位符|无法识别/.test(e.message) ? 'E_SPEC' : 'E_NETWORK';
        const msg = of.message ? (of.message + '｜底层: ' + e.message) : e.message;
        log({ t: Date.now(), level: 'fatal', msg: step.id + ' 失败: [' + (of.error || code) + '] ' + msg });
        throw new RunnerError(of.error || code, msg);
      }
    }

    // outputs
    const outputs = {};
    for (const k of Object.keys(spec.outputs || {})) {
      try { outputs[k] = ENGINE.resolvePlaceholders(spec.outputs[k], scope); }
      catch (e) { outputs[k] = '<解析失败: ' + e.message + '>'; }
    }
    return { ok: true, dryRun, outputs, stepLogs, extracted };
  }

  function RunnerError(code, message) { this.code = code; this.message = message; }
  RunnerError.prototype = Object.create(Error.prototype);

  async function execApi(spec, step, scope, extracted, stepLogs, log, onStep, idx, gate) {
    onStep(step.id, 'running');
    const url = ENGINE.resolvePlaceholders(step.request.url, scope);
    const headers = ENGINE.resolvePlaceholders(step.request.headers || {}, scope);
    const bodyText = step.request.body !== undefined
      ? JSON.stringify(ENGINE.resolvePlaceholders(step.request.body, scope)) : undefined;
    const noRetry = isNoRetryPath(spec, url);
    const bodyKey = (bodyText || '').length + ':' + url;

    // 步骤缓存
    if (step.cache_ttl_sec) {
      const cached = StepCache.get(spec.spec_id, step.id, bodyKey);
      if (cached) {
        log({ t: Date.now(), level: 'info', msg: step.id + ' 命中缓存（TTL ' + step.cache_ttl_sec + 's 内）' });
        return applyResponse(spec, step, cached.data, scope, extracted, stepLogs, log, onStep, true);
      }
    }

    await gate(noRetry);
    log({ t: Date.now(), level: 'info', msg: step.id + ' → ' + (step.request.method || 'GET') + ' ' + url + (noRetry ? '（WAF 限流路径，禁重试）' : '') });
    onStep(step.id, 'requesting');

    const t0 = Date.now();
    let res;
    try { res = await httpOnce(url, { method: step.request.method || 'GET', headers, bodyText }); }
    catch (e) {
      // no_retry 路径失败不重试（WAF 挂起特征）；其他路径重试 1 次
      if (!noRetry) {
        log({ t: Date.now(), level: 'warn', msg: step.id + ' 请求失败（' + e.message + '），重试 1 次' });
        await gate(noRetry);
        res = await httpOnce(url, { method: step.request.method || 'GET', headers, bodyText });
      } else {
        // WAF 挂起场景：请求长时间无响应即超时/断连——给出冷却指引而不是让用户反复重试加重惩罚
        if (/timeout|network error/i.test(e.message)) {
          throw new RunnerError('E_NETWORK', '请求长时间无响应（' + e.message + '），疑似 WAF 对该路径限流挂起。请等待约 10 分钟让限流解除后，从服务商平台首页重新发起完整流程（不要反复重试，会加重惩罚）');
        }
        throw e;
      }
    }
    const cost = Date.now() - t0;
    log({ t: Date.now(), level: 'info', msg: step.id + ' ← HTTP ' + res.status + '，' + res.text.length + 'B，耗时 ' + cost + 'ms' });

    let json;
    try { json = JSON.parse(res.text); } catch (e) {
      throw new RunnerError('E_DRIFT', '响应不是合法 JSON（前 120 字符: ' + res.text.slice(0, 120) + '）');
    }
    json = unwrapBody(json);

    if (res.status !== 200) {
      // 三要素：状态码 + 响应体快照（脱敏），否则服务端错误无从诊断
      let snippet = res.text.slice(0, 200);
      try { snippet = JSON.stringify(ENGINE.redact(JSON.parse(res.text))).slice(0, 200); } catch (e) { /* 非 JSON 原样截断 */ }
      if (res.status === 401 || res.status === 403) throw new RunnerError('E_SESSION', 'HTTP ' + res.status + '，会话可能已失效｜响应: ' + snippet);
      throw new RunnerError('E_NETWORK', 'HTTP ' + res.status + '｜响应: ' + snippet);
    }
    if (step.cache_ttl_sec) StepCache.put(spec.spec_id, step.id, bodyKey, json, step.cache_ttl_sec);
    return applyResponse(spec, step, json, scope, extracted, stepLogs, log, onStep, false);
  }

  function applyResponse(spec, step, json, scope, extracted, stepLogs, log, onStep, fromCache) {
    // 断言
    const assertResults = [];
    for (const a of step.assert || []) {
      let r;
      try { r = ENGINE.evalAssert(a, json, scope); }
      catch (e) { r = { pass: false, detail: e.message }; }
      assertResults.push({ assert: a, pass: r.pass, detail: r.detail });
      if (!r.pass) {
        const of = step.on_fail || {};
        onStep(step.id, 'failed');
        log({ t: Date.now(), level: 'fatal', msg: step.id + ' 断言失败: ' + a + '（' + r.detail + '）' });
        log({ t: Date.now(), level: 'info', msg: step.id + ' 响应快照: ' + JSON.stringify(ENGINE.redact(json)).slice(0, 600) });
        throw new RunnerError(of.error || 'E_ASSERT', (of.message || '断言失败: ' + a) + '｜' + r.detail);
      }
    }
    // 抽取
    const got = {};
    for (const k of Object.keys(step.extract || {})) {
      const path = step.extract[k];
      if (path === null) { got[k] = '<extract 未定义（unconfirmed），跳过>'; continue; }
      const v = ENGINE.resolvePath(json, path);
      if (v === undefined || v === null) {
        const of = step.on_fail || {};
        onStep(step.id, 'failed');
        throw new RunnerError(of.error || 'E_DRIFT', '抽取路径不存在: ' + path + '（响应: ' + JSON.stringify(ENGINE.redact(json)).slice(0, 300) + '）');
      }
      extracted[step.id + '.' + k] = v;
      got[k] = v;
    }
    stepLogs.push({
      id: step.id, name: step.name, mode: step.mode, fromCache,
      assertResults, extract: ENGINE.redact(got),
      response: ENGINE.redact(json),
      rawResponseRef: step.id, // UI 可看完整脱敏 JSON
    });
    onStep(step.id, 'passed');
    log({ t: Date.now(), level: 'ok', msg: step.id + ' ✓ 断言 ' + assertResults.length + ' 条全过' + (Object.keys(got).length ? '，抽取: ' + Object.keys(got).join(', ') : '') });
  }

  async function execNavigate(spec, step, scope, extracted, stepLogs, log, onStep, idx) {
    // navigate 前必须先把运行态落盘（导航会销毁当前 JS 环境）
    const url = ENGINE.resolvePlaceholders(step.url, scope);
    if (!/^https:\/\//.test(url)) throw new RunnerError('E_SPEC', 'navigate 目标非法: ' + url);
    const newTab = step.open === 'new-tab';
    log({ t: Date.now(), level: 'info', msg: step.id + ' → ' + (newTab ? '新标签页打开 ' : '导航 ') + maskUrl(url) + '（运行态已保存）' });
    onStep(step.id, 'navigating');
    const st = RunState.get() || {};
    st.phase = 'await_nav_check';
    st.navStepId = step.id;
    st.navExpect = step.expect || {};
    st.navAt = Date.now();
    st.extracted = extracted;   // 产物随行：落地页续跑时恢复变量表
    st.stepLogs = stepLogs;     // 日志随行：落地后面板能看到完整时间线
    RunState.set(st);
    // 留时间让 UI 渲染日志；location.href 是异步的，页面真正卸载前脚本会继续走完
    await sleep(300);
    if (newTab) {
      // 新标签页进入：复刻 UI 的 window.open 行为（保留 opener）。
      // 证据：2026-10-30 对照实验——UI(window.open) 进入的会话 trackingportal 全通（spec.manual-assist 三步全绿），
      // 当前页 location.href 替换进入的会话缺 trackingportal 会话（101133），疑似 SSO 握手依赖 opener 收尾。
      const w = window.open(url, '_blank');
      if (!w) {
        // 0.1.13：弹窗被拦时降级为当前页导航（落点相同，expect 校验兜底），不再硬报错——
        // 自动续跑链路中本页没有用户手势，被拦是常态而非异常
        log({ t: Date.now(), level: 'warn', msg: step.id + ' 弹窗被浏览器拦截，降级为当前页导航（落点不变）' });
        location.href = url;
        await sleep(500);
        return { initiated: true, openedTab: false, pageStayed: true };
      }
      try { sessionStorage.setItem('masrTransit', '1'); } catch (e) {}
      await sleep(500);
      // 当前页不卸载；续跑发生在新标签页（RunState 跨标签共享）
      return { initiated: true, openedTab: true };
    }
    location.href = url;
    await sleep(500);
    // 能走到这 = 页面没有卸载 = 导航未生效（被拦截或目标拒绝）
    return { initiated: true, pageStayed: true };
  }

  // 日志脱敏：票据/token 类查询参数打码
  function maskUrl(u) {
    return u.replace(/([?&](ticket|token|code|auth)=)[^&]+/gi, '$1***');
  }

  // 落地后恢复：检查 expect{url_contains, cookie_exists}
  async function resumeAfterNavigate(spec, params) {
    const st = RunState.get();
    if (!st || st.phase !== 'await_nav_check') return null;
    const expect = st.navExpect || {};
    const problems = [];
    if (expect.url_contains && location.href.indexOf(expect.url_contains) < 0) {
      problems.push('URL 不含 "' + expect.url_contains + '"（当前: ' + location.href.slice(0, 120) + '）');
    }
    if (expect.cookie_exists) {
      // 等待 cookie 就位（302 链路可能需要几秒）
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (ENGINE.readCookie(document.cookie, expect.cookie_exists)) break;
        await sleep(500);
      }
      if (!ENGINE.readCookie(document.cookie, expect.cookie_exists)) {
        problems.push('cookie 不存在: ' + expect.cookie_exists);
      }
    }
    // 恢复执行环境
    const stepIdx = spec.steps.findIndex(s => s.id === st.navStepId);
    const step = spec.steps[stepIdx];
    const logEntries = st.log || [];
    const log = (entry) => { logEntries.push(entry); st.log = logEntries; RunState.set(st); UI.appendLog(entry); };
    if (problems.length) {
      RunState.clear();
      const of = step.on_fail || {};
      log({ t: Date.now(), level: 'fatal', msg: st.navStepId + ' expect 校验失败: ' + problems.join('；') });
      throw new RunnerError(of.error || 'E_SESSION', (of.message || '导航后校验失败') + '｜' + problems.join('；'));
    }
    log({ t: Date.now(), level: 'ok', msg: st.navStepId + ' ✓ 落地校验通过（' + location.href.slice(0, 80) + '…）' });
    // 导航步骤也进步骤表/日志（步骤表 ✓ 与结果导出完整）
    (st.stepLogs = st.stepLogs || []).push({
      id: st.navStepId, name: step.name, mode: 'navigate', fromCache: false,
      assertResults: [{ assert: 'expect(url_contains+cookie_exists)', pass: true, detail: '落地校验通过' }],
      extract: {},
    });
    RunState.clear();
    // 继续执行后续步骤（抽取产物与日志从运行态恢复）
    return continueFrom(spec, params, stepIdx + 1, log, st.extracted || {}, st.stepLogs || []);
  }

  async function continueFrom(spec, params, fromIdx, log, extracted0, stepLogs0) {
    // 与 runSpec 相同的循环，从 fromIdx 继续（navigate 恢复专用）
    const { vars } = prepareVars(spec);
    const gate = makeLimiter(spec.rate_limit);
    const extracted = Object.assign({}, extracted0 || {});
    const stepLogs = stepLogs0 || [];
    let scope = buildScope(spec, params, extracted, vars);
    for (let i = fromIdx; i < spec.steps.length; i++) {
      const step = spec.steps[i];
      ensureStepVars(spec, step, vars);
      scope = buildScope(spec, params, extracted, vars); // 懒派生后重建作用域
      if (step.write === true) throw new RunnerError('E_PERM', 'v0.1 不执行写操作: ' + step.id);
      if (step.mode === 'navigate') {
        const nav = await execNavigate(spec, step, scope, extracted, stepLogs, log, () => {}, i);
        if (nav && nav.initiated) return { ok: true, navInitiated: true, stepId: step.id, stepLogs, extracted, resumed: true };
        continue;
      }
      if (step.mode === 'human') throw new RunnerError('E_PERM', 'human 原语 v0.2 提供: ' + step.id);
      if (step.mode !== 'api') throw new RunnerError('E_SPEC', '未知 mode: ' + step.mode);
      await execApi(spec, step, scope, extracted, stepLogs, log, () => {}, i, gate);
      scope = buildScope(spec, params, extracted, vars); // 每步重建作用域（同 runSpec）
    }
    const outputs = {};
    for (const k of Object.keys(spec.outputs || {})) {
      try { outputs[k] = ENGINE.resolvePlaceholders(spec.outputs[k], scope); }
      catch (e) { outputs[k] = '<解析失败: ' + e.message + '>'; }
    }
    return { ok: true, dryRun: true, outputs, stepLogs, extracted, resumed: true };
  }

  /* ==================== UI ==================== */

  const UI = {};
  UI.mount = function () {
    if (document.getElementById('masr-ball')) return;
    const css = document.createElement('style');
    css.textContent = `
      #masr-ball{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:44px;height:44px;border-radius:50%;
        background:#1a66ff;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;
        cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);user-select:none}
      #masr-dot{position:absolute;top:-2px;right:-2px;width:11px;height:11px;border-radius:50%;
        background:#e8452c;border:2px solid #fff;box-sizing:border-box;animation:masr-pulse 1.6s infinite}
      @keyframes masr-pulse{0%,100%{opacity:1}50%{opacity:.45}}
      #masr-panel{position:fixed;right:18px;bottom:70px;z-index:2147483000;width:520px;max-height:70vh;overflow:auto;
        background:#fff;color:#222;border:1px solid #d9d9e3;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.2);
        font:12px/1.6 -apple-system,'Segoe UI',sans-serif;padding:12px;display:none}
      #masr-panel h3{margin:2px 0 8px;font-size:13px}
      #masr-panel textarea{width:100%;height:110px;font:11px/1.5 Consolas,monospace;box-sizing:border-box}
      #masr-panel .row{margin:6px 0}
      #masr-panel button{margin-right:6px;padding:3px 10px;border:1px solid #bbb;border-radius:6px;background:#f6f7fa;cursor:pointer;font-size:12px}
      #masr-panel button.primary{background:#1a66ff;color:#fff;border-color:#1a66ff}
      #masr-panel .log{background:#101418;color:#cde3ff;font:11px/1.5 Consolas,monospace;padding:8px;border-radius:8px;
        max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-all}
      #masr-panel .ok{color:#4caf7d}.fatal{color:#ff6b6b}.warn{color:#ffb84d}
      #masr-panel table{border-collapse:collapse;width:100%}
      #masr-panel td,#masr-panel th{border:1px solid #e3e3ec;padding:2px 6px;text-align:left;font-size:11px}
      #masr-panel input{padding:2px 6px;border:1px solid #ccc;border-radius:4px;width:200px}
      .masr-tag{display:inline-block;padding:0 6px;border-radius:8px;font-size:10px;margin-left:6px}
    `;
    document.head.appendChild(css);

    const ball = document.createElement('div');
    ball.id = 'masr-ball'; ball.textContent = 'MAS';
    ball.title = 'MAS-Runner v' + GV.RUNNER_VERSION + '（点击打开/收起）';
    const panel = document.createElement('div');
    panel.id = 'masr-panel';
    panel.innerHTML = `
      <h3>MAS-Runner v${GV.RUNNER_VERSION}
        <button id="masr-check-update" style="font-size:11px;padding:1px 6px;margin-left:6px;cursor:pointer">检查更新</button>
        <button id="masr-dev-toggle" style="font-size:11px;padding:1px 6px;cursor:pointer" title="手工粘贴 spec.json（仅调试用）">dev</button>
        <span id="masr-update-out" style="font-size:11px;color:#666"></span>
        <span id="masr-spec-badge"></span>
      </h3>
      <div class="row" id="masr-selfcheck"></div>
      <div class="row" id="masr-tasks" style="border:1px solid #d6e4ff;background:#f7faff;border-radius:8px;padding:6px 8px"></div>
      <div class="row" id="masr-conn" style="border:1px solid #e5e6eb;border-radius:8px;padding:6px 8px"></div>
      <div class="row" id="masr-spec-box" style="display:none"><b>spec.json（开发调试用，正常不用碰）</b><br></div>
      <div class="row" id="masr-dev-tools" style="display:none">
        <button class="primary" id="masr-load">加载 spec</button>
        <button id="masr-fs-pull">从飞书拉 spec</button>
        <button id="masr-hash">计算 SHA-256</button>
        <span id="masr-hash-out"></span>
      </div>
      <div class="row" id="masr-params"></div>
      <div class="row">
        <button class="primary" id="masr-run">重跑当前 spec</button>
        <button id="masr-export">导出结果 JSON</button>
        <button id="masr-cancel-run">清除续跑状态</button>
        <button id="masr-clear-logs">清空日志</button>
      </div>
      <div class="row"><b>步骤时间线</b><div id="masr-steps"></div></div>
      <div class="row"><b>日志</b><div class="log" id="masr-log"></div></div>
      <div class="row" id="masr-result"></div>
    `;
    document.body.appendChild(ball); document.body.appendChild(panel);
    UI.makeSpecInput();
    ball.addEventListener('click', () => { panel.style.display = panel.style.display === 'block' ? 'none' : 'block'; if (panel.style.display === 'block') UI.renderSelfCheck(); });

    document.getElementById('masr-dev-toggle').addEventListener('click', function () {
      const box = document.getElementById('masr-spec-box');
      const tools = document.getElementById('masr-dev-tools');
      const on = box.style.display === 'none';
      box.style.display = on ? '' : 'none';
      tools.style.display = on ? '' : 'none';
      this.style.background = on ? '#e8f3ff' : '';
    });

    document.getElementById('masr-load').addEventListener('click', () => {
      UI.applySpec(UI.getSpecText(), {});
    });
    document.getElementById('masr-fs-pull').addEventListener('click', async () => {
      const btn = document.getElementById('masr-fs-pull');
      const old = btn.textContent;
      btn.textContent = '拉取中…'; btn.disabled = true;
      try {
        const rows = await fsSearchRecords(FS_BIZ.SPEC_TABLE);
        const cands = rows.filter(r => r.fields && r.fields.spec_json);
        if (!cands.length) throw new Error('飞书表里没有带 spec_json 的登记行');
        const isActive = (v) => (Array.isArray(v) ? v.indexOf('active') >= 0 : v === 'active');
        const actives = cands.filter(r => isActive(r.fields.spec_status));
        const pick = (actives.length ? actives : cands).sort((a, b) =>
          String(b.fields.version || '').localeCompare(String(a.fields.version || ''), 'zh-CN', { numeric: true }))[0];
        UI.applySpec(pick.fields.spec_json, {});
        UI.appendLog({
          t: Date.now(), level: 'ok',
          msg: '已从飞书拉取 spec：' + (pick.fields.name || pick.fields.script_id) + ' v' + (pick.fields.version || '?') +
            '（' + cands.length + ' 条候选，取 ' + (actives.length ? 'active' : '任意') + ' 最新）'
        });
      } catch (e) {
        UI.appendLog({ t: Date.now(), level: 'fatal', msg: '拉取 spec 失败：' + e.message });
      } finally {
        btn.textContent = old; btn.disabled = false;
      }
    });
    document.getElementById('masr-hash').addEventListener('click', async () => {
      const txt = UI.getSpecText();
      if (!txt) return;
      const h = await ENGINE.sha256Hex(txt);
      document.getElementById('masr-hash-out').textContent = h.slice(0, 16) + '…';
      console.log('[MASR] spec sha256 =', h);
      UI.appendLog({ t: Date.now(), level: 'info', msg: 'SHA-256（全文，供 spec_index 登记）: ' + h });
    });
    document.getElementById('masr-run').addEventListener('click', () => UI.doRun());
    document.getElementById('masr-export').addEventListener('click', () => {
      if (!UI.lastResult) { alert('还没有运行结果'); return; }
      const blob = new Blob([JSON.stringify(UI.lastResult, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'masr-result-' + (UI.spec ? UI.spec.spec_id : 'unknown') + '-' + Date.now() + '.json';
      a.click();
    });
    document.getElementById('masr-cancel-run').addEventListener('click', () => {
      RunState.clear(); UI.appendLog({ t: Date.now(), level: 'warn', msg: '续跑状态已清除' });
    });
    document.getElementById('masr-clear-logs').addEventListener('click', UI.clearLogs);
    document.getElementById('masr-check-update').addEventListener('click', UI.checkUpdate);
    UI.panel = panel;
  };

  // 粘贴输入框：行内强制样式防站点 CSS 吞掉；若仍不可见则降级为 contenteditable div
  UI.makeSpecInput = function () {
    const box = document.getElementById('masr-spec-box');
    const mk = (tag) => {
      const el = document.createElement(tag);
      el.id = 'masr-spec-text';
      el.style.cssText = 'display:block!important;visibility:visible!important;opacity:1!important;'
        + 'width:100%!important;height:110px!important;min-height:110px!important;margin:4px 0 0;padding:6px!important;'
        + 'font:11px/1.5 Consolas,monospace!important;color:#222!important;background:#fafafa!important;'
        + 'border:1px solid #bbb!important;border-radius:6px!important;box-sizing:border-box!important;white-space:pre-wrap!important;overflow:auto!important';
      if (tag === 'TEXTAREA') el.placeholder = '粘贴 specs/<spec_id>/spec.json 全文';
      else { el.contentEditable = 'true'; el.setAttribute('data-placeholder', '粘贴 specs/<spec_id>/spec.json 全文'); el.textContent = ''; }
      box.appendChild(el);
      return el;
    };
    let el = mk('TEXTAREA');
    // 100ms 后体检：被站点 CSS 隐藏（高度为 0 / 不可见）→ 换 contenteditable div
    setTimeout(() => {
      if (!el.isConnected || el.offsetHeight < 10) {
        el.remove();
        el = mk('DIV');
        UI.specInputMode = 'editable';
        console.warn('[MASR] 站点样式隐藏了 textarea，已降级为 contenteditable 输入框');
        UI.specInput = el;
        UI.restoreSpecText(); // 降级替换后把记忆的 spec 文本重新填回去
      }
      UI.specInput = el;
    }, 100);
    UI.specInput = el;
  };
  // 把「上次加载的 spec 原文」回填到粘贴框（刷新/降级换框后都能看到同一份内容）
  UI.restoreSpecText = function () {
    const t = GM_getValue(GV.LAST_SPEC_KEY, '');
    const el = UI.specInput;
    if (!t || !el) return;
    if (el.tagName === 'TEXTAREA') el.value = t; else el.textContent = t;
  };
  UI.getSpecText = function () {
    const el = UI.specInput;
    if (!el) return '';
    return el.tagName === 'TEXTAREA' ? el.value : el.textContent;
  };

  // 粘贴文本清洗：剥离 BOM/零宽字符；直接解析失败再尝试弯引号还原（自动修复并明确告知）
  UI.parseSpecText = function (raw) {
    const clean = String(raw || '')
      .replace(/^\uFEFF/, '')
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      .trim();
    try { return { spec: JSON.parse(clean), repaired: false }; }
    catch (e1) {
      const fixed = clean.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
      const spec = JSON.parse(fixed); // 仍失败就抛原始样式错误
      return { spec, repaired: true };
    }
  };

  /* ==================== 直连模式（v0.4：Runner 自己调飞书开放 API） ====================
   * 目标：不依赖任何后端，也能「拉任务 → 执行 → 回写」跑通。
   *
   * 凭证不再明文/混淆放在脚本里，而是 AES-256-GCM 密文（下面 ENC）。
   * 解它的钥匙由 PKDF2-SHA256(口令, 60 万轮) 现场派生 —— 口令不在脚本里，
   * 由管理员私下发放，脚本首次使用时人工输入一次。
   *
   * 这道防线拦得住什么：脚本公开挂在网上 = 只泄露一段密文，没有口令打不开。
   * 拦不住什么：拿到口令的人（也就是所有正式使用者）能解出 app_secret；
   *   口令若太弱，拿到密文的人可以离线穷举。所以口令必须够长（≥16 位随机）。
   * 真要「连使用者都碰不到密钥」，只有服务端代持一条路（面板填服务地址即可切换）。
   *
   * 切回服务端：面板里填上服务地址即可 —— SVC.mode() 变成 'svc'，本模块不再被调用。
   */
  const ENC = {
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iter: 600000,
    salt: '/uh49taz9B3WjbOsxjHymw==',
    iv: 'NH9L7UajUnCrkMo0',
    ct: 'bcfMO7KlPEVBJZaoDSeaCfeE4ctE5/BndwT2ok3cuzGDE8Yi5K417EzMSRT4ZKi24b+Ya61R5Dpi/mrDP8Kj9bwk7wdYL42A2LVyXKhEhntpF30BNlk=',
  };
  const KEK_KEY = 'masr_kek_v1';   // 派生出来的钥匙（base64），存了就不用每次输口令
  const CRED_KEY = 'masr_cred_v1'; // 解出来的凭证，仅本次会话内存使用

  function b64ToBytes(s) {
    const bin = atob(String(s || ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(u) {
    let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s);
  }

  async function deriveKek(pass, salt, iter) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: iter, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']
    );
  }

  // AES-GCM 的认证标签会替我验口令：口令错 → 直接抛 OperationError
  async function openWith(kek) {
    const buf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(ENC.iv) }, kek, b64ToBytes(ENC.ct)
    );
    const o = JSON.parse(new TextDecoder().decode(buf));
    if (!o || !o.id || !o.sec) throw new Error('E_ENC_SHAPE');
    return { id: String(o.id), sec: String(o.sec) };
  }

  const FL = {
    API: 'https://open.feishu.cn/open-apis',
    APP_TOKEN: 'OC2LbUsiLaRyhcse8P2cZyXintf',
    T_TASKS: 'tblvQkpB9o2ovRiR',
    T_SPECS: 'tblKAlQwYgLT3fys',
    T_REG: 'tblXzPlk6NLPxsNS',
    FORM_URL: 'https://scnzhojz10ln.feishu.cn/share/base/form/shrcn1WrOocHO5cG8cHrorhXJJe',
    TTL_MIN: 30,
    TOK_KEY: 'masr_fl_token_v1',
  };

  // 字段名（与服务端 mas-service.mjs 的 F 保持一致）
  const FF = {
    SCENE: '场景ID',
    ACCOUNT_ID: '账户ID', ACCOUNT_NAME: '账户名称', CLIENT: '客户主体', STATUS: '状态',
    SECRET: '秘钥', ERROR_TYPE: '错误类型', ELAPSED: '耗时ms',
    RUNNER_VER: 'runner版本', SPEC_VER: 'spec版本', CREATOR: '创建人',
    REG_NAME: '姓名', REG_DEPT: '部门', REG_CODE: '授权码', REG_DEVICE: '身份ID', REG_CREATED: '创建时间',
  };
  const WRITABLE = [FF.STATUS, FF.SECRET, FF.ERROR_TYPE, FF.ELAPSED, FF.RUNNER_VER, FF.SPEC_VER];
  const ST = { OK: '获取成功', FAIL: '获取失败' };

  /* --- 值归一化：文本可能是字符串 / 富文本分段数组；人员字段是 {id,name} 数组 --- */
  function flPlain(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (Array.isArray(v)) {
      return v.map(function (x) {
        if (x == null) return '';
        if (typeof x === 'string') return x;
        return x.text != null ? x.text : (x.name || x.en_name || '');
      }).join('');
    }
    if (typeof v === 'object') {
      if (v.text != null) return String(v.text);
      if (v.value != null) return flPlain(v.value);
      return v.name || '';
    }
    return String(v);
  }
  function flPeople(v) {
    if (!v) return [];
    const arr = Array.isArray(v) ? v : [v];
    return arr.map(function (x) {
      return { open_id: (x && (x.id || x.open_id)) || '', name: (x && (x.name || x.en_name)) || '' };
    }).filter(function (p) { return p.open_id; });
  }

  /* --- 凭证：口令解锁 → 内存缓存；没解锁就发不出任何请求 --- */
  FL._c = null;
  FL.lockedReason = 'need-pass'; // '' | 'need-pass' | 'bad-pass' | 'no-crypto' | 'no-blob'

  FL.unlocked = function () { return !!FL._c; };

  FL.unlock = async function (pass, remember) {
    if (!ENC.salt || String(ENC.salt).indexOf('__') === 0) {
      FL.lockedReason = 'no-blob';
      throw new Error('E_ENC 这个构建没有内嵌凭证');
    }
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      FL.lockedReason = 'no-crypto';
      throw new Error('E_CRYPTO 当前页面不支持 WebCrypto（必须 https）');
    }
    const salt = b64ToBytes(ENC.salt);
    const kek = await deriveKek(pass, salt, ENC.iter);
    let cred;
    try {
      cred = await openWith(kek);
    } catch (e) {
      FL.lockedReason = 'bad-pass';
      throw new Error('E_PASS 口令不对');
    }
    FL._c = cred;
    FL.lockedReason = '';
    if (remember !== false) {
      try {
        const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kek));
        GM_setValue(KEK_KEY, bytesToB64(raw));
      } catch (e) {}
    }
    return cred;
  };

  // 开机静默解锁：只有本机存过钥匙时成立（换浏览器 / 清数据 / 换口令后都会要求重输）
  FL.boot = async function () {
    if (FL._c) return true;
    let saved = '';
    try { saved = GM_getValue(KEK_KEY, ''); } catch (e) {}
    if (!saved) { FL.lockedReason = 'need-pass'; return false; }
    try {
      const kek = await crypto.subtle.importKey('raw', b64ToBytes(saved), { name: 'AES-GCM' }, true, ['decrypt']);
      FL._c = await openWith(kek);
      FL.lockedReason = '';
      return true;
    } catch (e) {
      try { GM_deleteValue(KEK_KEY); } catch (e2) {}
      FL.lockedReason = 'need-pass';
      return false;
    }
  };

  // 所有走直连的调用统一从这里取凭证
  FL.ensure = async function () {
    if (FL._c) return FL._c;
    if (await FL.boot()) return FL._c;
    throw new Error('E_LOCKED 需要先输入接入口令');
  };

  // 换人用这台机器 / 口令轮换：清掉本机钥匙
  FL.lock = function () {
    FL._c = null; FL.lockedReason = 'need-pass';
    try { GM_deleteValue(KEK_KEY); } catch (e) {}
  };

  FL.token = async function (force) {
    if (!force) {
      let c = null;
      try { c = JSON.parse(GM_getValue(FL.TOK_KEY, 'null')); } catch (e) {}
      if (c && c.v && Date.now() < c.exp - 120000) return c.v;
    }
    const cr = await FL.ensure();
    const res = await fsHttp('POST', FL.API + '/auth/v3/tenant_access_token/internal', {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: cr.id, app_secret: cr.sec }),
    });
    let j = {};
    try { j = JSON.parse(res.text); } catch (e) { throw new Error('E_FL_PARSE http=' + res.status); }
    if (j.code !== 0 || !j.tenant_access_token) throw new Error('E_FL_TOKEN ' + j.code + ' ' + (j.msg || ''));
    GM_setValue(FL.TOK_KEY, JSON.stringify({ v: j.tenant_access_token, exp: Date.now() + (j.expire || 3000) * 1000 }));
    return j.tenant_access_token;
  };

  // 统一调用：token 过期（99991661/99991663）自动换一次再重试
  FL.api = async function (method, path, body, retried) {
    const tok = await FL.token();
    const res = await fsHttp(method, FL.API + path, {
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json; charset=utf-8' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = {};
    try { j = JSON.parse(res.text); } catch (e) { throw new Error('E_FL_PARSE http=' + res.status); }
    if (!retried && (j.code === 99991661 || j.code === 99991663)) {
      await FL.token(true);
      return FL.api(method, path, body, true);
    }
    if (j.code !== 0) {
      if (j.code === 1254043) { const e = new Error('E_NOT_FOUND 记录不存在'); e.status = 404; throw e; }
      throw new Error('E_FL ' + j.code + ' ' + (j.msg || '') + ' ' + String(path).split('?')[0]);
    }
    return j.data || {};
  };

  const flTab = function (t) { return '/bitable/v1/apps/' + FL.APP_TOKEN + '/tables/' + t; };
  // 注意：不传 field_names —— 实测会让文本字段变成分段数组、长文本被吞
  FL.search = function (table, filter, size, auto) {
    return FL.api('POST', flTab(table) + '/records/search?page_size=' + (size || 50), {
      filter: filter, automatic_fields: auto !== false,
    });
  };

  /* 回写守卫：只认「以本人身份查询到的待办」里的 record_id。
   * 用途是防止误传/构造 id 去改别的行 —— 线上数据只允许改自己刚查出来的那几条。
   * 名单落 GM（最多 80 条），页面刷新后仍可回写，但永远不会扩大到你没查过的记录。
   */
  FL.CLAIM_KEY = 'masr_fl_claims_v1';
  FL._mine = (function () {
    try { return JSON.parse(GM_getValue('masr_fl_claims_v1', '{}')) || {}; } catch (e) { return {}; }
  })();
  FL.claim = function (recordId) {
    if (!recordId) return;
    FL._mine[String(recordId)] = Date.now();
    try {
      const ks = Object.keys(FL._mine);
      if (ks.length > 80) ks.slice(0, ks.length - 80).forEach(function (k) { delete FL._mine[k]; });
      GM_setValue(FL.CLAIM_KEY, JSON.stringify(FL._mine));
    } catch (e) {}
  };
  FL.claimed = function (recordId) { return !!FL._mine[String(recordId || '')]; };

  /* --- 设备码：本地 HMAC 签名（服务端版本用 app_secret 做同样的事，切过去无缝） --- */
  function flB64uEncode(str) {
    const u = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function flB64uDecode(s) {
    const b = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b + '='.repeat((4 - b.length % 4) % 4));
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(u);
  }
  async function flHmac16(text) {
    const enc = new TextEncoder();
    const cr = await FL.ensure();
    const k = await crypto.subtle.importKey('raw', enc.encode(cr.sec), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', k, enc.encode(String(text)));
    let hex = '';
    new Uint8Array(sig).forEach(function (b) { hex += (b < 16 ? '0' : '') + b.toString(16); });
    return hex.slice(0, 16);
  }
  async function flSign(openId) { return 'd_' + flB64uEncode(String(openId)) + '.' + (await flHmac16(openId)); }
  async function flVerify(code) {
    const m = /^d_([A-Za-z0-9_-]+)\.([0-9a-f]{16})$/.exec(String(code || ''));
    if (!m) return '';
    let openId = '';
    try { openId = flB64uDecode(m[1]); } catch (e) { return ''; }
    if (!openId) return '';
    return (await flHmac16(openId)) === m[2] ? openId : '';
  }

  function flIdentity(rec) {
    const f = rec.fields || {};
    const c = flPeople(f[FF.CREATOR])[0];
    if (!c) return null;
    return {
      name: flPlain(f[FF.REG_NAME]) || c.name,
      open_id: c.open_id,
      dept: flPlain(f[FF.REG_DEPT]),
      record_id: rec.record_id,
    };
  }

  /* --- 业务：待办 / spec / 回写 --- */
  FL.tasks = async function (limit) {
    const code = SVC.code();
    const openId = code ? await flVerify(code) : '';
    if (!openId) throw new Error('E_AUTH 设备码无效，请重新绑定');
    const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const data = await FL.search(FL.T_TASKS, {
      conjunction: 'and',
      conditions: [
        { field_name: FF.CREATOR, operator: 'is', value: [openId] },
        { field_name: FF.STATUS, operator: 'isEmpty', value: [] },
        { field_name: FF.ACCOUNT_ID, operator: 'isNotEmpty', value: [] },
      ],
    }, size, false);
    const items = (data.items || []).map(function (r) {
      const f = r.fields || {};
      return {
        record_id: r.record_id,
        account_id: flPlain(f[FF.ACCOUNT_ID]),
        account_name: flPlain(f[FF.ACCOUNT_NAME]),
        client: flPlain(f[FF.CLIENT]),
        // 行内「场景ID」优先（这一列现在还不存在，读不到就是空 → 回落到任务表默认场景）
        script_id: flPlain(f[FF.SCENE]),
        table_id: FL.T_TASKS,
      };
    });
    // 登记「本次查到的是哪几条」——回写时只认这些 id
    items.forEach(function (t) { FL.claim(t.record_id); });
    return { total: data.total != null ? data.total : items.length, items: items };
  };

  FL.spec = async function (scriptId) {
    const data = await FL.api('POST', flTab(FL.T_SPECS) + '/records/search?page_size=200', { automatic_fields: false });
    const rows = (data.items || []).filter(function (r) {
      const f = r.fields || {};
      return flPlain(f.script_id) === scriptId && flPlain(f.spec_json);
    });
    const pick = rows.sort(function (a, b) {
      return flPlain((b.fields || {}).version).localeCompare(flPlain((a.fields || {}).version), 'zh-CN', { numeric: true });
    })[0];
    if (!pick) throw new Error('E_NOT_FOUND 没有找到可用的 spec：' + scriptId);
    const f = pick.fields || {};
    let spec = flPlain(f.spec_json);
    try { spec = JSON.parse(spec); } catch (e) {}
    return { spec_id: scriptId, version: flPlain(f.version), status: flPlain(f.spec_status), spec: spec };
  };

  FL.writeResult = async function (payload) {
    const recordId = String(payload.record_id || '').trim();
    if (!recordId) throw new Error('E_PARAM 缺少 record_id');
    // 只允许回写「本次以本人身份查询到的待办」，别的一律拒绝（含手传/构造的 id）
    if (!FL.claimed(recordId)) {
      throw new Error('E_GUARD 这个 record_id 不在你刚查到的待办里，拒绝回写');
    }
    const code = SVC.code();
    const openId = code ? await flVerify(code) : '';
    if (!openId) throw new Error('E_AUTH 设备码无效');

    const rec = (await FL.api('GET', flTab(FL.T_TASKS) + '/records/' + encodeURIComponent(recordId))).record;
    if (!rec) throw new Error('E_NOT_FOUND 记录不存在');
    const creators = flPeople((rec.fields || {})[FF.CREATOR]);
    if (!creators.some(function (p) { return p.open_id === openId; })) {
      throw new Error('E_FORBIDDEN 这条记录不是你创建的，拒绝回写');
    }

    const fields = {};
    fields[FF.STATUS] = payload.ok ? ST.OK : ST.FAIL;
    if (payload.secret != null) fields[FF.SECRET] = String(payload.secret);
    if (payload.error_type) fields[FF.ERROR_TYPE] = String(payload.error_type);
    if (payload.elapsed_ms != null && isFinite(Number(payload.elapsed_ms))) fields[FF.ELAPSED] = Number(payload.elapsed_ms);
    if (payload.runner_version) fields[FF.RUNNER_VER] = String(payload.runner_version);
    if (payload.spec_version) fields[FF.SPEC_VER] = String(payload.spec_version);
    Object.keys(fields).forEach(function (k) { if (WRITABLE.indexOf(k) < 0) delete fields[k]; });

    await FL.api('PUT', flTab(FL.T_TASKS) + '/records/' + encodeURIComponent(recordId), { fields: fields });
    return { record_id: recordId, written: Object.keys(fields) };
  };

  /* --- 业务：绑定 --- */
  FL.bindMeta = function () {
    return { form_url: FL.FORM_URL, form_field: FF.REG_CODE, expires_min: FL.TTL_MIN, code_len: 6 };
  };

  FL.bindPoll = async function (opts) {
    const code = String(opts.code || '').trim().toUpperCase();
    const since = Number(opts.since || 0);
    const recId = String(opts.record_id || '').trim();

    let rec = null;
    let how = '';

    if (recId) {
      const d = await FL.api('GET', flTab(FL.T_REG) + '/records/' + encodeURIComponent(recId) + '?automatic_fields=true');
      rec = d.record || null;
      how = 'record_id';
    } else if (/^[A-Z0-9]{4,12}$/.test(code)) {
      const d = await FL.search(FL.T_REG, {
        conjunction: 'and',
        conditions: [{ field_name: FF.REG_CODE, operator: 'is', value: [code] }],
      }, 5);
      rec = (d.items || [])[0] || null;
      how = 'code';
    }

    if (!rec) {
      const d = await FL.search(FL.T_REG, {
        conjunction: 'and',
        conditions: [
          { field_name: FF.REG_DEVICE, operator: 'isEmpty', value: [] },
          { field_name: FF.REG_NAME, operator: 'isNotEmpty', value: [] },
        ],
      }, 50);
      let cands = d.items || [];
      if (since) {
        const floor = since - 120000;
        cands = cands.filter(function (r) {
          const c = Number(flPlain((r.fields || {})[FF.REG_CREATED]) || 0);
          return !c || c >= floor;
        });
      }
      if (cands.length === 1 && since > 0) { rec = cands[0]; how = 'time-window'; }
      else if (cands.length >= 1) {
        return {
          state: 'choose',
          hint: '检测到 ' + cands.length + ' 条未绑定的登记，请选你自己那条',
          candidates: cands.slice(0, 10).map(function (r) {
            const f = r.fields || {};
            return {
              record_id: r.record_id,
              name: flPlain(f[FF.REG_NAME]),
              dept: flPlain(f[FF.REG_DEPT]),
              created: Number(flPlain(f[FF.REG_CREATED]) || 0),
            };
          }),
        };
      } else return { state: 'pending' };
    }

    const fields = rec.fields || {};
    const created = Number(flPlain(fields[FF.REG_CREATED]) || 0);
    if (created && Date.now() - created > FL.TTL_MIN * 60000) {
      return { state: 'expired', hint: '这条登记已超过 ' + FL.TTL_MIN + ' 分钟，请换一个授权码再提交一次' };
    }

    const me = flIdentity(rec);
    if (!me) return { state: 'pending', hint: '记录已找到但取不到创建人，请确认表单已关闭匿名提交' };

    const existing = flPlain(fields[FF.REG_DEVICE]);
    if (existing && existing !== me.open_id) {
      return { state: 'pending', hint: '这条登记已被其他人绑定，请联系管理员' };
    }
    if (!existing) {
      await FL.api('PUT', flTab(FL.T_REG) + '/records/' + encodeURIComponent(rec.record_id), {
        fields: { [FF.REG_DEVICE]: me.open_id },
      });
    }
    const device = await flSign(me.open_id);
    return { state: 'bound', matched_by: how, device_code: device, name: me.name, dept: me.dept, open_id: me.open_id };
  };

  /** 校验设备码 + 回表确认未被撤销（等价服务端 /me） */
  FL.me = async function () {
    const code = SVC.code();
    if (!code) return null;
    const openId = await flVerify(code);
    if (!openId) return null;
    const d = await FL.search(FL.T_REG, {
      conjunction: 'and',
      conditions: [{ field_name: FF.REG_DEVICE, operator: 'is', value: [openId] }],
    }, 5);
    const rec = (d.items || [])[0];
    if (!rec) return null;
    const me = flIdentity(rec);
    if (!me || me.open_id !== openId) return null;
    GM_setValue(SVC.M_KEY, JSON.stringify({ name: me.name, open_id: me.open_id, dept: me.dept }));
    return me;
  };

  /* ==================== 任务服务（v0.2 主路径） ====================
   * 业务同学的飞书账号都是外部号，进不了自建应用可用范围 → 客户端拿不到 user_access_token。
   * 改为：身份留在服务端（应用身份代持），客户端只持一个可撤销的「接入码」。
   * 端点据接入码识别是谁，并强制只返回/只允许改 创建人 = 本人的行。
   */
  const SVC = {
    B_KEY: 'masr_svc_base_v1',
    C_KEY: 'masr_svc_code_v1',
    M_KEY: 'masr_svc_me_v1',
    // 场景 → script_id：按「任务表」给默认值，任务行填了「场景ID」则以行内为准。
    // 将来加场景：新任务表在这里加一行，或在那行任务里填场景ID —— 拉 spec 的代码不用改。
    SCENE_BY_TABLE: { tblvQkpB9o2ovRiR: 'huawei_ads_get_key' },
    DEFAULT_SCRIPT: 'huawei_ads_get_key',
    TASKS_TABLE: 'tblvQkpB9o2ovRiR',
  };
  SVC.base = function () { return String(GM_getValue(SVC.B_KEY, '') || '').replace(/\/+$/, ''); };
  SVC.code = function () { return String(GM_getValue(SVC.C_KEY, '') || ''); };
  SVC.me = function () { try { return JSON.parse(GM_getValue(SVC.M_KEY, 'null')); } catch (e) { return null; } };

  SVC.call = function (method, path, query, body) {
    const base = SVC.base();
    if (!base) return Promise.reject(new Error('E_SVC 还没填服务地址'));
    let url = base + path;
    const q = query || {};
    const ks = Object.keys(q);
    if (ks.length) url += '?' + ks.map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]); }).join('&');
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: method,
        url: url,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-mas-code': SVC.code() },
        data: body ? JSON.stringify(body) : null,
        timeout: 20000,
        onload: function (r) {
          let j = {};
          try { j = JSON.parse(r.responseText || '{}'); } catch (e) { return reject(new Error('E_SVC_PARSE http=' + r.status)); }
          if (r.status >= 400 || j.ok === false) return reject(new Error(j.error || ('E_SVC ' + r.status)));
          resolve(j);
        },
        onerror: function () { reject(new Error('E_SVC_NET ' + url)); },
        ontimeout: function () { reject(new Error('E_SVC_TIMEOUT ' + url)); },
      });
    });
  };

  /* 两种模式：填了服务地址走服务端（安全），没填就跑直连（无依赖，先能用） */
  SVC.mode = function () { return SVC.base() ? 'svc' : 'direct'; };

  /* 改后端地址 = 改身份来源：旧设备码可能不是这个端点签的，一并清掉重走绑定 */
  SVC.setBase = function (url) {
    const v = String(url || '').trim().replace(/\/+$/, '');
    if (v) GM_setValue(SVC.B_KEY, v); else GM_deleteValue(SVC.B_KEY);
    GM_deleteValue(SVC.C_KEY); GM_deleteValue(SVC.M_KEY);
    try { clearAuthCode(); } catch (e) {}
    return v;
  };

  /* 探活：直连模式不发请求；后端模式打 /health，顺便核对版本 */
  SVC.ping = function () {
    const base = SVC.base();
    if (!base) return Promise.resolve({ mode: 'direct' });
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'GET', url: base + '/health', timeout: 8000,
        onload: function (r) {
          let j = {};
          try { j = JSON.parse(r.responseText || '{}'); } catch (e) {}
          if (r.status !== 200) return reject(new Error('地址有响应但不是本服务（HTTP ' + r.status + '）'));
          if (j.service && j.service !== 'mas-service') return reject(new Error('这个地址不是 MAS 后端'));
          resolve({ mode: 'svc', version: j.version || '?' });
        },
        onerror: function () { reject(new Error('连不上 ' + base)); },
        ontimeout: function () { reject(new Error('超时（8 秒）' + base)); },
      });
    });
  };

  SVC.bind = async function () {
    let me;
    if (SVC.mode() === 'svc') me = (await SVC.call('GET', '/me')).me;
    else {
      me = await FL.me();
      if (!me) throw new Error('E_AUTH 设备码无效，或已在登记表里被撤销');
    }
    GM_setValue(SVC.M_KEY, JSON.stringify(me));
    return me;
  };
  /* 这条任务该用哪个场景的 spec：行内「场景ID」> 任务表默认 > 全局默认 */
  SVC.scriptFor = function (task) {
    const t = task || (typeof UI !== 'undefined' && UI.currentTask) || {};
    return String(t.script_id || SVC.SCENE_BY_TABLE[t.table_id || SVC.TASKS_TABLE] || SVC.DEFAULT_SCRIPT);
  };

  SVC.tasks = function () {
    const p = SVC.mode() === 'svc' ? SVC.call('GET', '/tasks', { limit: 50 }) : FL.tasks(50);
    return p.then(function (j) {
      (j.items || []).forEach(function (t) {
        if (!t.table_id) t.table_id = SVC.TASKS_TABLE;
      });
      return j;
    });
  };
  SVC.spec = function (scriptId) {
    const id = scriptId || SVC.scriptFor();
    return SVC.mode() === 'svc' ? SVC.call('GET', '/spec', { script_id: id }) : FL.spec(id);
  };
  SVC.writeResult = function (payload) {
    return SVC.mode() === 'svc' ? SVC.call('POST', '/result', null, payload) : FL.writeResult(payload);
  };
  SVC.bindMeta = function () {
    return SVC.mode() === 'svc' ? SVC.call('GET', '/bind/meta') : Promise.resolve(FL.bindMeta());
  };
  SVC.bindPoll = function (q) {
    return SVC.mode() === 'svc' ? SVC.call('GET', '/bind/poll', q || {}) : FL.bindPoll(q || {});
  };

  /* ---------- 授权码：本地随机生成，不经过服务端 ----------
   * 6 位 × 32 字符集（无 I/O/0/1）≈ 10.7 亿种，30 分钟窗口内碰撞概率可忽略。
   * 码只是「把表里某一行对上这次会话」的关联凭证，真正身份来自表单记录的创建人。
   */
  const AUTH_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const AUTH_LEN = 6;
  const AUTH_TTL_MS = 30 * 60 * 1000;
  const AUTH_KEY = 'masr.authcode';
  const FORM_KEY = 'masr.formurl';

  function genAuthCode() {
    let s = '';
    const buf = new Uint8Array(AUTH_LEN);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(buf);
    else for (let i = 0; i < AUTH_LEN; i++) buf[i] = Math.floor(Math.random() * 256);
    for (let i = 0; i < AUTH_LEN; i++) s += AUTH_CHARS[buf[i] % AUTH_CHARS.length];
    return s;
  }

  // 同一个码在 30 分钟内可复用（重开面板不用换码，用户填过的表也不会白填）
  function reuseAuthCode() {
    try {
      const saved = JSON.parse(GM_getValue(AUTH_KEY, 'null'));
      if (saved && saved.code && Date.now() - saved.ts < AUTH_TTL_MS) return saved.code;
    } catch (e) {}
    return '';
  }
  function saveAuthCode(code) {
    GM_setValue(AUTH_KEY, JSON.stringify({ code: code, ts: Date.now() }));
  }
  function clearAuthCode() { GM_deleteValue(AUTH_KEY); }

  /* ---------- 任务面板 v0.2.1：自助绑定（用户全程不接触任何 ID） ---------- */

  function modeTag() {
    return SVC.mode() === 'svc'
      ? '<span style="font-size:10px;color:#1a7f45;border:1px solid #b7e0c8;border-radius:3px;padding:0 4px;margin-left:4px">后端</span>'
      : '<span style="font-size:10px;color:#8f959e;border:1px solid #dcdfe6;border-radius:3px;padding:0 4px;margin-left:4px">直连</span>';
  }

  /* ---------- 连接方式：常驻一行，不随任务面板重绘消失 ----------
   * 直连 = 用脚本内凭证（口令解锁）；后端 = 填一个地址，密钥只在服务端。
   * 用户要能自己填地址，所以这里给一个永远可见的入口。
   */
  let connEditing = false;
  let connOut = '';

  function connTag() {
    return SVC.mode() === 'svc'
      ? '<span style="font-size:10px;color:#1a7f45;border:1px solid #b7e0c8;border-radius:3px;padding:0 4px">后端</span>'
      : '<span style="font-size:10px;color:#8f959e;border:1px solid #dcdfe6;border-radius:3px;padding:0 4px">直连</span>';
  }
  const connEsc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  UI.renderConn = function () {
    const box = document.getElementById('masr-conn');
    if (!box) return;
    const base = SVC.base();

    if (connEditing) {
      box.innerHTML = '<b>连接</b> ' + connTag() +
        '<div class="row" style="margin-top:4px"><input id="masr-conn-in" value="' + connEsc(base) +
        '" placeholder="http://127.0.0.1:8787" style="width:100%"></div>' +
        '<div class="row"><button class="primary" id="masr-conn-save">保存并测试</button>' +
        '<button id="masr-conn-direct">改回直连</button>' +
        '<button id="masr-conn-cancel">取消</button></div>' +
        '<div id="masr-conn-out" style="font-size:11px;color:#8f959e;line-height:1.6">' + connOut + '</div>';

      document.getElementById('masr-conn-save').addEventListener('click', function () {
        const v = (document.getElementById('masr-conn-in').value || '').trim();
        if (!v) { connOut = '留空就等于直连。要保存请先填地址。'; UI.renderConn(); return; }
        const had = !!SVC.code();
        SVC.setBase(v);
        connOut = '正在测试 ' + connEsc(v) + ' …';
        UI.renderConn();
        SVC.ping().then(function (r) {
          connEditing = false;
          connOut = '<span style="color:#1a7f45">已连上后端 v' + connEsc(r.version) + '</span>' +
            (had ? ' · 换端点了，需要重新绑一次身份' : '');
          UI.renderTasks();
        }).catch(function (e) {
          connOut = '<span style="color:#c02a2a">' + connEsc(e.message) + '</span><br>地址已存下，服务起来后点「改地址」再存一次即可。';
          UI.renderConn();
        });
      });

      document.getElementById('masr-conn-direct').addEventListener('click', function () {
        SVC.setBase('');
        connEditing = false;
        connOut = '已切回直连。';
        UI.renderTasks();
      });

      document.getElementById('masr-conn-cancel').addEventListener('click', function () {
        connEditing = false;
        connOut = '';
        UI.renderConn();
      });
      return;
    }

    box.innerHTML = '<b>连接</b> ' + connTag() +
      ' <span style="font-size:11px;color:#4e5969">' +
      (base ? connEsc(base) : '直连（用脚本内凭证，不经后端）') + '</span> ' +
      '<button id="masr-conn-edit" style="font-size:11px;padding:1px 6px">' + (base ? '改地址' : '填后端地址') + '</button>' +
      (base ? '<button id="masr-conn-off" style="font-size:11px;padding:1px 6px">切回直连</button>' : '') +
      '<div style="font-size:11px;color:#8f959e;margin-top:2px;line-height:1.6">' +
      (connOut || (base ? '' : '要验证后端就点「填后端地址」，本机起好服务后填 http://127.0.0.1:8787')) +
      '</div>';

    document.getElementById('masr-conn-edit').addEventListener('click', function () {
      connEditing = true; connOut = ''; UI.renderConn();
    });
    const off = document.getElementById('masr-conn-off');
    if (off) off.addEventListener('click', function () {
      SVC.setBase(''); connOut = '已切回直连。'; UI.renderTasks();
    });
  };

  // ① 还没配服务地址（只在直连不可用时出现）
  function renderSvcSetup(box, reason) {
    const head = reason === 'nokey'
      ? '内嵌凭证不可用，请填服务端地址'
      : '未配置服务地址';
    box.innerHTML = '<b>任务</b> <span style="color:#8f959e">' + head + '</span>' +
      '<div style="margin-top:4px;font-size:11px;color:#8f959e">正常情况下不需要填 —— 脚本自带直连；填写后改为走后端（更安全）</div>' +
      '<div class="row" style="margin-top:4px"><input id="masr-svc-base" placeholder="https://..." style="width:240px"> ' +
      '<button class="primary" id="masr-svc-save">保存</button></div>' +
      '<div id="masr-task-out" style="font-size:11px;color:#8f959e"></div>';
    document.getElementById('masr-svc-save').addEventListener('click', function () {
      const v = document.getElementById('masr-svc-base').value.trim();
      if (!v) { document.getElementById('masr-task-out').textContent = '请填服务地址'; return; }
      GM_setValue(SVC.B_KEY, v);
      UI.renderTasks();
    });
  }

  // ② 未解锁 → 输入接入口令（凭证是密文，没有口令什么都做不了）
  function renderUnlock(box) {
    const bad = FL.lockedReason === 'bad-pass';
    const broken = FL.lockedReason === 'no-blob' || FL.lockedReason === 'no-crypto';
    if (broken) {
      box.innerHTML = '<b>任务</b> <span style="color:#c02a2a">凭证不可用</span>' +
        '<div style="margin-top:6px;font-size:11px;color:#4e5969;line-height:1.7">' +
        (FL.lockedReason === 'no-blob'
          ? '这个构建没有内嵌凭证（发布版故意留空），请填服务端地址。'
          : '当前页面不支持 WebCrypto，请在 https 的飞书页面使用。') + '</div>' +
        '<div class="row" style="margin-top:6px"><input id="masr-svc-base" placeholder="https://..." style="width:240px"> ' +
        '<button class="primary" id="masr-svc-save">保存服务地址</button></div>';
      document.getElementById('masr-svc-save').addEventListener('click', function () {
        const v = document.getElementById('masr-svc-base').value.trim();
        if (!v) return;
        GM_setValue(SVC.B_KEY, v);
        UI.renderTasks();
      });
      return;
    }
    box.innerHTML = '<b>任务</b> <span style="color:#8f959e">未解锁</span>' +
      '<div style="margin-top:6px;font-size:11px;color:#4e5969;line-height:1.7">' +
      '首次使用请输入管理员发给你的<b>接入口令</b>。只需一次，本机记住。<br>' +
      '口令只用来解开脚本里的加密凭证，不会发往任何服务器。</div>' +
      '<div class="row" style="margin-top:6px">' +
      '<input id="masr-pass" type="password" placeholder="接入口令" autocomplete="off" style="width:230px"> ' +
      '<button class="primary" id="masr-pass-go">解锁</button></div>' +
      '<div id="masr-pass-out" style="margin-top:6px;font-size:11px;color:' + (bad ? '#c02a2a' : '#8f959e') + '">' +
      (bad ? '口令不对，再试一次' : '') + '</div>';

    const inp = document.getElementById('masr-pass');
    const out = document.getElementById('masr-pass-out');
    const go = document.getElementById('masr-pass-go');
    async function submit() {
      const p = inp.value;
      if (!p) { out.textContent = '请输入口令'; return; }
      go.disabled = true; go.textContent = '解锁中…'; out.textContent = '正在派生密钥（约 1 秒）…';
      try {
        await FL.unlock(p);
        out.textContent = '口令正确，正在校验凭证…';
        await FL.token(true);          // 真发一次换 token，确认凭证可用
        inp.value = '';
        UI.renderTasks();
      } catch (e) {
        go.disabled = false; go.textContent = '解锁';
        out.style.color = '#c02a2a';
        out.textContent = /E_PASS/.test(e.message) ? '口令不对，再试一次' : ('解锁失败：' + e.message.replace(/^E_\w+\s*/, ''));
      }
    }
    go.addEventListener('click', submit);
    inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') submit(); });
    setTimeout(function () { try { inp.focus(); } catch (e) {} }, 60);
  }

  // ③ 未绑定 → 自助绑定
  function renderBind(box) {
    box.innerHTML = '<b>任务</b> <span style="color:#8f959e">未绑定身份</span>' + modeTag() +
      '<div style="margin-top:6px;font-size:11px;color:#4e5969;line-height:1.7">' +
      '第一次使用，30 秒完成：<br>' +
      '① 点下面按钮 —— 自动复制授权码，并打开飞书登记表单<br>' +
      '② 表单里「授权码」一栏粘贴它，填好姓名部门，提交<br>' +
      '③ 提交后这里自动完成，不用再点任何东西' +
      '</div>' +
      '<div style="margin-top:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
      '<span id="masr-bindcode" title="点击复制" style="font-family:ui-monospace,Consolas,monospace;font-size:22px;letter-spacing:4px;font-weight:700;color:#1d4ed8;cursor:pointer;user-select:all">······</span>' +
      '<button class="primary" id="masr-bind-go">复制授权码并打开表单</button>' +
      '<button id="masr-bind-again" style="display:none">换一个码</button>' +
      '</div>' +
      '<div id="masr-bind-out" style="margin-top:6px;font-size:11px;color:#8f959e"></div>';

    const $out = function () { return document.getElementById('masr-bind-out'); };
    const $code = function () { return document.getElementById('masr-bindcode'); };
    const $again = function () { return document.getElementById('masr-bind-again'); };

    let bindCode = '';
    let formUrl = '';
    let expiresMin = 30;
    let tipTimer = null;

    function copyText(t) {
      return new Promise(function (resolve) {
        function fallback() {
          try {
            const ta = document.createElement('textarea');
            ta.value = t;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
          } catch (e) { return false; }
        }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(t).then(function () { resolve(true); })
              .catch(function () { resolve(fallback()); });
            return;
          }
        } catch (e) {}
        resolve(fallback());
      });
    }

    function tip(msg) {
      const out = $out();
      if (!out) return;
      out.textContent = msg;
      if (tipTimer) clearTimeout(tipTimer);
      tipTimer = setTimeout(function () {
        const o = $out();
        if (o && o.textContent === msg) o.textContent = '';
      }, 6000);
    }

    function copyNow(quiet) {
      if (!bindCode) return Promise.resolve(false);
      return copyText(bindCode).then(function (ok) {
        if (ok) tip('授权码 ' + bindCode + ' 已复制 —— 粘到表单「授权码」一栏');
        else tip('自动复制被浏览器拦下了，请手动选中上面的 ' + bindCode + ' 复制');
        return ok;
      });
    }

    function showChoose(cands) {
      const out = $out();
      if (!out) return;
      if (!cands || !cands.length) { out.textContent = '没有可选的登记记录，请先提交表单'; return; }
      out.innerHTML = '<div style="margin-bottom:4px">没按码匹配到，检测到 ' + cands.length + ' 条未绑定登记，点你自己那条：</div>' +
        cands.map(function (c, i) {
          const t = c.created ? new Date(c.created).toLocaleTimeString('zh-CN', { hour12: false }) : '';
          const label = (c.name || '(无名)') + (c.dept ? ' · ' + c.dept : '') + (t ? ' · ' + t : '');
          return '<button data-cand="' + i + '" style="margin:2px 6px 2px 0">' + label + '</button>';
        }).join('');
      out.querySelectorAll('button[data-cand]').forEach(function (b) {
        b.addEventListener('click', function () {
          const c = cands[Number(b.getAttribute('data-cand'))];
          if ($out()) $out().textContent = '正在绑定「' + (c.name || '') + '」…';
          pollBind({ record_id: c.record_id }, 6);
        });
      });
    }

    function onBound(j) {
      GM_setValue(SVC.C_KEY, j.device_code);
      GM_setValue(SVC.M_KEY, JSON.stringify({ name: j.name, open_id: j.open_id, dept: j.dept || '' }));
      UI.appendLog({ t: Date.now(), level: 'ok', msg: '身份绑定完成：' + j.name + (j.dept ? '（' + j.dept + '）' : '') + '，之后只显示你自己的待办' });
      UI.renderTasks();
    }

    function pollBind(state, tries) {
      if (!$code()) return;
      SVC.bindPoll(state).then(function (j) {
        if (!$code()) return;
        if (j.state === 'bound') return onBound(j);
        if (j.state === 'choose') { showChoose(j.candidates); return; }
        if (j.state === 'expired') {
          tip(j.hint || '登记已过期，请点「换一个码」再走一次');
          if ($again()) $again().style.display = '';
          return;
        }
        if (tries <= 0) {
          tip('等待超时。填完表后点「换一个码」再走一次。');
          if ($again()) $again().style.display = '';
          return;
        }
        const out = $out();
        if (out) {
          out.textContent = (j.hint ? j.hint + '；' : '') + '等待提交…（最长再等 ' + Math.ceil(tries * 3 / 60) + ' 分钟）';
        }
        setTimeout(function () { pollBind(state, tries - 1); }, 3000);
      }).catch(function (e) {
        if (!$code()) return;
        const out = $out();
        if (out) out.textContent = '轮询出错：' + e.message + '（重试中）';
        if (tries > 0) setTimeout(function () { pollBind(state, tries - 1); }, 6000);
      });
    }

    function acquire(force) {
      // 码由本地面生成：30 分钟内复用同一个，force=true 才换新的
      bindCode = force ? '' : reuseAuthCode();
      if (!bindCode) { bindCode = genAuthCode(); saveAuthCode(bindCode); }
      if ($code()) $code().textContent = bindCode;

      formUrl = GM_getValue(FORM_KEY, '');
      if (formUrl) tip('授权码已就绪，' + expiresMin + ' 分钟内有效');
      else tip('正在获取表单地址…');

      SVC.bindMeta().then(function (j) {
        formUrl = j.form_url || '';
        expiresMin = j.expires_min || expiresMin;
        GM_setValue(FORM_KEY, formUrl);
        tip('授权码已就绪，' + expiresMin + ' 分钟内有效 —— 点按钮会先复制再打开表单');
      }).catch(function (e) {
        tip(formUrl ? '表单地址沿用上次缓存；服务端暂时连不上：' + e.message
                    : '连不上服务端，拿不到表单地址：' + e.message);
      });
      if ($again()) $again().style.display = '';
    }

    if ($code()) {
      $code().addEventListener('click', function () { copyNow(); });
    }

    document.getElementById('masr-bind-go').addEventListener('click', function () {
      if (!bindCode) { tip('授权码还没生成，稍等一下再点'); return; }
      const state = { code: bindCode, since: Date.now() };
      copyNow().then(function () {
        if (formUrl) { try { window.open(formUrl, '_blank', 'noopener'); } catch (e) {} }
        else tip('没有表单地址，请手动打开管理员给你的飞书登记表单');
        pollBind(state, 200);
      });
    });

    $again().addEventListener('click', function () {
      $again().style.display = 'none';
      clearAuthCode();
      acquire(true);
    });

    acquire(false);
  }

  // ③ 已绑定 → 我的待办
  function renderBound(box, me) {
    box.innerHTML = '<b>任务</b> <span style="color:#1a7f45">' + (me.name || '已绑定') +
      (me.dept ? ' · ' + me.dept : '') + '</span>' + modeTag() +
      ' <button class="primary" id="masr-task-pull">拉我的待办</button>' +
      ' <button id="masr-task-unbind">解除绑定</button>' +
      ' <button id="masr-task-lock" title="清掉本机保存的口令钥匙，下次需重新输入">锁定</button>' +
      '<div id="masr-task-list" style="margin-top:4px"></div>';

    document.getElementById('masr-task-lock').addEventListener('click', function () {
      FL.lock(); UI.renderTasks();
    });

    document.getElementById('masr-task-unbind').addEventListener('click', function () {
      // 换人用这台电脑：设备码、授权码、可回写名单一起清掉
      GM_deleteValue(SVC.C_KEY); GM_deleteValue(SVC.M_KEY);
      try { GM_deleteValue(FL.CLAIM_KEY); FL._mine = {}; } catch (e) {}
      clearAuthCode(); UI.renderTasks();
    });
    document.getElementById('masr-task-pull').addEventListener('click', async function () {
      const list = document.getElementById('masr-task-list');
      list.innerHTML = '<span style="font-size:11px;color:#8f959e">正在查询…</span>';
      try {
        const j = await SVC.tasks();
        if (!j.total) {
          list.innerHTML = '<div style="font-size:11px;color:#8f959e">没有待处理的记录（需同时满足：创建人是你、状态为空、账户ID已填）</div>';
          return;
        }
        list.innerHTML = '<div style="font-size:11px;color:#8f959e">共 ' + j.total + ' 条待办：点「执行」直接开跑（自动拉对应场景的 spec，账户ID 来自这行）</div>' +
          '<table><tr><th>账户ID</th><th>名称</th><th>客户</th><th></th></tr>' +
          j.items.map(function (t, i) {
            return '<tr><td>' + (t.account_id || '-') + '</td><td>' + (t.account_name || '-') + '</td>' +
              '<td>' + (t.client || '-') + '</td><td><button class="primary" data-idx="' + i + '">执行</button></td></tr>';
          }).join('') + '</table>';
        list.querySelectorAll('button[data-idx]').forEach(function (b) {
          b.addEventListener('click', function () { UI.runTask(j.items[Number(b.getAttribute('data-idx'))], b); });
        });
      } catch (e) {
        list.innerHTML = '<div style="font-size:11px;color:#c02a2a">' + e.message + '</div>';
      }
    });
  }

  let flBootTried = false;
  UI.renderTasks = function () {
    const box = document.getElementById('masr-tasks');
    if (!box) return;
    // 直连模式：先尝试静默解锁（本机存过钥匙才成立），不成再要口令
    if (!SVC.base() && !FL.unlocked()) {
      if (!flBootTried) {
        flBootTried = true;
        box.innerHTML = '<b>任务</b> <span style="color:#8f959e">检查凭证…</span>';
        FL.boot().then(function (ok) { if (ok) UI.renderTasks(); else renderUnlock(box); })
          .catch(function () { renderUnlock(box); });
        return;
      }
      renderUnlock(box);
      return;
    }
    if (!SVC.code()) { renderBind(box); return; }
    const me = SVC.me();
    if (!me) {
      box.innerHTML = '<b>任务</b> <span style="color:#c02a2a">设备码失效（可能已在表里撤销）</span>' +
        '<div class="row"><button id="masr-svc-reset">重新绑定身份</button>' +
        '<button id="masr-svc-rebind">重试连接</button></div><div id="masr-task-out" style="font-size:11px"></div>';
      document.getElementById('masr-svc-reset').addEventListener('click', function () {
        GM_deleteValue(SVC.C_KEY); GM_deleteValue(SVC.M_KEY); clearAuthCode(); UI.renderTasks();
      });
      document.getElementById('masr-svc-rebind').addEventListener('click', async function () {
        try { await SVC.bind(); UI.renderTasks(); }
        catch (e) { document.getElementById('masr-task-out').textContent = e.message; }
      });
      return;
    }
    renderBound(box, me);
  };

  // 任务面板每次重绘之后都带上「连接」行，保证入口永远在
  (function () {
    const inner = UI.renderTasks;
    UI.renderTasks = function () { inner(); if (UI.renderConn) UI.renderConn(); };
  })();

  // 点一条待办：拉 active spec → 自动填账户ID → 提示点执行
  /* 点待办里的「执行」= 载入 + 立刻开跑，不需要再点下面那个按钮 */
  UI.runTask = async function (task, btn) {
    if (UI._running) return;
    UI._running = true;
    const old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '执行中…'; }
    try {
      UI.currentTask = {
        record_id: task.record_id, account_id: task.account_id,
        table_id: task.table_id, script_id: task.script_id || '',
      };
      const scene = SVC.scriptFor(UI.currentTask);
      UI.appendLog({ t: Date.now(), level: 'info', msg: '载入任务：账户 ' + (task.account_id || '') + '（' + task.record_id + '）· 场景 ' + scene });
      const s = await SVC.spec(scene);
      UI.currentTask.spec_version = s.version;
      UI.applySpec(JSON.stringify(s.spec), { persist: true });
      UI.appendLog({ t: Date.now(), level: 'ok', msg: '开始执行 ' + s.spec_id + ' v' + s.version + '，账户ID 已从任务带入' });
      await UI.doRun({ keepLog: true });
    } catch (e) {
      UI.appendLog({ t: Date.now(), level: 'fatal', msg: '执行失败（载入阶段）：' + e.message });
    } finally {
      UI._running = false;
      if (btn) { btn.disabled = false; btn.textContent = old || '执行'; }
    }
  };

  // 执行完成 → 回写飞书（按 record_id 更新，服务端二次校验归属）
  async function pushTaskResult(st, ok, outputs, err) {
    const task = st && st.task;
    if (!task || !task.record_id) return;
    const payload = {
      record_id: task.record_id,
      ok: !!ok,
      elapsed_ms: Date.now() - (st.startedAt || Date.now()),
      runner_version: GV.RUNNER_VERSION,
      spec_version: st.specVersion || '',
    };
    if (ok) payload.secret = (outputs && (outputs.api_key || outputs.secret)) || '';
    else payload.error_type = (err && err.code) || 'E_UNKNOWN';
    try {
      await SVC.writeResult(payload);
      UI.appendLog({ t: Date.now(), level: 'ok', msg: '✅ 已回写飞书：' + (ok ? '获取成功' : '获取失败（' + payload.error_type + '）') });
    } catch (e) {
      UI.appendLog({ t: Date.now(), level: 'fatal', msg: '⚠️ 回写飞书失败：' + e.message + '（结果仍在本面板可复制/导出）' });
    }
  }

  /* 参数取值：任务行能给的直接给，不再让人手抄账户ID（抄错就会跑到别人账户上） */
  UI.taskParamValue = function (name) {
    const t = UI.currentTask || {};
    if (!t.record_id) return '';
    if (name === 'corp_id' || name === 'account_id' || name === 'sub_account_id' || name === 'customer_id') {
      return t.account_id || '';
    }
    if (t.params && t.params[name] != null) return String(t.params[name]);
    return '';
  };

  UI.renderParams = function (spec) {
    const box = document.getElementById('masr-params');
    const last = UI.lastParamsFor(spec.spec_id);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const list = spec.params || [];
    const hasTask = !!(UI.currentTask && UI.currentTask.record_id);
    if (!list.length) { box.innerHTML = '<b>参数</b> <i>这个 spec 不需要参数</i>'; return; }
    box.innerHTML = '<b>参数</b>' +
      (hasTask ? ' <span style="font-size:11px;color:#1a7f45">来自当前任务，无需填写</span>' : '') +
      list.map(function (p) {
        const auto = UI.taskParamValue(p.name);
        if (auto) {
          return '<div class="row"><label>' + esc(p.label || p.name) + '：</label>' +
            '<code style="background:#f2f3f5;padding:1px 6px;border-radius:4px">' + esc(auto) + '</code>' +
            '<span style="font-size:10px;color:#8f959e;margin-left:6px">任务行</span></div>';
        }
        return '<div class="row"><label>' + esc(p.label || p.name) + ' (' + p.name + ')：</label>' +
          '<input id="masr-p-' + p.name + '" value="' + esc(last[p.name] || '') + '" placeholder="' + esc(p.description || '') + '"></div>';
      }).join('');
  };

  // 参数记忆：按 spec_id 存最近一次填写的值（业务同学天天跑同一子客，不用每次重敲）
  UI.lastParamsFor = function (specId) {
    try { return JSON.parse(GM_getValue(GV.LAST_PARAMS_KEY, '{}'))[specId] || {}; } catch (e) { return {}; }
  };
  UI.saveParams = function (specId, params) {
    try {
      const all = JSON.parse(GM_getValue(GV.LAST_PARAMS_KEY, '{}'));
      all[specId] = params;
      GM_setValue(GV.LAST_PARAMS_KEY, JSON.stringify(all));
    } catch (e) { /* 记忆失败不影响执行 */ }
  };

  // spec 加载：抽取为公共函数，供「加载 spec」按钮与启动时自动恢复共用
  UI.applySpec = function (text, opts) {
    opts = opts || {};
    try {
      const { spec, repaired } = UI.parseSpecText(text);
      validateSpecShape(spec);
      UI.spec = spec;
      if (opts.persist !== false) GM_setValue(GV.LAST_SPEC_KEY, text);
      const badge = document.getElementById('masr-spec-badge');
      badge.innerHTML = spec.spec_id + ' v' + spec.version +
        ' <span class="masr-tag" style="background:' + (spec.status === 'active' ? '#e2f4e8;color:#1a7f43' : '#fff3d6;color:#8a6d1a') + '">' + spec.status + '</span>' +
        ' <span class="masr-tag" style="background:#eee">owner ' + (spec.owner || '?') + '</span>';
      UI.renderParams(spec);
      document.getElementById('masr-run').textContent = spec.status === 'active' ? '重跑当前 spec' : '执行（draft → dry_run）';
      // 自动恢复（fromStore）静默处理：只更新 badge/参数表，不往跨页日志里灌噪音
      if (!opts.fromStore) {
        UI.appendLog({ t: Date.now(), level: 'ok', msg: 'spec 已加载: ' + spec.spec_id + ' v' + spec.version + '，' + spec.steps.length + ' 步' });
      }
      if (repaired) UI.appendLog({ t: Date.now(), level: 'warn', msg: '检测到弯引号等脏字符，已自动修复——但建议以后先粘到记事本再复制过来，保证与 git 里的原文逐字节一致' });
      return true;
    } catch (e) {
      if (!opts.fromStore) UI.appendLog({ t: Date.now(), level: 'fatal', msg: 'spec 加载失败: ' + e.message });
      return false;
    }
  };

  UI.renderSelfCheck = function () {
    const sc = document.getElementById('masr-selfcheck');
    const items = [];
    items.push(['TM 存储', typeof GM_getValue === 'function' ? 'ok' : '缺失']);
    items.push(['页面 origin', location.origin]);
    const spec = UI.spec;
    const varNames = spec ? Object.keys(spec.vars || {}) : [];
    for (const n of varNames) {
      const def = spec.vars[n];
      const present = !!ENGINE.readCookie(document.cookie, def.name);
      items.push(['cookie ' + def.name, present ? '在位' : '不在位（该域下无此 cookie）']);
    }
    const st = RunState.get();
    items.push(['续跑状态', st ? ('存在：' + st.phase + ' @' + (st.navStepId || '')) : '无']);
    sc.innerHTML = '<b>自检</b>：' + items.map(([k, v]) =>
      '<span style="margin-right:12px">' + k + '=<b class="' + (/ok|在位/.test(v) ? 'ok' : 'warn') + '">' + v + '</b></span>').join('');
  };

  // 持久化日志：GM 跨页存储，页面跳转/刷新后仍可追溯（v0.1.9）
  const LogStore = {
    KEY: 'masr_logs_v1',
    MAX: 300, // 环形上限，超出淘汰最旧
    get() {
      try { return JSON.parse(GM_getValue(LogStore.KEY, '[]')) || []; }
      catch (e) { return []; }
    },
    push(entry) {
      const arr = LogStore.get();
      arr.push({ t: entry.t, level: entry.level, msg: String(entry.msg).slice(0, 2000) });
      while (arr.length > LogStore.MAX) arr.shift();
      try { GM_setValue(LogStore.KEY, JSON.stringify(arr)); } catch (e) { /* 存储失败不阻断执行 */ }
    },
    clear() { try { GM_deleteValue(LogStore.KEY); } catch (e) {} }
  };

  UI.renderLogEntry = function (entry) {
    const el = document.getElementById('masr-log');
    if (!el) return;
    const cls = entry.level === 'fatal' ? 'fatal' : entry.level === 'warn' ? 'warn' : entry.level === 'ok' ? 'ok' : '';
    el.innerHTML += '<span class="' + cls + '">[' + new Date(entry.t).toLocaleTimeString() + '] ' + entry.msg + '</span>\n';
    el.scrollTop = el.scrollHeight;
  };

  UI.appendLog = function (entry) {
    LogStore.push(entry);
    UI.renderLogEntry(entry);
  };

  UI.replayPersistedLogs = function () {
    const el = document.getElementById('masr-log');
    if (!el) return;
    const history = LogStore.get();
    if (!history.length) return;
    history.forEach(UI.renderLogEntry);
    // 分隔线：标记历史与本次页面会话的边界（不入存储）
    const sep = document.createElement('div');
    sep.style.cssText = 'color:#7a8aa0;border-top:1px dashed #7a8aa0;margin:6px 0;padding-top:4px';
    sep.textContent = '───── 以上为历史日志（跨页保留）｜本页：' + location.pathname.slice(0, 60) + ' ─────';
    el.appendChild(sep);
    el.scrollTop = el.scrollHeight;
  };

  UI.clearLogs = function () {
    LogStore.clear();
    const el = document.getElementById('masr-log');
    if (el) el.innerHTML = '';
    UI.appendLog({ t: Date.now(), level: 'warn', msg: '日志已清空' });
  };

  // ---------- 自更新：显式「检查更新」（油猴自身也会按 @updateURL 静默更新，这里是可见入口 + 版本提示） ----------
  function cmpVer(a, b) {
    const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }
  // 有新版本时在悬浮球上点一颗红点：不打扰，但一眼能看到
  function setUpdateDot(on, ver) {
    const ball = document.getElementById('masr-ball');
    if (!ball) return;
    let dot = document.getElementById('masr-dot');
    if (on) {
      if (!dot) {
        dot = document.createElement('span');
        dot.id = 'masr-dot';
        ball.appendChild(dot);
      }
      dot.title = '有新版本 v' + (ver || '') + ' 可更新';
      ball.title = 'MAS-Runner v' + GV.RUNNER_VERSION + '｜有新版本 v' + (ver || '') + '（点击打开/收起）';
    } else if (dot) {
      dot.remove();
      ball.title = 'MAS-Runner v' + GV.RUNNER_VERSION + '（点击打开/收起）';
    }
  }
  UI.setUpdateDot = setUpdateDot;

  UI.checkUpdate = async function (silent) {
    const out = document.getElementById('masr-update-out');
    if (out && !silent) out.textContent = '检查中…';
    let lastErr = '';
    for (const url of GV.UPDATE_MANIFEST) {
      try {
        const res = await gmFetch(url, { method: 'GET' });
        if (res.status !== 200) { lastErr = 'HTTP ' + res.status; continue; }
        const m = JSON.parse(res.text);
        if (cmpVer(m.version, GV.RUNNER_VERSION) > 0) {
          if (out) {
            out.innerHTML = '<span style="color:#1a7f43">发现新版本 v' + m.version + ' → </span>' +
              '<a href="' + (m.install_url || GV.INSTALL_URL) + '" target="_blank" style="color:#0b6cd4">点此更新</a>';
          }
          setUpdateDot(true, m.version);
          UI.appendLog({ t: Date.now(), level: 'warn', msg: '发现新版本 Runner v' + m.version + '（当前 v' + GV.RUNNER_VERSION + '）：' + (m.notes || '') });
        } else {
          if (out && !silent) out.innerHTML = '<span style="color:#666">已是最新 v' + GV.RUNNER_VERSION + '</span>';
          setUpdateDot(false);
          if (!silent) UI.appendLog({ t: Date.now(), level: 'ok', msg: 'Runner 已是最新版本 v' + GV.RUNNER_VERSION });
        }
        return;
      } catch (e) { lastErr = e.message; }
    }
    if (out && !silent) out.innerHTML = '<span style="color:#b00">检查失败</span>';
    if (!silent) UI.appendLog({ t: Date.now(), level: 'warn', msg: '更新检查失败（' + lastErr + '）——不影响使用，可稍后重试或手动到仓库安装' });
  };

  // 启动时静默自检（默认 6 小时一次）：不打扰、不弹窗，发现新版只在悬浮球点个红点
  UI.autoCheckUpdate = async function () {
    const KEY = 'masr_update_checked_at';
    const now = Date.now();
    const last = parseInt(GM_getValue(KEY, '0'), 10) || 0;
    if (now - last < 6 * 60 * 60 * 1000) return;
    GM_setValue(KEY, String(now));
    await UI.checkUpdate(true);
  };
  UI.renderSteps = function (spec) {
    const el = document.getElementById('masr-steps');
    el.innerHTML = '<table><tr><th>#</th><th>步骤</th><th>mode</th><th>状态</th></tr>' +
      spec.steps.map((s, i) =>
        '<tr><td>S' + (i + 1) + '</td><td>' + (s.name || s.id) + '</td><td>' + s.mode + '</td><td id="masr-step-' + s.id + '">待执行</td></tr>').join('') +
      '</table>';
  };
  UI.markStep = function (stepId, phase) {
    const el = document.getElementById('masr-step-' + stepId);
    if (!el) return;
    const map = { running: '⏳ running', requesting: '→ 请求中', navigating: '→ 导航中', passed: '✓ 通过', failed: '✗ 失败' };
    el.textContent = map[phase] || phase;
    el.style.color = phase === 'passed' ? '#1a7f43' : phase === 'failed' ? '#c22' : '#555';
  };

  UI.setSpecBadge = function (spec) {
    const badge = document.getElementById('masr-spec-badge');
    badge.innerHTML = spec.spec_id + ' v' + spec.version +
      ' <span class="masr-tag" style="background:' + (spec.status === 'active' ? '#e2f4e8;color:#1a7f43' : '#fff3d6;color:#8a6d1a') + '">' + spec.status + '</span>' +
      ' <span class="masr-tag" style="background:#eee">owner ' + (spec.owner || '?') + '</span>';
  };

  // 回放跳转前已完成的步骤（恢复日志可见性）
  UI.replayStepLogs = function (stepLogs) {
    (stepLogs || []).forEach(s => {
      UI.appendLog({ t: Date.now(), level: 'ok', msg: s.id + ' ✓（跳转前已完成）' + (s.name || '') +
        '，断言 ' + ((s.assertResults || []).length) + ' 条' + (s.extract ? '，抽取: ' + Object.keys(s.extract).join(', ') : '') });
      UI.markStep(s.id, 'passed');
    });
  };

  UI.doRun = async function (opts) {
    opts = opts || {};
    // 续跑优先：落地页上 spec/参数从运行态恢复，不要求本页先粘贴 spec
    const st0 = RunState.get();
    const resuming = !!(st0 && st0.phase === 'await_nav_check');
    let spec, params;
    if (resuming) {
      try { spec = JSON.parse(st0.specJson); }
      catch (e) { alert('续跑状态损坏，已清除：' + e.message); RunState.clear(); return; }
      params = st0.params || {};
    } else {
      if (!UI.spec) { alert('请先加载 spec'); return; }
      spec = UI.spec;
      params = {};
      for (const p of spec.params || []) {
        const auto = UI.taskParamValue(p.name);
        if (auto) { params[p.name] = auto; continue; }
        const el = document.getElementById('masr-p-' + p.name);
        const v = el ? el.value.trim() : '';
        if (p.required && !v) { alert('必填参数: ' + (p.label || p.name)); return; }
        if (v) params[p.name] = v;
      }
      UI.saveParams(spec.spec_id, params); // 记住这次填的值，下次自动回填
      // 角色标记：发起页（通常为代理页）永不自毁，负责展示最终结果
      try { sessionStorage.setItem('masrRole', 'origin'); } catch (e) {}
    }
    UI.spec = spec;
    UI.setSpecBadge(spec);
    if (!opts.keepLog) document.getElementById('masr-log').innerHTML = '';
    UI.renderSteps(spec);
    if (resuming) {
      UI.appendLog({ t: Date.now(), level: 'info', msg: '=== 续跑模式：从运行态恢复（' + st0.navStepId + ' 之后）===' });
      UI.replayStepLogs(st0.stepLogs);
    } else {
      // 运行态初始化（供 navigate 续跑恢复用）
      RunState.set({
        phase: 'running', specId: spec.spec_id, specVersion: spec.version,
        specJson: JSON.stringify(spec), params, log: [], startedAt: Date.now(),
        runnerVersion: GV.RUNNER_VERSION,
        task: UI.currentTask || null,
      });
    }
    const hooks = { onLog: UI.appendLog, onStep: UI.markStep };
    try {
      let result;
      if (resuming) result = await resumeAfterNavigate(spec, params);
      else result = await runSpec(spec, params, hooks);
      UI.lastResult = result;
      if (result.navInitiated) {
        const tip = result.openedTab
          ? '=== ' + result.stepId + ' 已在新标签页打开。落地页会自动续跑（约 2.5 秒），若未自动续跑再切过去点「执行」 ==='
          : '=== ' + result.stepId + ' 导航已发起。落地页会自动续跑（约 2.5 秒），本页无需操作 ===';
        UI.appendLog({ t: Date.now(), level: 'warn', msg: tip });
        document.getElementById('masr-result').innerHTML = result.openedTab
          ? '<b style="color:#b8860b">⏳ 新标签页已打开</b>：落地后自动续跑，全部跑完辅助标签页会自动关闭、结果回到本页。'
          : '<b style="color:#b8860b">⏳ 等待导航落地</b>：落地后自动续跑；若 8 秒后未自动续跑，切到落地页点「执行」。';
      } else {
        UI.appendLog({ t: Date.now(), level: 'ok', msg: '=== 执行完成 ===' });
        renderOutputs(result.outputs || {});
        // 广播最终结果：辅助标签页自毁，发起页弹窗展示
        const role = (function(){ try { return sessionStorage.getItem('masrRole') || ''; } catch (e) { return ''; } })();
        const stc = RunState.get() || {};
        stc.phase = 'done';
        stc.final = { ok: true, outputs: result.outputs || {}, at: Date.now(), specId: spec.spec_id };
        RunState.set(stc);
        if (role !== 'origin') {
          UI.appendLog({ t: Date.now(), level: 'info', msg: '⏪ 本页为辅助标签页，2 秒后自动关闭；结果将回到发起页展示' });
          setTimeout(function () { try { window.close(); } catch (e) {} }, 2000);
        }
      }
      console.log('[MASR] result =', result); // 本地调试用，不入表格
    } catch (e) {
      const code = e.code || 'E_UNKNOWN';
      UI.appendLog({ t: Date.now(), level: 'fatal', msg: '=== 终止: [' + code + '] ' + e.message + ' ===' });
      UI.lastResult = { ok: false, error: code, message: e.message };
      // 失败也广播（发起页能看到）；但辅助页不自毁，保留现场供排查
      try {
        const role = sessionStorage.getItem('masrRole') || '';
        const stc = RunState.get() || {};
        if (stc.phase) {
          stc.phase = 'done';
          stc.final = { ok: false, error: code, message: e.message, at: Date.now() };
          if (role === 'origin') stc.final.consumed = true; // 本页直接展示过，不再重复
          RunState.set(stc);
        }
      } catch (e2) {}
    } finally {
      const st = RunState.get();
      if (st && st.phase === 'running') RunState.clear();
      UI.renderSelfCheck();
    }
  };

  function renderOutputs(outputs) {
    const rEl = document.getElementById('masr-result');
    rEl.innerHTML = '<b>outputs</b>（导出 JSON 可见完整值；下表已脱敏）<table>' +
      Object.keys(outputs || {}).map(k =>
        '<tr><td>' + k + '</td><td>' + ENGINE.maskValue(outputs[k]) + '</td></tr>').join('') + '</table>';
  }

  /* ==================== 启动 ==================== */

  function boot() {
    UI.mount();
    UI.renderTasks();
    UI.replayPersistedLogs(); // 跨页日志回放：任何页面加载都能看到之前全部输出
    // 自动恢复上次加载的 spec 与参数：刷新、跳转落地、新标签页都不用重新粘贴
    try {
      const lastSpec = GM_getValue(GV.LAST_SPEC_KEY, '');
      if (lastSpec) {
        UI.applySpec(lastSpec, { fromStore: true, persist: false });
        if (UI.spec) UI.restoreSpecText();
      }
    } catch (e) { /* 恢复失败不影响手动粘贴 */ }
    const st = RunState.get();
    if (st && st.phase === 'await_nav_check') {
      UI.replayStepLogs(st.stepLogs);
      // 自动续跑条件：①状态新鲜（10 分钟内）②当前页 URL 匹配本步 expect——避免在错误的标签页上误启动
      const fresh = Date.now() - (st.navAt || 0) < 10 * 60 * 1000;
      const urlOk = !st.navExpect || !st.navExpect.url_contains ||
                    location.href.indexOf(st.navExpect.url_contains) >= 0;
      if (fresh && urlOk) {
        try { sessionStorage.setItem('masrRole', 'helper'); } catch (e) {}
        UI.appendLog({ t: Date.now(), level: 'info', msg: '⏩ ' + st.navStepId + ' 落地校验已排队：2.5 秒后自动续跑（无需点击）' });
        setTimeout(function () { UI.doRun(); }, 2500);
      } else {
        UI.appendLog({ t: Date.now(), level: 'warn', msg: '检测到未完成的导航续跑（' + st.navStepId + '）：本页不匹配落地条件或状态过旧，点「执行」手动校验' });
      }
      console.log('[MASR] await_nav_check:', st.navStepId, 'expect=', st.navExpect, 'auto=', fresh && urlOk);
    }
    // 发起页轮询：接收其他标签页广播的最终结果；辅助页收到后自毁（兜底，主路径见 doRun）
    setInterval(function () {
      let s, role;
      try { s = RunState.get(); role = sessionStorage.getItem('masrRole') || ''; } catch (e) { return; }
      if (!s || !s.final || s.final.consumed) return;
      if (role === 'origin') {
        s.final.consumed = true; RunState.set(s);
        if (s.final.ok) {
          UI.appendLog({ t: Date.now(), level: 'ok', msg: '=== 流程完成（辅助标签页已自动关闭，结果已回到本页）===' });
          renderOutputs(s.final.outputs || {});
        } else {
          UI.appendLog({ t: Date.now(), level: 'fatal', msg: '=== 流程在某个后续页面终止: [' + (s.final.error || 'E_UNKNOWN') + '] ' + (s.final.message || '') + ' ===' });
        }
        // 回写飞书（只有带任务上下文时才写；服务端会再校验归属）
        if (!s.final.written) {
          s.final.written = true; RunState.set(s);
          pushTaskResult(s, s.final.ok, s.final.outputs, { code: s.final.error, message: s.final.message });
        }
        setTimeout(function () { RunState.clear(); }, 1500);
      } else if (role && Date.now() - s.final.at < 5 * 60 * 1000) {
        // 辅助页/中转页：结果已广播，安全关闭（仅对脚本打开的标签页有效）
        try { window.close(); } catch (e) {}
      }
    }, 1500);

    // 静默自检更新（6 小时一次）：不弹窗、不打断，发现新版只在悬浮球点一颗红点
    setTimeout(function () { UI.autoCheckUpdate(); }, 4000);
  }

  // 暴露引擎给测试与控制台（不影响页面）
  try { (unsafeWindow || window).__MASR_TEST__ = ENGINE; } catch (e) { window.__MASR_TEST__ = ENGINE; }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.__MASR_BOOT__ = boot;
})();
