// ==UserScript==
// @name         MAS-Runner (spec interpreter v0.1)
// @namespace    mas-runner
// @version      0.9.23
// @description  声明式 spec 解释器：读 spec.json → 按步骤执行 api/navigate 步骤 → 断言 → 抽取 → dry_run 报告。业务逻辑全部来自 spec（数据），本脚本不含任何业务。
// @author       MAS
// @homepageURL  https://github.com/liuzheng2014/mas-runner
// @supportURL   https://github.com/liuzheng2014/mas-runner/issues
// @updateURL    https://mas.wankahuanju.top/runner.user.js
// @downloadURL  https://mas.wankahuanju.top/runner.user.js
// @match        https://ads.huawei.com/*
// @match        https://*.ads.huawei.com/*
// 华为账号 CAS 登录域 / EAM 管理台域（P2 开户：业务页 302 到这里，脚本要跟过去才能续跑）。
// 不认领所有登录页：是否接管由 spec 的 cross_domain 白名单 + URL 里的 service/redirect_uri 判定。
// @match        https://id1.cloud.huawei.com/*
// @match        https://id.cloud.huawei.com/*
// @match        https://*.feishu.cn/*
// 中转页（业务表按钮打开、URL 带 tableId+recordId 的跳板页）。此域上不挂主面板，
// 只做「按表 ID 认领场景 → 按记录取数 → 把当前标签页替换成业务页」。
// @match        https://www.baidu.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_setClipboard
// @grant        unsafeWindow
// 关闭当前标签页：普通 JS 的 window.close() 会被浏览器拒绝，油猴只有显式申请该权限才允许
// （且仍不允许关闭窗口的最后一个标签页）。submit 成功后按 spec 声明自动关页靠它。
// @grant        window.close
// @connect      svc-drcn.ads.huawei.com
// @connect      raw.githubusercontent.com
// @connect      cdn.jsdelivr.net
// @connect      *
// @connect      self
// @run-at       document-start
// ==/UserScript==

/*
 * MAS-Runner — 范围与边界与变更史（务必与 specs/README.md 的 Runner 契约对照）
 *
 * 【版本号真值只有两处，改版本必须同时改，publish_runner.py 会硬校验一致】
 *   1) 头部 @version（油猴识别更新用）
 *   2) 代码里 GV.RUNNER_VERSION（GM_info 取不到时的兜底显示 + spec requires_runner 协商）
 * 文件名 runner-v0.1.user.js 是仓库里的固定快照名，不是版本号（测试脚本按此路径读），永不跟版本走。
 * @name 里的 "(spec interpreter v0.1)" 同理是早期固定文案：改它会让油猴把它当成另一个脚本、
 * 老用户收不到更新，所以保持原样不动。
 * 下面的 v0.1.7 ~ v0.1.16 是早期真实历史编号（当时版本确实是 0.1.x），保留原文。
 *
 * 已实现：
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
 *   - v0.4.13：直连模式整体移除（安全收口）——持口令者即能解出 app_secret，双轨只留攻击面。
 *     删除 ENC 凭证块/口令解锁/FL 直连飞书模块/dev「从飞书拉 spec」旁路，脚本内不再含任何凭证材料；
 *     面板第一步=填服务地址（→ 表单绑定 → 拉待办），app_secret 只在服务端（wrangler secret）。
 *
 *   - v0.4.7：多跳链条收摊修复（2026-10-30 用户实测：子客门户跳过去、密钥页关了，子客首页留着）。
 *     根因：关闭时机挂在 RunState.final.consumed 上，而发起页一收到结果就把 consumed 置 true 并清掉运行态，
 *     上游辅助页（第一个被打开的标签页）轮询到时提前 return，永远等不到关闭 → 只关了最后一页。
 *     改为独立的一次性「收摊信号」CloseSig（masr_close_v1，带 runId + 5 分钟时效），
 *     任何非发起页只要 runId 对得上就自毁；且"等落地"的中间页会把自己标记成 helper，
 *     跑完一起收摊。发起页（代理页）永不关闭。
 *
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
 *   - v0.4.3：①顶部改两行式——第一行「解释器版本 / 检查更新」，第二行「业务脚本 spec_id +
 *     版本 + 状态」，两种版本号从此分离（原来挤在一个 h3 里，v0.4.2 和 spec v0.8.0 混着看）；
 *     ②装完新版本自动重载——点「更新 vX」打开安装页 → 装完切回页面自动重载（最多一次，
 *     不打断正在跑的任务；重载后日志/参数/续跑状态都从 GM 存储恢复，不丢东西）；
 *     ③「锁定」改名「锁定凭证」并加说明（只清本机口令钥匙，不解绑、不影响已回写结果）；
 *     ④回写失败落本地待写队列，任务行出现「重试回写 (N)」，服务恢复后一键补写
 *
 *   - v0.4.4：回写抗抖动——①客户端遇超时/断连自动再试一次（1 秒后），仍失败才进本地待写队列；
 *     ②失败提示分清责任：`E_FS_TIMEOUT/E_FS_NET` 是「后端连飞书超时」而不是「本机服务没跑」
 *     （0.4.3 那句提示会误导人，用户实测踩到）；③service 侧同步给出站请求 7s 硬超时 + 重试一次
 *
 *   - v0.9.0：开户阶段二（管理式登录 / 导入成员）所需的 4 项能力，一次发版：
 *     ①跨域登录链路——新增 @match id1./id.cloud.huawei.com，SCENE.trigger 支持 cross_domain
 *       （hosts 白名单 + 用 service/redirect_uri 的目标主机名决定要不要接管，同一登录页会给很多站点用）；
 *       跨页任务恢复从「host 相等」改为「落点域在场景声明内」；recordId 经 302/hash 多层编码，
 *       新增 decodeParam 循环解码（最多 5 轮，解不动就返回原值，不猜）
 *     ②人工闸门 confirm_gate / gateWhen——整屏遮罩 + 必须点，**无超时自动通过**（自动通过＝假装人看过了）。
 *       when 支持 exists 与人数比较；判不出来一律 E_GATE 终止，绝不当「没命中」继续。
 *       终止码取 action.error（缺省 E_HUMAN_CONFIRM），带 human 标记：收尾横幅说「已按设计终止（需人工接手）」
 *       而不是「失败」，文案不含「重试」暗示——重跑一次往往就多建一个成员
 *     ③参数级脱敏——param.secret=true 的值在面板/日志/GM 存储/回写载荷全链路打码；凭据禁走 URL
 *       （scene.trigger.params_query 里出现 secret 参数 → 加载期 E_SPEC）
 *     ④两处会长期误导的缺陷顺手修：uiText 读 el.value（原来对 input 恒返回空串，assert_ui 形同虚设）；
 *       type 支持 skip_if_empty（可空字段原来只能填假值或整步失败）
 *   - v0.9.1：补漏——「已按页面记录取数」那行日志把 params 原样打印，参数级脱敏漏了这一处，
 *     等于密码照样进日志（0.9.0 的 golden trace 基线里就躺着明文）。secret 参数改走 maskValue。
 *   - v0.9.2：场景列表零命中时强刷一次。缓存 TTL 10 分钟，而「刚发布的新场景」必然不在
 *     旧缓存里；过去零命中被当成「这页没场景」直接挂面板，导致发布后第一次点业务按钮
 *     静默无反应（既不报错也不提示，只能干等缓存过期或手动清 GM 存储）。现在零命中且缓存
 *     超过 60s 就 force 拉一次（全局 60s 限流，避免每个无关页面都多打一次接口）；
 *     多场景歧义命中不在此列——那是「声明不足待人工」，刷了也一样歧义。
 *   - v0.9.3：跨域登录页真的能接手了（0.9.0 只做了一半）。
 *     ①recordId 深度提取：302 到 CAS 登录页后 recordId 不在顶层 query，而是被编进
 *       service/redirect_uri（实测 5 层编码）。原先只取顶层 → 取到空串 → 判「命中但无记录」→
 *       静默 return，人看到的就是「点完按钮跳登录页，插件没反应也没日志」。
 *       spec 声明 trigger.record_id_deep 才做这层提取（别的站点 service 里也可能有同名参数，不猜）。
 *     ②不再沉默：命中但取不到记录 / 多场景歧义 / 站在跨域落地域上零命中，三种情况都写日志，
 *       并附当前地址片段——「什么都没发生」是最难排查的故障。
 *     ③跨域安全阀收紧：service 与 redirect_uri 同时存在时只认第一个能解析出的落点
 *       （原先是「有一个匹配就接管」→ service 指向别人、redirect_uri 带我们地址时会误接管）。
 *     ④卡死的运行态会被指出来：页面被 302/关标签打断时 finally 跑不到，状态永远停在 running。
 *       现在带 15s 心跳，超过 2 分钟没更新就标记为 interrupted 并写一条日志（只标记不清理，
 *       别的标签页可能真在跑）。
 *     ⑤面板配色抗宿主覆盖：color-scheme:light + 显式文字色 + -webkit-text-fill-color 归位。
 *       宿主声明深色主题时 UA 会给 button/input 白字，而我们只设背景 → 白底白字看不见。
 *   - v0.9.4：跨域安全阀会沿跳转链往下看。
 *     真机实测（2026-11-06）：CAS 登录页的 service 指向统一登录网关
 *     `oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback`，真正的业务回跳目标压在他的
 *     `redirect_uri` 里（再一层编码）。0.9.3 只比较 service 第一层的 host → 永远不等于白名单
 *     → 登录页永远不被认领，表现仍是「点完按钮跳到登录页，插件没反应」。
 *     现在沿 service→redirect_uri 最多走 3 跳，链上任一 host 命中白名单才认领；
 *     链上没有任何本业务域（别人复用的登录页）照样不认领——不放大认领范围。
 *   - v0.9.5：主动退出登录不再被自己登回去。
 *     真机实测（2026-11-06）：在管理台点「退出」→ 落到 CAS 登录页 → 跨域场景照常认领 →
 *     自动登录 → 8 秒后又回到原组织。人的退出被引擎撤销，等于**退不掉**；换账号时就卡死。
 *     退出是人的动作，spec 无从得知，只能由引擎旁听：捕获阶段识别菜单项「退出/退出登录/登出/注销」
 *     → 记一笔（时间 + 当时的 recordId + 站点主域）。下一次登录页认领时抑制一次（消费即作废）。
 *     抑制范围刻意收窄：换一条记录、换站点、超过 3 分钟、spec 写 suppress_after_logout_ms:0
 *     都不抑制——不能因为一次退出把人挡在外面。抑制时会写日志说明，不是静默跳过。
 *   - v0.9.8：满员闸门不再拿「零占位」下判断（2026-11-06 真机误报）。
 *     现象：组织 140/200 没满，导入管理式成员却在 S1 弹出「这个组织已经满员」，日志写
 *     「左=0 >= 右=0 → 命中」。
 *     根因在业务页而不在 spec：EAM 管理台 home 页把两个数字都过了一遍 `zeroFilter = t || 0`
 *     （home-legacy.js），点进组织那一瞬间数据还没回来，DOM literally 是「成员人数0」和
 *     「成员人数上限0」。而 0 >= 0 恒真 → 任何组织都被判成满员。
 *     两处收口：①gateWhen 里带 ref_xpath 的比对，右值（上限）<= 0 一律当「数据未就绪」返回可重试
 *     错误，绝不用它做比较；②confirm_gate 判定前先轮询等回填（when.ready_ms，缺省 3000），
 *     等不到才按「判不出来」E_GATE 终止。日志会写清「等待回填 → 已就绪」或「等待超时」，
 *     不静默。
 *   - v0.9.9：修「交接跳走后，残留续跑状态把下一个场景劫持」+ 回写可靠性（2026-11-06 真机）。
 *     现象：P2 建完成员 → 退出 → 同标签进邀请页 → P3 刚起来就重放了 P2 的 S1~S6，
 *     在注册页上拿 S6 的 expect（等 loginAuth.html）去校验，报「退出没点上」E_UI 终止，
 *     并把表回写成「失败」；日志里还同时出现「回写失败」和「✅ 已回写飞书：失败」。
 *     根因三条：①same-tab 交接只 RunState.clear()，紧接着自己那条 log() 又把闭包里的旧状态
 *     原样写回（phase 仍是 await_nav_check），新页面读到它就当「还要续跑」；
 *     ②续跑判定只看 phase，不看本页是不是这一步的落点，于是 P3 拿着 P2 的 specJson 跑；
 *     ③resumeAfterNavigate 同样 clear 之后继续 log()，继续复活。
 *     收口：RunState 加 freeze/thaw（冻结后一切 set 无效），交接时冻结再清；续跑前用本步的
 *     expect.url_contains 校验落点，对不上就清掉并按本页场景正常执行；落地成功改成
 *     phase='running'（不再 clear），保住 task/runId 供收尾回写。
 *     回写侧：飞书 1254607「Data not ready」按瞬时错误重试两次（S5 就是被它拖成「表里没写」）；
 *     待写队列里已有同记录的 ok 时，后续 fail 不覆盖（否则业务看到失败会重跑、多建一个成员）；
 *     队列按 record_id 去重；启动提示带上记录与上报状态并去重；「✅ 已回写飞书：失败」改成
 *     「✅ 已回写飞书（请求成功，上报状态=失败 E_UI）」，不再让人误读成回写失败。
 *   - v0.9.10：回写要核对「字段」，不能只看请求成功（2026-11-06 真机）。
 *     现象：表里「开户状态」写成了「管理式导入完成」，「邮箱账号」一直是空的。用户问是不是没存。
 *     真相：值算出来了、也发出去了，坏在 spec 的回写模板写成 `{{account_email}}`（少了 outputs.
 *     前缀）——服务端模板上下文只有 {outputs, error, elapsed_ms, record_id, runner_version,
 *     spec_version}，业务值全在 outputs 下面。取不到 → renderTpl 返回 undefined → 服务端按
 *     「解析为空则不写」**跳过该字段，还照样返回 200**。所以日志显示成功、表里少一列。
 *     收口：回写成功后拿服务端返回的 written（实际写进表的字段名）跟 spec.scene.writeback
 *     声明对一遍，少了就点名 warn「这几个字段没写：…」；待写队列带上 _expect_fields，
 *     补写成功同样核对。配套：validate_spec 硬校验模板占位符根必须在服务端作用域内
 *     （裸写 {{x}} 直接拒绝发布），新增 writeback-template-smoke。
 *   - v0.9.11：把「时间去哪了」写进日志，别再让人对着静默段猜（2026-11-06 真机日志复盘）。
 *     现象：一段流程里出现 27s、49s 的空白，面板上两条日志之间什么都没有。三种完全不同的原因
 *     在日志上长得一模一样：①网络往返慢；②业务页把主线程占满（我们的定时器/XHR 回调全部排队）；
 *     ③标签页被切到后台（浏览器直接冻结后台标签的 JS）。人只能猜，猜错方向就白改一通。
 *     收口：执行期起一个「节奏探针」——1s 一跳，跳空了 >2.5s 就报「页面卡了 N s，脚本一行没跑」；
 *     监听 visibilitychange，切走再回来报「在后台待了 N s」。同时给三段关键串行往返单独计时：
 *     /task 取数、/health 预检、续跑补凭据（都只在 >800ms 时打一行，不刷屏）。
 *     /health 预检超时 8s→4s：链路正常时它是亚秒级，8s 只会把「卡住的标签页」拖成更长的静默。
 *     预热定时器改成可停：runTask 收尾 clear，不再跑完流程后还每 6s 打一次（实测一次运行会
 *     多打十几枪 /health?warm=1，白占连接）。
 *
 *   - v0.9.12：「检查更新」不能只看第一个源（2026-11-06 真机：点了更新还是旧版）。
 *   - v0.9.14：新增 upload 原语（3B 开户信息页的执照/身份证正反/行业资质上传用）。
 *      脚本不能改 input.value，但 new File + new DataTransfer 赋 input.files 再派发 change 是通的
 *      —— 2026-11-06 真机实测：Element Plus 的 el-upload 接收后立刻发出
 *      POST /usermgtportal/v1/upload_private（证据 evidence/p3b-upload-feasibility-20261106.md）。
 *      ⚠ 派发 change 之后组件会把 input 清空，**判据必须看上传列表/缩略图，不能看 input.files**
 *      （派发后立刻读是 0，那是「事件被接收」的正面信号）。只给 xpath 不给 expect_xpath 时
 *      只记一条 warn：那只证明「事件发得出去」，不证明「传上去了」。
 *   - v0.9.13：①单次取数（read-once）：trigger.params_from_pend + 交接上下文优先于表 + TTL 10→60 分钟续期
 *              ②S5 回写改异步（先入本机队列、后台补写），不再堵 40~50s（2026-11-06 真机 48.9s）。
 *     现象：面板点「检查更新」，显示「已是最新 v0.9.10」，可 jsDelivr 上早有 0.9.11。
 *     根因是旧实现「见第一个 200 就 return」——而排第一的自建源 mas.wankahuanju.top/runner.json
 *     背后是 KV 里的 commit，KV 没刷新时它**照样 200，只是内容是旧版本**，于是当场判定「无新版」，
 *     后面两个源连问都没问。等于更新检查自己骗自己。
 *     收口：①并发问所有源，取版本最大者；②安装地址用「胜出那条源自己的地址」，
 *     自建源落后时自动改走 jsDelivr 直链（否则点更新还是被送回旧版，用户无法自救）；
 *     ③有源报的版本比当前还旧时点名告警——那说明分发链坏了，不是「已是最新」。
 *     判据：**多源聚合必须按值取最优，不能按顺序取第一个成功的**；"拿到回答"≠"拿到正确答案"。
 *   - v0.9.18：两件开户链路上的硬需求（2026-11-09 真机复盘）。
 *     ①**pick_date 原语**：华为开户「授权有效期」是 el-date-editor--daterange（受控组件）。
 *       type 只改到 DOM 的 input.value，组件模型不变——真机症状是「值看着在、点提交被
 *       『请选择授权有效期』拦下」。要自动化只能点面板，而面板**没有年份视图**，跨十年的结束
 *       日期要点 10 次「后一年」，点击次数取决于记录里的年份差，写不进 spec。所以把
 *       「按目标年月翻页 + 点日 + 回读校验」放进引擎，spec 只声明 xpath/from/to。
 *       判据两条：起点格出现 td.start-date 标记；两个 .el-range-input 的显示值归一后与目标一致。
 *       **不看 el-range__close-icon**（它受 hover/展开影响，空模型时也可能显示，反过来当判据会
 *       把「没写进去」判成「写进去了」）。
 *     ②**when 支持按参数分支**（action 级 when + gateWhen.param）。现场：同一个账号「改没改过
 *       密码」决定用初始密码还是正式密码登录，而这一点在登录页上**看不出来**（只能从业务表
 *       「密码修改结果」知道）。以前只能把所有相关动作写成 optional，结果是「本来就没有弹层」
 *       和「选择器写错了」长得一模一样（都静默跳过），两种前态还得写两份重复步骤。
 *       现在：{"param":"pwd_change_result","equals":"修改成功"} —— 不命中就跳过**这一个动作**
 *       并留日志（写明实际值与条件），其余照跑。参数没取到按空串算（表里该列本来就常为空，
 *       是正常前态，不是配置错误），但拼错的参数名由校验器拦下（永远不命中 = 静默跳过）。
 *   - v0.9.19：**spec 缓存版本校验提前到开跑前**（2026-11-09 真机事故）。
 *     现场：本地缓存里是 open-account-login 0.2.0、线上已 0.4.0，服务端 /scenes、/spec 都正常，
 *     但引擎「缓存优先」的语义是「本次仍按缓存版执行，下次自动生效」→ 于是照旧跑了 0.2.0：
 *     验证码处**按旧版设计硬终止**（新版是人工确认后继续）、日期用 type 写 DOM（假绿）、
 *     表里新增的「密码修改结果 / 客仓ID」全都没参与。人的感受是「说好的自动接管没接管」。
 *     缓存是为了省那 14s 的 /spec，但不能拿「跑错版本」当代价。修法不新增网络：
 *     服务端 /task 回包带上 `spec_version`（0.6.10），引擎拿它跟缓存版本比，
 *     **不一致就当场重取 /spec 并按新版跑**（只在版本真的变了时多一次请求）；
 *     老服务没有该字段 → 行为不变（仍缓存优先 + 后台提示）。
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

  // ---------- UI 填充原语（v0.6.2：Automa 式「引擎填表单、人点提交」） ----------
  // 引擎只认三个动作：click（点元素）/ type（设输入框值并派发 input+change，兼容 Vue/ElementUI）/
  // wait（等待）。定位一律 XPath；选择器与取值属于业务知识，全部由 spec 步骤的 ui.actions 声明，
  // 引擎不内置任何业务页面知识。{{param}} 占位符按 scope 解析，解析为空即报错（禁止静默填空值）。
  ENGINE.uiFindByXPath = function (xp) {
    if (typeof document === 'undefined') throw new Error('E_ENV ui 步骤需要 DOM 环境');
    const r = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    return r.singleNodeValue;
  };
  /* Runner 自己的界面（面板 / 悬浮球 / 人工弹窗 / 日志区）绝不能被当成业务页面。
   * 2026-11-09 事故：3A 的等待条件 `//*[contains(normalize-space(.),'录入企业信息与行业信息')]`
   * 命中的是面板里的 #masr-spec-text（spec.json 原文预览）——spec 自己写着这串字，面板又把它
   * 渲染出来，条件于是**永远为真**：验证码还没输就「检测到开户流程页」，落点断言永远通过。
   * 这种假绿比报错危险得多：流程看着跑通了，实际一步没做成，还会把后续动作带错页面。 */
  ENGINE.uiIsRunnerUI = function (el) {
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (String(cur.id || '').indexOf('masr-') === 0) return true;
      cur = cur.parentElement;
    }
    return false;
  };
  /* 「文本包含」类判定专用的查找：按文档顺序取第一个**业务**元素。
   * 与 uiFindByXPath 的区别只有两点，但都是必须的：
   *   ① 跳过 #masr-* 子树（面板里有 spec 原文、日志、步骤名，全是业务文案的复印件）；
   *   ② 跳过 body/html —— 它们的 textContent 必然包含面板，contains 一样会中。
   * click/type 不用它（目标都是具体控件，面板里不存在同名元素，用快的那条路径即可）。 */
  ENGINE.uiFindBusinessByXPath = function (xp) {
    if (typeof document === 'undefined') throw new Error('E_ENV ui 步骤需要 DOM 环境');
    const r = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    for (let i = 0; i < r.snapshotLength; i++) {
      const n = r.snapshotItem(i);
      if (!n || n.nodeType !== 1) continue;
      const tag = String(n.tagName || '').toUpperCase();
      if (tag === 'BODY' || tag === 'HTML') continue;
      if (ENGINE.uiIsRunnerUI(n)) continue;
      return n;
    }
    return null;
  };
  /* 把字节塞进 input[type=file]（0.9.14，3B 开户信息页的上传位用）。
   * 脚本不能改 input.value，但 new File + new DataTransfer 赋给 input.files 再派发 change 是通的
   * —— 2026-11-06 真机实测 Element Plus 的 el-upload 会接收并立刻发出
   * POST /usermgtportal/v1/upload_private（evidence/p3b-upload-feasibility-20261106.md）。
   * ⚠ 派发 change 之后组件通常会把 input 清空，**调用方不要在 dispatch 之后拿 files.length 判成败**，
   * 那是「事件被接收」的正面信号。 */
  ENGINE.uiPutFile = function (inp, bytes, filename, mime) {
    if (!inp) throw new Error('E_UI 没有可写入的文件输入框');
    if (String(inp.tagName || '').toUpperCase() !== 'INPUT' || String(inp.type || '').toLowerCase() !== 'file') {
      throw new Error('E_SPEC 目标必须是 input[type=file]，实际命中 ' + inp.tagName + '[type=' + inp.type + ']');
    }
    if (typeof DataTransfer === 'undefined' || typeof File === 'undefined') {
      throw new Error('E_ENV 当前环境不支持 DataTransfer/File，无法构造文件列表');
    }
    const file = new File([bytes], filename || 'upload.bin', { type: mime || 'application/octet-stream' });
    const dt = new DataTransfer();
    dt.items.add(file);
    inp.files = dt.files;
    const assigned = inp.files ? inp.files.length : 0;
    if (!assigned) throw new Error('E_UI 赋值后 input.files 仍为空——浏览器没有接受这次赋值（不是上传失败）');
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return { assigned: assigned, size: bytes.length, filename: file.name, mime: file.type };
  };
  /* 从一次性地址取文件字节（0.9.15，方案 D）。
   * 为什么必须走 GM_xhr 而不是页面 fetch：业务页 CSP 的 connect-src 会拦外域——
   * 2026-11-06 实测 ads.huawei.com 把自家 Worker 的请求整条拒掉（同一个 URL 在 example.com
   * 返回 200，证明是页面 CSP 而不是服务端）。GM_xhr 走扩展上下文，不受页面 CSP 约束，
   * 且 @connect * 已在头部声明。
   * 不用 .js 中转形态：那要求服务端把整个文件 base64 一遍，免费 Workers 的 10ms CPU 撑不住。 */
  ENGINE.uiFetchBytes = function (url) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('E_ENV 当前环境没有 GM_xmlhttpRequest，无法从 URL 取文件字节（不能退回页面 fetch：会被页面 CSP 拦）'));
        return;
      }
      let done = false;
      const fail = function (msg) { if (!done) { done = true; reject(new Error(msg)); } };
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: 'arraybuffer',
        timeout: 60000,
        onload: function (r) {
          if (done) return;
          if (r.status === 410) {
            fail('E_UI_FILE_SRC 地址已过期（410）：' + url + '；重新取一次数（/task）会签发新地址');
            return;
          }
          if (r.status === 404) {
            fail('E_UI_FILE_SRC 地址不存在（404）：' + url + '；可能是 KV 已被清理，重跑一次取数');
            return;
          }
          if (r.status !== 200) {
            fail('E_UI_FILE_SRC 取文件失败 HTTP ' + r.status + '：' + url);
            return;
          }
          const ab = r.response;
          if (!ab || typeof ab.byteLength !== 'number') {
            fail('E_UI_FILE_SRC 没拿到二进制响应（responseType=arraybuffer 未生效？）：' + url);
            return;
          }
          done = true;
          resolve(ab);
        },
        onerror: function () { fail('E_UI_FILE_SRC 网络错误：' + url); },
        ontimeout: function () { fail('E_UI_FILE_SRC 取文件超时（60s）：' + url); },
      });
    });
  };
  /* 等元素出现：命中即刻返回（正常路径零额外耗时），未命中每 100ms 重试至超时。
   * 为什么必须等（2026-11-06 事故）：业务页是 SPA，URL 触发时 document-idle 只代表
   * 文档就绪，表单还要等若干 XHR 回来才渲染。此前 spec 取数要走 14 秒网络，恰好把这段
   * 渲染时间「等」掉了；0.8.1 加了本地缓存后取 spec 只要 4ms，第一个动作立刻抢在渲染前
   * 查找，于是必报 E_UI_TARGET。查找一次就报错是把「页面还没画出来」误判成「页面改版」。 */
  ENGINE.uiWaitByXPath = async function (xp, timeoutMs, sleep, stepMs) {
    const limit = Math.max(0, Number(timeoutMs) || 0);
    let el = ENGINE.uiFindByXPath(xp);
    if (el || !limit) return el;
    const t0 = Date.now();
    const tick = Math.max(20, Number(stepMs) || 100);
    while (!el && Date.now() - t0 < limit) {
      await sleep(tick);
      el = ENGINE.uiFindByXPath(xp);
    }
    return el;
  };
  ENGINE.uiSetValue = function (el, val) {
    const proto = (typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement)
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, val); else el.value = val; // 用原生 setter 绕过 Vue 重写的 value
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  /* 元素是否可见：下拉「收起」是 display:none（节点还在），所以不能只看节点是否存在。
   * 不用 offsetParent —— jsdom 里恒为 null，测试无法模拟可见状态。 */
  ENGINE.uiIsVisible = function (el) {
    if (!el) return false;
    const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const win = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
    if (!win || !win.getComputedStyle) return true;
    if (el.hidden) return false;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const st = win.getComputedStyle(cur);
      if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
      cur = cur.parentElement;
    }
    return true;
  };
  /* 等元素到达某状态：want='visible' 出现即可见；want='hidden' 消失或不可见。
   * 返回是否达成（false = 超时）。元素「不存在」按 hidden 计。 */
  ENGINE.uiWaitState = async function (xp, want, timeoutMs, sleep, tickMs) {
    const t0 = Date.now();
    const limit = Math.max(0, Number(timeoutMs) || 0);
    const tick = Math.max(20, Number(tickMs) || 80);
    for (;;) {
      const vis = ENGINE.uiIsVisible(ENGINE.uiFindByXPath(xp));
      if (want === 'hidden' ? !vis : vis) return true;
      if (Date.now() - t0 >= limit) return false;
      await sleep(tick);
    }
  };
  /* 读元素文本（空白折叠）。注意：Element Plus 的 el-select 选中值体现在容器 innerText 上，
   * input.value 是空的 —— 判「有没有选中」只能读文本，不能读 value（2026-11-05 实测）。 */
  ENGINE.uiText = function (el) {
    if (!el) return '';
    /* 表单控件要读 value：input/textarea 的 innerText 永远是空串，
     * 不特判的话 assert_ui 对输入框永远「实际空」——那会逼人放弃提交前校验，
     * 退回到只看浮层显隐的假成功（2026-11-05 的事故路径）。 */
    try {
      const tag = String(el.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA') return String(el.value == null ? '' : el.value).trim();
    } catch (e) { /* 非元素节点，走下面的文本路径 */ }
    const t = (typeof el.innerText === 'string' && el.innerText) ? el.innerText : (el.textContent || '');
    return String(t).replace(/\s+/g, ' ').trim();
  };
  /* 结果断言：某 XPath 的文本是否包含期望值。返回 {ok, actual, found}。
   *
   * 为什么必须要它（2026-11-05 线上事故）：until="hidden" 校验的是「下拉浮层收起」，
   * 这与「值真的写进表单」是两件事。一级行业选中后二级列表会重建，点击若落在重建窗口内，
   * click 打到即将废弃的节点：不抛错、浮层照样收起、until=hidden 立即通过，但值没进表单，
   * 一直拖到提交时才被 el-form 校验暴露成「二级行业不能为空」。
   * 结论：动作是否生效必须校验【结果】（字段显示值），不能校验【副作用】（浮层显隐）。
   */
  ENGINE.uiExpectText = function (xp, want) {
    const el = ENGINE.uiFindBusinessByXPath(xp);
    const actual = ENGINE.uiText(el);
    const w = String(want == null ? '' : want);
    return { ok: !!el && actual.indexOf(w) >= 0, actual: actual, found: !!el };
  };
  /* 列出「正处于校验失败状态」的表单项红字文本。
   * 为什么要连 is-error 一起看：只按红字节点是否存在判断不可靠——Element Plus 校验转 success 后，
   * 红字节点与 is-error 类可能残留一小段时间（2026-11-05 实测：字段已选中、is-success，
   * DOM 里仍留着「二级行业不能为空」的旧节点）。
   * 用途：提交前拍快照，提交后只把「新增」的红字算作本次失败（陈旧的与本次提交无关）。 */
  ENGINE.uiFormErrors = function () {
    const out = [];
    try {
      const doc = (typeof document !== 'undefined') ? document : null;
      if (!doc) return out;
      const it = doc.evaluate(
        '//*[contains(concat(" ",normalize-space(@class)," ")," el-form-item ")][contains(concat(" ",normalize-space(@class)," ")," is-error ")]',
        doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < it.snapshotLength; i++) {
        const fi = it.snapshotItem(i);
        const e = fi.querySelector('.el-form-item__error');
        if (!e || !ENGINE.uiIsVisible(e)) continue;
        out.push(ENGINE.uiText(e).slice(0, 120));
      }
    } catch (e) { /* 读不到就当没有，绝不因取证失败而误判提交结果 */ }
    return out;
  };
  /* 语义化版本比较（逐段按数字比：0.8.10 > 0.8.9，按字符串比会错）。
   * 为什么需要：spec 可能用到新版 Runner 才有的原语（如 submit/close_tab）。老 Runner 会一路跑到
   * 那一步才抛「E_SPEC 未知 ui 动作」，用户看不出是版本问题，还以为是页面改版。
   * 在 spec 加载时就拦，一句话说清「要升级」。 */
  ENGINE.versionCompare = function (a, b) {
    const pa = String(a || '0').split('.').map(function (x) { return parseInt(x, 10) || 0; });
    const pb = String(b || '0').split('.').map(function (x) { return parseInt(x, 10) || 0; });
    for (let i = 0; i < 3; i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  };
  /* 检查 spec.runtime.requires_runner（只认 ">=0.8.7" 这类简单约束；写不明白就当没写，不误伤）。 */
  ENGINE.checkRequiresRunner = function (needSpec, running) {
    const need = String(needSpec == null ? '' : needSpec).trim();
    if (!need) return { ok: true, checked: false };
    const m = need.match(/^(>=|>|<=|<|=)?\s*([\d]+(?:\.[\d]+){0,2})$/);
    if (!m) return { ok: true, checked: false, warn: 'requires_runner 写法无法解析: ' + need };
    const op = m[1] || '>=';
    const c = ENGINE.versionCompare(running, m[2]);
    const ok = op === '>=' ? c >= 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : op === '<' ? c < 0 : c === 0;
    return { ok: ok, checked: true, need: need, running: String(running) };
  };
  /* 提交结果判定（只读页面，不发请求）。返回 {state, signal, text}：
   *   ok=确认成功；fail=确认失败；invalid=表单校验没过（请求根本没发出）；
   *   pending=还没有结果/只有无法归类提示；unknown 型提示会把文本带回，供人工判断。
   * 判据优先级：spec 显式 success/fail XPath（有真实证据时最准）→ Element UI 消息组件约定。
   * 为什么必须区分 invalid：校验没过和提交失败是两件事，前者要改数据、后者要改网络/重试，
   * 混成一条「提交失败」会让人往错的方向查。
   * 为什么判不出来绝不当成功：写操作误判成功的代价（以为发出去了实际没有）远大于多等十几秒。 */
  /* 提交结果判定（只读页面，不发请求）。返回 {state, signal, text}。
   * opts: {success, fail, stale:[点击前已存在的红字], t0:点击时刻, grace_ms}
   *
   * 判定顺序的用意：明确的成功/失败信号 > 表单校验红字。
   * 红字排最后是因为它是「间接信号」——它只说明有字段处于校验失败状态，
   * 说明不了「本次点击发出的请求失败了」。实测（2026-11-05）：
   * 表单值其实填对了、用户手动点提交一次成功，但页面上残留 is-error 红字，
   * 按「有红字=失败」判会把成功报成「校验没过、提交没发出」，后果是用户重复提交。 */
  ENGINE.uiDetectSubmitResult = function (opts) {
    opts = opts || {};
    const seen = function (xp) {
      const el = ENGINE.uiFindByXPath(xp);
      return (el && ENGINE.uiIsVisible(el)) ? el : null;
    };
    const txt = function (el) {
      return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    };
    if (opts.success) { const el = seen(String(opts.success)); if (el) return { state: 'ok', signal: 'success_xpath', text: txt(el) }; }
    if (opts.fail) { const el = seen(String(opts.fail)); if (el) return { state: 'fail', signal: 'fail_xpath', text: txt(el) }; }
    const okM = seen('//*[contains(@class,"el-message--success") or (contains(@class,"el-notification") and .//*[contains(@class,"el-icon-success")])]');
    if (okM) return { state: 'ok', signal: 'el_message_success', text: txt(okM) };
    const errM = seen('//*[contains(@class,"el-message--error") or (contains(@class,"el-notification") and .//*[contains(@class,"el-icon-error")])]');
    if (errM) return { state: 'fail', signal: 'el_message_error', text: txt(errM) };

    /* 表单校验红字：只在「点击前没有、点击后出现」时才算本次失败。
     * 点击前就有的（stale）属于上一次校验的残留，与本次提交无关，永远忽略——
     * 真失败会有别的信号（失败提示 / 超时未确认）暴露，漏判的代价小于误判「没发出」。 */
    const stale = Array.isArray(opts.stale) ? opts.stale : [];
    let fresh = [];
    try {
      const all = ENGINE.uiFormErrors();
      for (let i = 0; i < all.length; i++) {
        if (stale.indexOf(all[i]) < 0) fresh.push(all[i]);
      }
    } catch (e) { fresh = []; }
    if (fresh.length) {
      /* grace：「点击后立刻出现红字」有两种可能——真的校验没过，或 Vue 还没把旧的
       * 校验状态刷新完。等一小会再判定，能区分这两者（校验失败的提示不会自己消失）。 */
      const grace = Number(opts.grace_ms) || 0;
      if (grace > 0 && opts.t0 && (Date.now() - Number(opts.t0)) < grace) {
        return { state: 'pending', signal: 'form_validate_grace', text: fresh[0] };
      }
      return { state: 'invalid', signal: 'form_validate', text: fresh[0] };
    }
    const anyM = seen('//*[contains(@class,"el-message") or contains(@class,"el-notification")]');
    if (anyM) return { state: 'pending', signal: 'el_message_other', text: txt(anyM) };
    return { state: 'pending', signal: '', text: '' };
  };
  /* 提交后新增的网络请求（只读 performance 缓冲，不拦截、不注入页面）。
   * 用途：本场景的提交接口此前未捕获，第一次真实提交就能把 URL 与状态码记进日志，
   * 之后要靠接口判成败就有证据了。t0Perf 必须是 performance.now() 的读数
   * （resource 条的 startTime 也是同一时基；用 Date.now() 会比错量级）。 */
  ENGINE.uiNewRequests = function (t0Perf) {
    try {
      if (typeof performance === 'undefined' || !performance.getEntriesByType) return [];
      const base = Number(t0Perf) || 0;
      return performance.getEntriesByType('resource').filter(function (e) {
        return Number(e.startTime) >= base && /xmlhttprequest|fetch|beacon/i.test(String(e.initiatorType || ''));
      }).map(function (e) {
        return { url: String(e.name).slice(0, 200), status: Number(e.responseStatus) || 0, ms: Math.round(Number(e.duration) || 0) };
      });
    } catch (e) { return []; }
  };
  /* 人工确认闸门：整屏遮罩 + 必须点一下才能继续。
   * 用途：某一步之后已经没有「自动可做」的事，但人必须知道（如组织已满 200 人、
   * 需要人完成短信验证码）。它**不**替人做决定，也不自动放行——点了才 resolve，
   * 没点就永远挂着（不设超时自动通过：那等于假装人看过了）。 */
  ENGINE.confirmGate = function (opts) {
    const o = opts || {};
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return new Promise(function (resolve) {
      try {
        const old = document.getElementById('masr-gate');
        if (old) old.parentNode.removeChild(old);
        const wrap = document.createElement('div');
        wrap.id = 'masr-gate';
        wrap.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;right:0;bottom:0;' +
          'background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;' +
          'font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif';
        wrap.innerHTML =
          '<div style="background:#fff;color:#1f2329;max-width:520px;border-radius:10px;padding:18px 20px;box-shadow:0 10px 40px rgba(0,0,0,.25)">' +
          '<div style="font-size:16px;font-weight:600;margin-bottom:8px">' + esc(o.title || '需要你确认') + '</div>' +
          '<div style="white-space:pre-wrap;color:#3d4757">' + esc(o.message || '') + '</div>' +
          '<div style="margin-top:16px;text-align:right">' +
          '<button id="masr-gate-ok" style="padding:6px 18px;border:0;border-radius:6px;background:#1664ff;color:#fff;font-size:14px;cursor:pointer">' +
          esc(o.button || '我知道了') + '</button></div></div>';
        document.body.appendChild(wrap);
        wrap.querySelector('#masr-gate-ok').addEventListener('click', function () {
          try { wrap.parentNode && wrap.parentNode.removeChild(wrap); } catch (e) {}
          resolve({ confirmed: true, at: Date.now() });
        });
      } catch (e) {
        // DOM 异常时不能静默放行（那就是「假装人确认过」），直接把错误抛给调用方
        resolve({ confirmed: false, error: e.message });
      }
    });
  };
  /* 闸门条件：判断「此刻该不该弹闸门」。
   * 业务上必须拦的三类情况，都不能靠人盯着：
   *   ① 元素出现即代表异常/需要人工（如 .hwid-authentication-root = 要短信验证码）
   *   ② 两个数字比大小（如「成员人数 139」vs「成员人数上限 200」，满了就不能再建）
   *   ③ 参数值等于/不等于某个值（0.9.18：同一份 spec 要覆盖两种业务前态，见下）
   * 引擎只做「取文本 → 正则提数 → 按运算符比较」/「取参数 → 逐字比较」，
   * 业务含义全部由 spec 声明（pattern/op/param+equals）。
   * 返回 {hit, detail} 或 {error}：**判不出来必须报错，不能当成「没命中」放过去**——
   * 判不出来还继续，等于在不知道是否满员的情况下建成员。 */
  ENGINE.gateWhen = function (when, scope) {
    const rp = (s) => ENGINE.resolvePlaceholders(String(s == null ? '' : s), scope || {});
    if (!when || typeof when !== 'object') return { hit: true, detail: '无条件闸门' };

    /* param（0.9.18）：按参数值分支。
     * 为什么需要：华为开户「密码改没改过」决定两件事——用初始密码还是正式密码登录、
     * 页面上还会不会弹「设置新密码」。这是**业务前态**，页面上看不出来（只能在登录之后才知道），
     * 所以必须按参数在动作执行前分支。以前没有这条，只能让每个动作都 optional，
     * 结果是「弹层不在」和「选择器写错」长得一模一样（都静默跳过），
     * 而且两种前态要写两份重复的步骤。
     *   {"param":"pwd_change_result","equals":"修改成功"}
     *   {"param":"pwd_change_result","not_equals":"修改成功"}
     * 参数不存在/为空 → 当前值按空串算（业务表该列本来就可能为空，这是正常前态，不是配置错误）；
     * 但 `when.param` 指向一个 spec 没声明过的名字时由校验器拦（拼错的名字永远不命中，
     * 会让「本该执行的分支」静默跳过，比报错危险得多）。 */
    if (when.param) {
      const name = String(when.param);
      const has = !!(scope && Object.prototype.hasOwnProperty.call(scope, name));
      const cur = has && scope[name] != null ? String(scope[name]) : '';
      const show = when.secret === true ? String(ENGINE.maskValue(cur)) : (cur.length > 40 ? cur.slice(0, 40) + '…' : cur);
      const label = when.name || ('参数 ' + name);
      const cands = [];
      if (when.equals !== undefined) cands.push({ op: '==', want: rp(String(when.equals)) });
      if (when.not_equals !== undefined) cands.push({ op: '!=', want: rp(String(when.not_equals)) });
      if (Array.isArray(when.in)) when.in.forEach((x) => cands.push({ op: 'in', want: rp(String(x)) }));
      if (!cands.length) return { error: 'when.param 必须配 equals / not_equals / in 之一（' + name + '）' };
      /* 多个条件 = 全部满足（and）。逐条算，命中与否都要落进 detail —— 排查时最需要的是
       * 「实际值是什么」，而不是一句「条件不满足」。 */
      let hit = true;
      const parts = [];
      for (const c of cands) {
        const ok = c.op === '==' ? (cur === c.want) : c.op === '!=' ? (cur !== c.want) : (cur === c.want);
        if (!ok) hit = false;
        parts.push(c.op + '「' + (when.secret === true ? String(ENGINE.maskValue(c.want)) : c.want) + '」→' + (ok ? '成立' : '不成立'));
      }
      return {
        hit: hit,
        detail: label + ' 实际' + (has ? '' : '（未取到，按空串算）') + '「' + show + '」；' + parts.join('，'),
        values: [cur],
      };
    }

    if (when.exists) {
      const xp = rp(when.exists);
      let el = null;
      try { el = ENGINE.uiFindBusinessByXPath(xp); } catch (e) { return { error: 'exists 选择器无效: ' + xp + '（' + e.message + '）' }; }
      /* 「找不到」和「找到了但被 display:none 藏住」是两件事：都算未命中，但日志必须说实话。
       * 把后者说成「不存在」，排查时会被引到「选择器写错了」的错误方向。 */
      const vis = !!el && ENGINE.uiIsVisible(el);
      return { hit: vis, detail: (when.name || '元素') + (!el ? ' 不存在' : (vis ? ' 存在' : ' 存在但不可见')) };
    }

    const op = String(when.op || '>=');
    const legal = ['>=', '>', '<=', '<', '==', '!='];
    if (legal.indexOf(op) < 0) return { error: 'op 非法: ' + op + '（只允许 ' + legal.join(' ') + '）' };
    const num = (xpRaw, patRaw, label) => {
      const xp = rp(xpRaw);
      let el = null;
      try { el = ENGINE.uiFindByXPath(xp); } catch (e) { return { error: label + ' 选择器无效: ' + xp + '（' + e.message + '）' }; }
      if (!el) return { error: label + ' 元素未找到: ' + xp, retryable: true };
      const txt = ENGINE.uiText(el);
      const pat = patRaw ? rp(patRaw) : '(\\d+)';
      let m = null;
      try { m = new RegExp(pat).exec(txt); } catch (e) { return { error: label + ' 正则非法: ' + pat }; }
      if (!m) return { error: label + ' 文本里取不到数字（pattern=' + pat + '，实际「' + String(txt).slice(0, 60) + '」）', retryable: true };
      const v = Number(m[1] === undefined ? m[0] : m[1]);
      if (!isFinite(v)) return { error: label + ' 取到的不是数字: ' + (m[1] === undefined ? m[0] : m[1]), retryable: true };
      return { value: v, text: txt };
    };
    const left = num(when.xpath, when.pattern, '左值');
    if (left.error) return left;
    const right = num(when.ref_xpath, when.ref_pattern, '右值');
    if (right.error) return right;
    /* 右值（上限）读到 0 = 页面数字还没回填，不是「上限真的是 0」。
     * 业务页把未就绪的数字渲染成 0（EAM 管理台 home-legacy.js: zeroFilter = t || 0），
     * 而 0 >= 0 恒真——2026-11-06 真机：140/200 的组织被判「已满员」并停了下来。
     * 标记 retryable，交给 confirm_gate 先等回填；等不到就按「判不出来」终止，
     * 绝不拿 0 参加比较。 */
    if (when.ref_xpath && !(right.value > 0)) {
      return { error: '右值（上限）读完是 0，页面数据还没回填（0 比大小的结果不可信）', retryable: true, values: [left.value, right.value] };
    }
    const a = left.value, b = right.value;
    const hit = ENGINE.cmpNum(a, op, b);
    return {
      hit: hit,
      detail: '左=' + a + ' ' + op + ' 右=' + b + ' → ' + (hit ? '命中（需要人工）' : '未命中（可继续）'),
      values: [a, b],
    };
  };
  /* ==================== 日期区间选择（0.9.18）====================
   * 为什么必须有这个原语：Element Plus 的 el-date-editor--daterange 是**受控组件**，
   * type 只改到 DOM 的 input.value，改不到组件内部模型（2026-11-09 真机：填完值、提交时
   * 仍被「请选择授权有效期」拦下）。而面板没有年份视图，跨十年的结束日期要点 10 次
   * 「后一年」——点击次数取决于记录里的年份差，写不进 spec。所以把「按目标日期翻月 + 点日」
   * 这段算法放进引擎，spec 只声明 xpath + from/to。
   *
   * 取到的页面事实（2026-11-09，真实 Element Plus 2.x）：
   *   · 打开面板：对 .el-date-editor 派发 mousedown（click 不够）
   *   · 面板：.el-date-range-picker 内两个 .el-date-range-picker__content.is-left / .is-right
   *   · 表头：两枚 .el-date-range-picker__header-label，依次是「年」「月」
   *   · 翻页按钮：左框 d-arrow-left（前一年）/ arrow-left（前一月），
   *              右框 d-arrow-right（后一年）/ arrow-right（后一月）；**按 class 找，不按
   *              aria-label**——label 会随站点语言变（中文站点是「后一年」）
   *   · 日期格：td.available + span.el-date-table-cell__text，跨月格带 prev-month/next-month
   *   · 选中起点后有 td.start-date 标记；两个都选完 model 才落地
   * 判据（必须两条都过）：①起点格出现 start-date 标记；②两个 .el-range-input 的显示值
   * 归一成 年-月-日 后与目标一致。**不看 el-range__close-icon**：它是否显示取决于 hover/展开，
   * 空模型时也可能显示、有模型时也可能藏着，拿它当判据会得出反向结论（0.3.3 踩过）。 */
  ENGINE.parseYmd = function (raw) {
    const m = String(raw == null ? '' : raw).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    /* 「11 月」这种只有年份+月份+日 才算数；范围外的一律当解析失败，不猜。 */
    if (!(y >= 1900 && y <= 2199) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return { y: y, m: mo, d: d };
  };
  ENGINE.MONTH_NAME = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
    august: 8, september: 9, october: 10, november: 11, december: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  };
  /* 表头两枚 label → {y, m}。月份标签可能是数字（中文站点「11 月」）或月名（英文 locale），
   * 两种都认；都认不出来就报错指名原文，**绝不猜一个月**——猜错会静默点到别的日期。 */
  ENGINE.parsePanelHead = function (box) {
    if (!box) return { error: '面板里没有这一半（.el-date-range-picker__content）' };
    const labels = Array.prototype.slice.call(box.querySelectorAll('.el-date-range-picker__header-label'))
      .map(function (el) { return ENGINE.uiText(el); });
    if (labels.length < 2) return { error: '表头标签不足 2 枚（实际 ' + labels.length + ' 枚：' + labels.join('|') + '）' };
    const ym = String(labels[0]).match(/(\d{4})/);
    if (!ym) return { error: '表头里取不到年份：「' + labels[0] + '」' };
    const mRaw = String(labels[1]).trim();
    const mNum = mRaw.match(/(\d{1,2})/);
    let mo = mNum ? Number(mNum[1]) : (ENGINE.MONTH_NAME[mRaw.toLowerCase().replace(/[^a-z]/g, '')] || 0);
    if (!(mo >= 1 && mo <= 12)) {
      return { error: '表头里认不出月份：「' + mRaw + '」（只认数字月或英文月名，认不出不猜）' };
    }
    return { y: Number(ym[1]), m: mo };
  };
  /* 选一个日期区间。返回 {from, to}（实际落地的两个值）。
   * 全程只用「点」：翻月按钮 + 日期格，不写 input.value。 */
  ENGINE.pickDateRange = async function (o) {
    const doc = (o.doc || document);
    const sleep = o.sleep;
    const log = o.log || function () {};
    const from = ENGINE.parseYmd(o.from);
    const to = ENGINE.parseYmd(o.to);
    if (!from || !to) {
      throw new Error('E_SPEC pick_date 的 from/to 必须是可解析的日期（如 2026-11-09）：from=「'
        + o.from + '」 to=「' + o.to + '」');
    }
    const key = (d) => d.y * 10000 + d.m * 100 + d.d;
    if (key(from) > key(to)) {
      throw new Error('E_SPEC pick_date 的起点晚于终点（from=' + o.from + '，to=' + o.to
        + '）——业务表「开始日期/结束日期」两列多半填反了');
    }
    const ed = o.editor;
    if (!ed) throw new Error('E_UI_PICKDATE 日期控件未找到（xpath 解析为空）');

    const findPanel = function () {
      const all = Array.prototype.slice.call(doc.querySelectorAll('.el-date-range-picker'));
      const vis = all.filter(function (p) { return ENGINE.uiIsVisible(p); });
      if (vis.length > 1) log('警告：页面上有 ' + vis.length + ' 个可见的日期区间面板，取第一个（' + vis.length + ' 个说明同时开了多个选择器）');
      return vis[0] || null;
    };
    const open = async function () {
      let p = findPanel();
      if (p) return p;
      /* mousedown 是真实入口：click 不会展开（Element Plus 绑定在 onMousedown 上） */
      ed.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: doc.defaultView }));
      await sleep(350);
      p = findPanel();
      if (!p) {
        ed.click();
        await sleep(350);
        p = findPanel();
      }
      if (!p) {
        throw new Error('E_UI_PICKDATE 点开日期面板失败：派发 mousedown/click 后页面上没有可见的 .el-date-range-picker'
          + '（可能控件结构变了，或这个 xpath 指的不是 el-date-editor）');
      }
      return p;
    };
    const boxes = function (p) {
      return {
        left: p.querySelector('.el-date-range-picker__content.is-left'),
        right: p.querySelector('.el-date-range-picker__content.is-right'),
      };
    };
    const clickN = async function (p, dir, n) {
      const b = boxes(p);
      const box = dir === 'next' ? b.right : b.left;
      const cls = dir === 'next' ? 'd-arrow-right' : 'd-arrow-left';
      const btn = box && box.querySelector('button.' + cls);
      if (!btn) throw new Error('E_UI_PICKDATE 找不到翻年按钮 button.' + cls + '（面板结构变了）');
      for (let i = 0; i < n; i++) { btn.click(); await sleep(40); }
    };
    const clickM = async function (p, dir, n) {
      const b = boxes(p);
      const box = dir === 'next' ? b.right : b.left;
      const cls = dir === 'next' ? 'arrow-right' : 'arrow-left';
      const btn = box && box.querySelector('button.' + cls);
      if (!btn) throw new Error('E_UI_PICKDATE 找不到翻月按钮 button.' + cls + '（面板结构变了）');
      for (let i = 0; i < n; i++) { btn.click(); await sleep(40); }
    };
    /* 把左面板翻到目标月（右面板恒为左+1，翻任何一边都是整块平移） */
    const gotoMonth = async function (p, target) {
      for (let guard = 0; guard < 6; guard++) {
        const cur = ENGINE.parsePanelHead(boxes(p).left);
        if (cur.error) throw new Error('E_UI_PICKDATE ' + cur.error);
        const diff = (target.y * 12 + target.m) - (cur.y * 12 + cur.m);
        if (diff === 0) return;
        const years = diff > 0 ? Math.floor(diff / 12) : Math.ceil(diff / 12);
        if (years !== 0) { await clickN(p, years > 0 ? 'next' : 'prev', Math.abs(years)); await sleep(90); continue; }
        const months = diff;
        if (months !== 0) { await clickM(p, months > 0 ? 'next' : 'prev', Math.abs(months)); await sleep(90); continue; }
        throw new Error('E_UI_PICKDATE 翻月没有进展（目标 ' + target.y + '-' + target.m + '，当前 ' + cur.y + '-' + cur.m + '）');
      }
      const cur = ENGINE.parsePanelHead(boxes(p).left);
      throw new Error('E_UI_PICKDATE 连续 6 轮都没翻到目标月 ' + target.y + '-' + target.m
        + '（当前 ' + (cur.error || cur.y + '-' + cur.m) + '）——面板年份范围可能被 mindate/maxdate 限住');
    };
    /* 在面板里点目标那一天 */
    const clickDay = function (p, target) {
      const b = boxes(p);
      const tries = [b.left, b.right];
      for (let i = 0; i < tries.length; i++) {
        const box = tries[i];
        if (!box) continue;
        const ym = ENGINE.parsePanelHead(box);
        if (ym.error || ym.y !== target.y || ym.m !== target.m) continue;
        const tds = Array.prototype.slice.call(box.querySelectorAll('td')).filter(function (td) {
          const cell = td.querySelector('.el-date-table-cell__text') || td;
          if (String(ENGINE.uiText(cell)) !== String(target.d)) return false;
          const cls = ' ' + String(td.className || '') + ' ';
          if (cls.indexOf(' prev-month ') >= 0 || cls.indexOf(' next-month ') >= 0) return false;
          if (cls.indexOf(' disabled ') >= 0) return false;
          return cls.indexOf(' available ') >= 0;
        });
        if (tds.length !== 1) {
          throw new Error('E_UI_PICKDATE ' + target.y + '-' + target.m + '-' + target.d
            + ' 在「' + target.y + '-' + target.m + '」格子里命中 ' + tds.length
            + ' 个可选日期格（期望 1 个）——该日期可能被 mindate/maxdate 禁用（disabled 的格子不算可选）');
        }
        tds[0].click();
        return;
      }
      throw new Error('E_UI_PICKDATE 面板里没有「' + target.y + '-' + target.m + '」这一格（左右两半都没有）');
    };
    const readRange = function () {
      const ins = Array.prototype.slice.call(ed.querySelectorAll('.el-range-input'));
      return ins.length >= 2 ? [ins[0].value, ins[1].value] : null;
    };

    let p = await open();
    log('日期面板已打开（左 ' + (function () { const h = ENGINE.parsePanelHead(boxes(p).left); return h.error || (h.y + '-' + h.m); })() + '）');
    await gotoMonth(p, from);
    clickDay(p, from);
    await sleep(180);
    /* 起点标记：Element Plus 给起点格加 td.start-date。没有它说明那一下没落到格子上，
     * 后面的结束日期会被当成新的起点（区间变成「结束那天起」），必须当场发现。 */
    p = findPanel() || p;
    const startMark = Array.prototype.slice.call(p.querySelectorAll('td.start-date'))
      .map(function (td) { return ENGINE.uiText(td.querySelector('.el-date-table-cell__text') || td); });
    if (startMark.length !== 1 || String(startMark[0]) !== String(from.d)) {
      throw new Error('E_UI_PICKDATE 点了起点 ' + o.from + '，但面板里标记为起点的格子是 ['
        + startMark.join(',') + ']（期望 [' + from.d + ']）——起点没落上，不能继续点结束日期');
    }
    log('起点已选：' + o.from);
    await gotoMonth(p, to);
    clickDay(p, to);
    await sleep(250);

    const got = readRange();
    if (!got) throw new Error('E_UI_PICKDATE 控件里找不到 .el-range-input（结构变了）');
    const g0 = ENGINE.parseYmd(got[0]), g1 = ENGINE.parseYmd(got[1]);
    const same = function (a, b) { return a && b && a.y === b.y && a.m === b.m && a.d === b.d; };
    if (!same(g0, from) || !same(g1, to)) {
      throw new Error('E_UI_PICKDATE 选完回读不符：期望 ' + o.from + ' ~ ' + o.to
        + '，控件里是「' + got[0] + '」~「' + got[1] + '」——组件没接受（受控组件只认面板点击）');
    }
    log('区间已写入控件：' + got[0] + ' ~ ' + got[1]);
    /* 收起面板：Escape → 仍开着就点空白处（面板是绝对定位，挡着后面的按钮会点空）。
     * 收不起来只告警不失败：值已经落地，后面 submit 的红字才是真门。 */
    const esc = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true });
    const first = ed.querySelector('.el-range-input') || ed;
    try { first.dispatchEvent(esc); } catch (e) {}
    await sleep(200);
    if (findPanel()) {
      try { doc.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: doc.defaultView })); } catch (e) {}
      await sleep(200);
    }
    if (findPanel()) log('警告：日期面板没有收起（值已落地，不影响提交），如挡住后面的按钮请手动点一下空白处');
    return { from: got[0], to: got[1] };
  };
  ENGINE.execUiActions = async function (actions, scope, opts) {
    opts = opts || {};
    const gap = Number(opts.gap_ms) || 400;
    // 元素等待上限：页面渲染完就能点到，等不到才报错（0=不等待，退回旧行为）
    const readyMs = opts.ready_timeout_ms === undefined ? 10000 : Number(opts.ready_timeout_ms);
    const log = opts.log || function () {};
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    /* read 动作的产物：{变量名: 文本}。由 execUi 并入步骤抽取（{{S3.xxx}} 通道），
     * 用途：从页面上把「只有页面才知道」的值带回来（如新建成员的完整邮箱），
     * 再回写业务表。引擎不认识业务含义，只认 spec 声明的 xpath 与变量名。 */
    const readings = {};

    /* 单个动作。k 次重试的意义：下拉是联动的（选完一级，二级列表会重新请求重渲染），
     * 抢在重渲染前点下去会「点空」——节点在、点击也成功，但状态没变。
     * 所以 click 支持声明 until=hidden/visible：动作后校验是否真的生效，没生效就重做。 */
    async function runOne(a) {
      const act = String(a.do || '');
      /* 动作级 when（0.9.18）：条件不成立就**这一步动作**跳过，其余照做。
       * 与步骤级 step.when 的分工：step.when 只能整步跳过，而「同一份 spec 覆盖两种业务前态」
       * 往往只差一个动作（如登录密码：改过密用正式密码、没改过用初始密码——两个动作同一个输入框）。
       * confirm_gate 自己会评估 when（那里 hit = 要弹闸门），不在这里重复判。 */
      if (a.when && act !== 'confirm_gate') {
        const w = ENGINE.gateWhen(a.when, scope);
        if (w.error) {
          throw new Error('E_GATE 动作条件无法判定：' + w.error + '（' + (a.name || act) + '）');
        }
        if (!w.hit) {
          log('跳过 ' + (a.name || act) + '：条件不满足（' + w.detail + '）');
          return;
        }
        log('条件成立（' + w.detail + '），执行 ' + (a.name || act));
      }
      if (act === 'wait') { await sleep(Number(a.ms) || gap); return; }
      /* 关页是纯本地动作：不等网络、不依赖任何元素。调用后页面可能立刻销毁，
       * 所以不做「关掉了吗」的回读——那是自欺欺人（页面没了就读不到了）。 */
      if (act === 'close_tab') {
        const delay = Math.max(0, Number(a.delay_ms) || 0);
        if (delay) { log('提交成功，' + delay + 'ms 后关闭标签页'); await sleep(delay); }
        log('关闭标签页');
        try {
          if (typeof window !== 'undefined' && typeof window.close === 'function') window.close();
          else log('当前环境不支持关闭标签页（缺少 window.close 授权）');
        } catch (e) { log('关闭标签页失败：' + e.message + '（可能是本窗口最后一个标签页）'); }
        await sleep(200);
        return;
      }

      /* 人工闸门：不碰页面元素、不发任何请求，只要求人点一下，然后按 spec 声明的码终止。
       * 放在「定位元素」之前——它不需要 target。典型用法：组织已满 200 人、需要人补验证码。 */
      if (act === 'confirm_gate') {
        const gTitle = ENGINE.resolvePlaceholders(String(a.title || '需要你确认'), scope);
        const gMsg = ENGINE.resolvePlaceholders(String(a.message || ''), scope);
        /* 判不出来一律终止（E_GATE），不能当作「没命中」继续往下走——
         * 那会在不知道是否满员的情况下建成员。这类是引擎/配置故障，不是「需要人工」。 */
        const engineFail = (m) => { const e = new Error(m); e.code = 'E_GATE'; e.noOnFail = true; return e; };
        /* 闸门数据未就绪时先等（2026-11-06 真机误报满员，见 gateWhen 里「右值 0」的注释）。
         * 只对「带 ref_xpath 的数值比对」等：exists 类闸门（如验证码容器）判的是「此刻在不在」，
         * 等一等反而会错过时机。等不到才按「判不出来」终止，不拿旧值/零值蒙一个结论。 */
        const scanGate = () => ENGINE.gateWhen(a.when, scope);
        let gw = scanGate();
        if (a.when && a.when.ref_xpath) {
          const readyMs = Math.max(0, Number(a.when.ready_ms == null ? 3000 : a.when.ready_ms) || 0);
          const t0 = Date.now();
          let announced = false;
          while (gw.error && gw.retryable && Date.now() - t0 < readyMs) {
            if (!announced) { log('闸门数据还没回填（' + gw.error + '），等待页面渲染（最多 ' + readyMs + 'ms）…'); announced = true; }
            await sleep(120);
            gw = scanGate();
          }
          if (announced) log(gw.error ? ('闸门数据等待超时：' + gw.error) : ('闸门数据已就绪：' + gw.detail));
        }
        if (gw.error) {
          throw engineFail('E_GATE 闸门条件无法判定：' + gw.error + '——已终止（不装作没看见）');
        }
        if (!gw.hit) { log('闸门条件未命中（' + gw.detail + '），继续'); return; }
        log('⏸ 等待人工确认：' + gTitle + '（' + gw.detail + '）');
        const gr = await ENGINE.confirmGate({ title: gTitle, message: gMsg, button: a.button ? String(a.button) : '' });
        if (!gr.confirmed) {
          throw engineFail('E_GATE 无法显示确认框（' + (gr.error || '未知原因') + '）——已终止，不在无人知晓的情况下继续往下跑');
        }
        /* continue_after（0.9.17）：闸门是「告知 + 等人做完」，不是终点。
         * 场景：首次登录要短信验证码，脚本代填不了（两个渠道都遮码）。以前点完「我知道了」
         * 就按 E_CAPTCHA 终止，人输完验证码后页面进了「设置新密码」，但流程已经死了，
         * 只能手动再点一次面板——这就是「接不上」。
         * 声明 continue_after 后：人点按钮 → 遮罩关闭 → 轮询 await 条件直到命中 → 继续下一步。
         * 缺省（不声明）仍是终止，与 0.8.x~0.9.16 行为逐字节一致。
         *
         * await 不能省：点完按钮的那一刻页面还没变（人刚要去输码），立刻继续会在旧页面上
         * 执行下一步。必须等一个「人做完了」的页面证据。 */
        if (a.continue_after === true) {
          log('✓ 人工已确认（' + gTitle + '），继续（本闸门不是终点）');
          const aw = a.await || null;
          const conds = aw ? (Array.isArray(aw.any_of) ? aw.any_of : (aw.exists ? [aw] : [])) : [];
          if (conds.length) {
            const tmo = Math.max(1000, Number(aw.timeout_ms) || 180000);
            const t0 = Date.now();
            log('等待页面出现预期状态（最多 ' + Math.round(tmo / 1000) + ' 秒）…');
            let hit = null;
            while (!hit && Date.now() - t0 < tmo) {
              for (let ci = 0; ci < conds.length; ci++) {
                const c = conds[ci] || {};
                let el = null;
                try { el = ENGINE.uiFindBusinessByXPath(ENGINE.resolvePlaceholders(String(c.exists || ''), scope)); }
                catch (e) { el = null; }
                if (el && ENGINE.uiIsVisible(el)) { hit = c; break; }
              }
              if (!hit) await sleep(400);
            }
            if (!hit) {
              /* 等不到不能装作没看见继续跑：下一批动作会在登录页/验证码页上乱写。
               * 带 human 标记（这不是故障，是人没做完），但不诱导原样重跑——重跑会再登一次。 */
              const te = new Error(gTitle + '｜等待超时：' + Math.round(tmo / 1000)
                + ' 秒内页面没有出现预期状态（' + conds.map(function (c) { return c.name || c.exists; }).join(' / ')
                + '）——已终止，请人工看一眼当前页面');
              te.code = String(aw.error || 'E_HUMAN_TIMEOUT');
              te.human = true;
              throw te;
            }
            log('✓ 检测到：' + (hit.name || String(hit.exists).slice(0, 60)) + '，继续下一步');
          }
          return;
        }
        log('✓ 人工已确认（' + gTitle + '），按 spec 声明终止本流程');
        /* 这里是「按设计停下等人」，不是故障。必须带自己的错误码（spec 的 action.error，
         * 缺省 E_HUMAN_CONFIRM）和 human 标记抛出去：
         *   - 不带码 → 上层 catch 会套用 step.on_fail 的文案，把「满员/要验证码」说成
         *     「组织没找到」「账号密码不对」——2026-11-05 的教训：文案错了比没文案更危险；
         *   - human 标记 → 收尾横幅不说「失败」，也不诱导重复触发。 */
        const gErr = new Error(gTitle + '｜请人工处理完成后重新触发（这不是故障，是设计上的停点）');
        gErr.code = String(a.error || 'E_HUMAN_CONFIRM');
        gErr.human = true;
        throw gErr;
      }

      const target = ENGINE.resolvePlaceholders(String(a.target || ''), scope);
      const until = a.until ? String(a.until) : '';
      // 提交是不可逆写操作：只点一次，绝不因「没看清结果」而重试
      const tries = act === 'submit' ? 1 : Math.max(1, Number(a.max_tries) || 3);
      const untilMs = Number(a.until_ms) || 1500;
      const label = a.name || target;
      let lastErr = '';

      /* assert_ui：只读确认，不做任何操作。用来在关键动作（尤其不可逆的提交）之前
       * 确认表单真实值，把「填了但没进去」挡在提交之前。
       * 与 until 的区别：until 看显隐（副作用），assert_ui 看文本（结果）。 */
      /* assert_ui：只读确认，不做任何操作。用来在关键动作（尤其不可逆的提交）之前
       * 确认表单真实值，把「填了但没进去」挡在提交之前。
       * 与 until 的区别：until 看显隐（副作用），assert_ui 看文本（结果）。 */
      if (act === 'assert_ui') {
        const axp = ENGINE.resolvePlaceholders(String(a.xpath || ''), scope);
        const awant = ENGINE.resolvePlaceholders(String(a.text == null ? '' : a.text), scope);
        if (!axp) throw new Error('E_SPEC assert_ui 缺 xpath');
        const r = ENGINE.uiExpectText(axp, awant);
        if (!r.ok) {
          throw new Error('E_UI_EXPECT ' + label + '：期望「' + awant + '」，实际「'
            + (r.found ? r.actual : '<元素未找到>') + '」——' + (a.hint || '前面的动作没有真正写进表单'));
        }
        log('确认 ' + label + ' = ' + awant);
        return;
      }

      /* read：从页面上把一个值带回来（只读，不点、不写）。
       * 为什么需要：新建成员的完整邮箱只有页面知道（后缀由组织域名带出），
       * 业务表要求回写它，而它不在任何请求参数里。spec 声明 target+var，引擎读取并交回
       * 步骤抽取（{{步骤.var}}），后续 outputs/回写模板就能引用。 */
      if (act === 'read') {
        const rxp = ENGINE.resolvePlaceholders(String(a.target || ''), scope);
        let rel = null;
        try { rel = ENGINE.uiFindByXPath(rxp); } catch (e1) { throw new Error('E_UI_TARGET read 选择器无效: ' + rxp); }
        if (!rel && readyMs > 0) rel = await ENGINE.uiWaitByXPath(rxp, readyMs, sleep);
        if (!rel) {
          /* optional（0.9.17）：与 click/type 同一语义——元素不在就跳过并留日志。
           * 用于「同一个 spec 要覆盖两种页面形态」的场景（如首次登录才有的改密弹层）：
           * 弹层不在是正常分支，不是故障。仍然必须打日志，静默跳过会让「选择器写错了」
           * 看起来像「本来就没有这一步」。 */
          if (a.optional === true) { log('跳过 ' + label + '：页面没有这个元素（spec 声明 optional）'); return; }
          throw new Error('E_UI_TARGET 要读取的元素未找到: ' + a.target + (a.name ? '（' + a.name + '）' : ''));
        }
        let got = ENGINE.uiText(rel);
        /* regex（0.9.16）：从页面文本里只取一段。典型场景是结果页那行「账户ID 2077792760467029248」——
         * 要回写进业务表的是纯数字，整段写进去会把「账户ID 」四个字一起塞进「客仓ID」列，
         * 而且不报错（看起来「有值」）。取不到必须报错指名正则与实际文本，禁止退回整段。 */
        if (a.regex != null && String(a.regex).length) {
          let m = null;
          try { m = new RegExp(String(a.regex)).exec(got); }
          catch (e) { throw new Error('E_SPEC read 的 regex 非法: ' + a.regex + '（' + e.message + '）'); }
          if (!m) throw new Error('E_UI_READ ' + label + '：文本里没有匹配 /' + a.regex + '/ 的内容（实际「'
            + String(got).slice(0, 80) + '」）');
          got = m[0];
        }
        const key = String(a.var || ('v' + Object.keys(readings).length));
        readings[key] = got;
        log('读取 ' + label + ' = ' + (a.secret === true ? ENGINE.maskValue(got) : (got.length > 48 ? got.slice(0, 48) + '…' : got)));
        return;
      }

      /* pick_date（0.9.18）：按 from/to 在日期面板里翻月 + 点日，把区间真正写进受控组件。
       * 声明：{"do":"pick_date","xpath":"<form-item 或 .el-date-editor>","from":"{{start_date}}","to":"{{end_date}}"}
       * 为什么不是 type：el-date-editor--daterange 只认面板点击，写 input.value 不进模型
       * （真机症状：值看着在、提交被「请选择授权有效期」拦下）。详见 ENGINE.pickDateRange。 */
      if (act === 'pick_date') {
        const pxp = ENGINE.resolvePlaceholders(String(a.xpath || ''), scope);
        if (!pxp) throw new Error('E_SPEC pick_date 缺 xpath（指向日期控件或其外层 form-item）');
        const pfrom = String(ENGINE.resolvePlaceholders(String(a.from == null ? '' : a.from), scope) || '').trim();
        const pto = String(ENGINE.resolvePlaceholders(String(a.to == null ? '' : a.to), scope) || '').trim();
        let host = null;
        try { host = ENGINE.uiFindByXPath(pxp); } catch (e1) { throw new Error('E_UI_TARGET pick_date 选择器无效: ' + pxp); }
        if (!host && readyMs > 0) host = await ENGINE.uiWaitByXPath(pxp, readyMs, sleep);
        if (!host) {
          if (a.optional === true) { log('跳过 ' + label + '：页面没有这个日期控件（spec 声明 optional）'); return; }
          throw new Error('E_UI_TARGET pick_date 的日期控件未找到: ' + pxp);
        }
        /* 允许 xpath 指到外层（form-item / 单元格），自动收窄到 .el-date-editor */
        let editor = host;
        if (String(editor.className || '').indexOf('el-date-editor') < 0) {
          editor = (editor.closest && editor.closest('.el-date-editor'))
            || (editor.querySelector && editor.querySelector('.el-date-editor'))
            || editor;
        }
        log('选择日期区间 ' + label + '：' + pfrom + ' ~ ' + pto + '（点面板，不写 input.value）');
        const r = await ENGINE.pickDateRange({ doc: document, editor: editor, from: pfrom, to: pto, sleep: sleep, log: log });
        if (a.var) readings[String(a.var)] = r.from + '~' + r.to;
        return;
      }

      /* upload：往 input[type=file] 里塞文件（3B 开户信息页的企业执照/身份证正反/行业资质都靠它）。
       * 为什么必须有这个原语：脚本不能改 input.value，但可以构造 File + DataTransfer 赋给 input.files
       * 再派发 change —— 2026-11-06 真机实测 Element Plus 的 el-upload 会正常接收并发出
       * POST /usermgtportal/v1/upload_private（见 evidence/p3b-upload-feasibility-20261106.md）。
       *
       * 判据不能看 input.files：派发 change 之后组件会把 input 清空，立刻读是 0，那是「事件被接收」
       * 的正面信号而不是失败。所以要求用 expect_xpath/expect_text 等「上传列表出现文件名/缩略图」，
       * 不写判据就只证明「事件发出去了」，不证明「传上去了」。 */
      if (act === 'upload') {
        const uxp = ENGINE.resolvePlaceholders(String(a.xpath || ''), scope);
        if (!uxp) throw new Error('E_SPEC upload 缺 xpath（必须指向 input[type=file]）');
        const b64 = String(ENGINE.resolvePlaceholders(String(a.base64 || ''), scope) || '').replace(/\s+/g, '');
        /* src（0.9.15）：一次性地址，字节由 GM_xhr 取。与 base64 二选一——
         * 老 spec 的 base64 写法一行不改继续可用。 */
        const src = String(ENGINE.resolvePlaceholders(String(a.src || ''), scope) || '').trim();
        if (!b64 && !src) {
          const declared = a.base64 || a.src;
          throw new Error('E_SPEC upload 的 base64 / src 都是空（' + (declared || '两者都未声明') + '）'
            + '——声明的是占位符时，多半是业务表这一列没有附件');
        }
        const fname = ENGINE.resolvePlaceholders(String(a.filename || 'upload.bin'), scope);
        const mm = ENGINE.resolvePlaceholders(String(a.mime || 'application/octet-stream'), scope);

        const inp = ENGINE.uiFindByXPath(uxp);
        if (!inp) throw new Error('E_UI_TARGET upload 目标未找到：' + (a.name || uxp));

        let bytes;
        if (b64) {
          let bin;
          try { bin = atob(b64); } catch (e) { throw new Error('E_SPEC upload 的 base64 无法解码：' + e.message); }
          bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } else {
          if (!/^https?:\/\//i.test(src)) throw new Error('E_SPEC upload 的 src 必须是 http(s) 地址，实际「' + src + '」');
          const ab = await ENGINE.uiFetchBytes(src);
          bytes = new Uint8Array(ab);
        }
        if (!bytes.length) throw new Error('E_UI_FILE_SRC ' + (a.name || '') + '：取到 0 字节（源文件为空或下载被截断）');

        const put = ENGINE.uiPutFile(inp, bytes, fname, mm);
        log('已塞入文件 ' + put.filename + '（' + put.size + ' 字节，' + put.mime + '）→ ' + (a.name || label)
          + '；随后 input.files 会被组件清空，属正常');

        /* 判据：等上传列表/缩略图/文件名出现。不写 expect_xpath 时只记一条 warn —— 只证明
         * 「变更事件发得出去」，不证明「传成功了」，别让人误以为已经验过。 */
        const wxp = a.expect_xpath ? ENGINE.resolvePlaceholders(String(a.expect_xpath), scope) : '';
        const wtext = a.expect_text == null ? '' : ENGINE.resolvePlaceholders(String(a.expect_text), scope);
        if (!wxp) {
          log('⚠ upload 未声明 expect_xpath，只确认了文件已交给组件，未确认上传结果');
          return;
        }
        const wms = Math.max(0, Number(a.expect_ms) || Number(a.until_ms) || 20000);
        const t0 = Date.now();
        let r = ENGINE.uiExpectText(wxp, wtext);
        while (!r.ok && Date.now() - t0 < wms) { await sleep(200); r = ENGINE.uiExpectText(wxp, wtext); }
        if (!r.ok) {
          throw new Error('E_UI_EXPECT ' + (a.name || '') + '：上传后没看到「' + wtext + '」（实际「'
            + (r.found ? r.actual : '<元素未找到>') + '」）——文件可能被前端校验拒了，或会话已失效');
        }
        log('上传结果已确认：' + (a.name || label) + (wtext ? ' = ' + wtext : '（元素已出现）'));
        return;
      }

      /* 结果断言（可选，click/type 通用）：动作完成后校验 expect_xpath 的文本含 expect_text。
       * 不通过则重试；重试前若声明了 reopen，先重新展开下拉（联动重渲染会把浮层关掉）。 */
      const expectXp = a.expect_xpath ? String(a.expect_xpath) : '';
      const expectText = a.expect_text == null ? '' : String(a.expect_text);
      const reopenXp = a.reopen ? String(a.reopen) : '';

      async function verifyExpect() {
        if (!expectXp) return true;
        const want = ENGINE.resolvePlaceholders(expectText, scope);
        const xp = ENGINE.resolvePlaceholders(expectXp, scope);
        /* 轮询而不是立即读：Vue/Element Plus 改完数据是 nextTick 才更新 DOM，
         * 点完立刻读会读到旧文本，把「刚写进去」误判成「没写进去」，白白多重试一轮。 */
        const limit = Math.max(0, Number(a.expect_ms) || 800);
        const t0 = Date.now();
        let r = ENGINE.uiExpectText(xp, want);
        while (!r.ok && Date.now() - t0 < limit) {
          await sleep(60);
          r = ENGINE.uiExpectText(xp, want);
        }
        if (r.ok) { log('结果校验通过：' + label + (want ? ' = ' + want : '（元素已出现）')); return true; }
        lastErr = '期望「' + want + '」未出现（实际「' + (r.found ? r.actual : '<元素未找到>') + '」）';
        log('结果校验未通过（' + lastErr + '），重试 ' + label);
        if (reopenXp) {
          const rn = ENGINE.uiFindByXPath(ENGINE.resolvePlaceholders(reopenXp, scope));
          if (rn) { rn.click(); await sleep(Number(a.reopen_ms) || 250); }
        }
        return false;
      }

      for (let k = 1; k <= tries; k++) {
        // 每次重试都重新定位：联动重渲染会把旧节点换成新的，持有旧引用会点空
        const tFind = Date.now();
        const first = ENGINE.uiFindByXPath(target);
        if (!first && readyMs > 0) log('等待页面渲染（' + label + '，最多 ' + readyMs + 'ms）');
        const el = first || await ENGINE.uiWaitByXPath(target, readyMs, sleep);
        if (!el) {
          /* optional：同一个入口可能有两种页面形态（如邀请链接可能落在注册页，也可能直接
           * 落在登录页）。只有 spec 显式声明 optional 才允许跳过，并且必须留日志——
           * 静默跳过会让「选择器写错了」看起来像「本来就没有这一步」。 */
          if (a.optional === true) {
            log('跳过 ' + label + '：页面没有这个元素（spec 声明 optional）');
            return;
          }
          throw new Error('E_UI_TARGET 页面元素未找到: ' + a.target + (a.name ? '（' + a.name + '）' : '')
            + '——已等待 ' + (Date.now() - tFind) + 'ms 仍未出现：页面可能改版，或表单渲染比 ' + readyMs + 'ms 更慢');
        }

        if (act === 'hover') {
          /* 只为「悬浮才展开」的菜单存在（Element Plus el-dropdown 默认 trigger=hover）。
           * el.click() 不会触发 mouseenter，所以下拉菜单用 click 永远打不开——而且不报错，
           * 表现是「点了没反应」（2026-11-06 退出登录实测）。必须派发真实的悬浮事件。
           * 一次派发不够：有的组件监听 pointerenter，有的监听 mouseenter，两个都发。 */
          log('悬浮 ' + label);
          const evs = ['pointerenter', 'mouseenter', 'mouseover'];
          for (let e2 = 0; e2 < evs.length; e2++) {
            try {
              const Ctor = (evs[e2] === 'pointerenter' && typeof PointerEvent !== 'undefined') ? PointerEvent : MouseEvent;
              el.dispatchEvent(new Ctor(evs[e2], { bubbles: !/enter$/.test(evs[e2]), cancelable: true, view: window }));
            } catch (e3) { /* 老浏览器不支持 PointerEvent：mouseenter 兜底 */ }
          }
          if (until) {
            const ok = await ENGINE.uiWaitState(target, until, untilMs, sleep);
            if (!ok) { lastErr = untilMs + 'ms 内未变为 ' + until; log('未生效（' + lastErr + '），重试 ' + label); continue; }
          }
          if (!(await verifyExpect())) continue;
        } else if (act === 'check') {
          /* 幂等勾选（0.9.16）：把目标勾选到期望状态，已经处于期望状态就不再点。
           * 为什么非要有这条原语：复选框的「点击」不是幂等的。同意项、三证合一这类开关，
           * 已经勾上的再点一次就取消了，页面不报任何错，直到提交才炸；更坏的情况是把
           * 「三证合一」点掉——资质区整块从「1 张执照」换成「三证分开」，后面所有上传位全错。
           * 所以判据只认控件当前状态（input.checked / aria-checked），不认「我点过了」。 */
          const want = a.checked === false ? false : true;
          const cur = () => (el.checked === true) || el.getAttribute('aria-checked') === 'true';
          if (cur() === want) {
            log('已是目标状态（' + (want ? '已勾选' : '未勾选') + '），不重复点击：' + label);
          } else {
            log((want ? '勾选 ' : '取消勾选 ') + label + (k > 1 ? '（第 ' + k + ' 次）' : ''));
            el.click();
            /* 等一拍再读：Vue 的 model 更新要 nextTick，立即读会读到旧状态而误判成失败 */
            await sleep(120);
          }
          if (cur() !== want) {
            lastErr = '勾选后状态不符（期望 ' + (want ? '勾上' : '未勾') + '，实际 ' + (cur() ? '勾上' : '未勾') + '）';
            log('未生效（' + lastErr + '），重试 ' + label);
            continue;
          }
          if (until) {
            const ok = await ENGINE.uiWaitState(target, until, untilMs, sleep);
            if (!ok) { lastErr = untilMs + 'ms 内未变为 ' + until; log('未生效（' + lastErr + '），重试 ' + label); continue; }
          }
          if (!(await verifyExpect())) continue;
        } else if (act === 'click') {
          /* nav_after：这一下会把整页带走。续跑状态必须在点之前落盘（页面一卸载，后面的
           * 代码就再也不会执行）；点完页面还在 = 没跳，必须回滚状态并报错。 */
          const navA = (a.nav_after && typeof a.nav_after === 'object') ? a.nav_after : null;
          log('点击 ' + label + (k > 1 ? '（第 ' + k + ' 次）' : ''));
          if (navA) {
            const hrefB = String(location.href);
            if (opts.onNavBefore) opts.onNavBefore(navA);
            el.click();
            /* 轮询而不是固定睡 1500ms：退出登录要整页崩到 CAS 登录页，实测常见 2~3s，
             * 固定时长会把「慢」误判成「没跳」，进而回滚续跑状态、把流程掐在退出这一步。 */
            const navMs = Number(navA.wait_ms) > 0 ? Number(navA.wait_ms) : 3000;
            const navDeadline = Date.now() + navMs;
            let moved = false, urlOk = false;
            do {
              await sleep(250);
              moved = String(location.href) !== hrefB;
              urlOk = !navA.url_contains || String(location.href).indexOf(navA.url_contains) >= 0;
              if (moved && urlOk) break;
            } while (Date.now() < navDeadline);
            if (!(moved && urlOk)) {
              /* soft：这一次跳转不是硬门禁，确认不了就继续往下走。
               * 用在「退出登录」这类地方——没跳成功也要接着进下一环节（下一环节本来就要重新
               * 输账号密码），卡在这里反而让整条链停住。回滚续跑标记，避免留下一个永远等不到
               * 落地的运行态（下次打开页面会误以为要续跑）。 */
              if (navA.soft === true) {
                if (opts.onNavAfter) opts.onNavAfter(false);
                log('跳转未确认（当前 ' + String(location.href).slice(0, 80) + '），按声明继续');
                return;
              }
              if (opts.onNavAfter) opts.onNavAfter(false);
              throw new Error('E_NAV ' + label + ' 声明了跳转（' + JSON.stringify(navA) + '），但页面没有跳转：当前地址 ' +
                String(location.href).slice(0, 120) + '——点击可能没落到可点的节点上，或页面结构变了');
            }
            if (opts.onNavAfter) opts.onNavAfter(true);
            log('已跳转到 ' + String(location.href).slice(0, 90));
            return;
          }
          el.click();
          if (until) {
            const ok = await ENGINE.uiWaitState(target, until, untilMs, sleep);
            if (!ok) {
              lastErr = untilMs + 'ms 内未变为 ' + until;
              log('未生效（' + lastErr + '），重试 ' + label);
              continue;
            }
          }
          if (!(await verifyExpect())) continue;
        } else if (act === 'type') {
          const val = ENGINE.resolvePlaceholders(String(a.value == null ? '' : a.value), scope);
          /* 可空字段：只有 spec 显式声明 skip_if_empty 才允许空值跳过。
           * 缺省仍然报错——「解析为空」多半是参数没取到，静默跳过会让人以为填过了。
           * 声明了就必须留日志，别让「跳过一个字段」变成看不见的事。 */
          if (!String(val).length) {
            if (a.skip_if_empty === true) {
              log('跳过 ' + label + '：值为空（spec 声明该字段可空）');
              return;
            }
            throw new Error('E_UI_VALUE 填充值解析为空: ' + label + '——查任务参数或表字段值');
          }
          /* 敏感值（密码/密钥）在日志与报错里一律打码。日志会落屏、跨页保留（GM 存储）、
           * 并常被截图或整段贴进对话与文档——每贴一次就多一份密码副本，且无法审计、无法收回。
           * spec 用 type.secret=true 声明；未声明者照旧显示原值（向后兼容，不影响既有场景）。 */
          const secretVal = a.secret === true;
          const showVal = (v) => secretVal
            ? String(ENGINE.maskValue(v))
            : (String(v).length > 28 ? String(v).slice(0, 28) + '…' : String(v));
          log('填写 ' + label + ' = ' + showVal(val) + (secretVal ? '（敏感值，已打码）' : '') + (k > 1 ? '（第 ' + k + ' 次）' : ''));
          ENGINE.uiSetValue(el, val);
          /* 读回自检：受控组件（Vue v-model）可能在重渲染时把值刷回旧值。
           * 判据只认 el.value 实际值，不认「事件已派发」——事件派发成功不代表值留住了。 */
          let okv = String(el.value) === String(val);
          for (let j = 0; j < 3 && !okv; j++) {
            await sleep(60);
            ENGINE.uiSetValue(el, val);
            okv = String(el.value) === String(val);
          }
          if (!okv) { lastErr = '读回值不符（期望 ' + showVal(val) + '，实际 ' + showVal(el.value) + '）'; continue; }
          if (until) {
            const ok = await ENGINE.uiWaitState(target, until, untilMs, sleep);
            if (!ok) { lastErr = untilMs + 'ms 内未变为 ' + until; continue; }
          }
          if (!(await verifyExpect())) continue;
        } else if (act === 'submit') {
          /* 点提交并判定结果。三态分开报：成功 / 校验没过 / 失败或未确认。
           * 「未确认」一律当失败终止——写操作宁可少发一封让人手动补，也不能误报成功。 */
          const timeout = Math.max(1000, Number(a.timeout_ms) || 15000);
          /* 判定红字前的安抚窗口：点击后立刻出现的红字，可能是「真的校验没过」，
           * 也可能是 Vue 还没把上一次的校验状态刷完。等一小会，前者不会消失、后者会。
           * 声明在 spec 里可覆盖（grace_ms），缺省 1200ms。 */
          const graceMs = Math.max(0, Number(a.grace_ms === undefined ? 1200 : a.grace_ms));
          const tPerf = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : 0;
          /* 点击前快照：此刻已处于校验失败状态的字段红字，与本次提交无关。
           * 实测（2026-11-05）：字段值其实是填对的，用户手动点一次提交就成功，但页面上残留
           * is-error 红字；不拍快照就会把「成功」误报成「校验没过、提交没发出」，导致重复提交。 */
          const staleErrs = ENGINE.uiFormErrors();
          log('提交 ' + label + (staleErrs.length
            ? '（点击前已有 ' + staleErrs.length + ' 处表单提示：' + staleErrs.join('｜') + '；不计入本次判定）'
            : ''));
          el.click();
          const tClick = Date.now();
          log('等待提交结果（最多 ' + timeout + 'ms）');
          const t0s = tClick;
          let st = { state: 'pending', signal: '', text: '' };
          while (Date.now() - t0s < timeout) {
            st = ENGINE.uiDetectSubmitResult({
              success: a.success, fail: a.fail,
              stale: staleErrs, t0: tClick, grace_ms: graceMs
            });
            if (st.state !== 'pending') break;
            await sleep(100);
          }
          // 把提交触发的请求记下来：本场景提交接口此前未捕获，这里是第一次取证机会
          const reqs = ENGINE.uiNewRequests(tPerf);
          if (reqs.length) {
            log('提交后网络请求：' + reqs.map(function (r) { return (r.status || '?') + ' ' + r.url + ' (' + r.ms + 'ms)'; }).join(' ｜ '));
          }
          if (st.state === 'ok') {
            log('提交成功（' + st.signal + '）' + (st.text ? '：' + st.text : '') + '，判定用时 ' + (Date.now() - t0s) + 'ms');
            await sleep(gap);
            return;
          }
          if (st.state === 'invalid') {
            /* 措辞刻意保守：我们只看到「提交后新出现了一处校验错误」，并不能证明请求没发出
             * （按钮可能先发请求、后渲染校验提示）。说成「没发出」会诱导人重复提交。 */
            throw new Error('E_UI_VALIDATE 提交后新增表单校验错误，无法确认请求是否已发出: '
              + (st.text || '见页面字段下的红色提示')
              + '——请先核对该字段与后端记录，确认没有发出之前不要重复提交');
          }
          if (st.state === 'fail') {
            throw new Error('E_UI_SUBMIT 提交失败: ' + (st.text || st.signal) + '——已终止且不重试，请人工核对');
          }
          /* 超时未确认时，把页面上仍存在的表单提示一起报出来：这些红字是陈旧的（点击前就有），
           * 无法据此判断本次结果，但能直接告诉人工「该去看哪个字段」。 */
          const remainErrs = ENGINE.uiFormErrors();
          throw new Error('E_UI_SUBMIT 提交后 ' + timeout + 'ms 内未检测到成功信号（未确认，已终止且不重试）'
            + (st.text ? '；页面提示：' + st.text
              : (remainErrs.length ? '；页面仍有表单提示：' + remainErrs.join('｜') + '（点击前就存在，无法据此判断本次结果）' : ''))
            + '——请人工核对页面后决定是否重做，不要盲目重复提交');
        } else {
          throw new Error('E_SPEC 未知 ui 动作: ' + act);
        }
        await sleep(gap);
        return;
      }
      throw new Error('E_UI_NOEFFECT 动作执行 ' + tries + ' 次仍未生效: ' + label + '——' + lastErr);
    }

    /* 同 group 的连续动作并行（文本输入之间互不依赖，串行只是白等）。
     * 每组内部并发、组之间顺序——所以「先展开、再选、再填下一页」的依赖不会被打破。 */
    const list = actions || [];
    const batches = [];
    for (const a of list) {
      const item = a || {};
      const g = item.group ? String(item.group) : '';
      const last = batches[batches.length - 1];
      const canMerge = g && last && last.group === g && String(item.do) !== 'wait';
      if (canMerge) last.items.push(item);
      else batches.push({ group: g, items: [item] });
    }
    for (const b of batches) {
      if (b.items.length > 1) {
        log('并行处理 ' + b.items.length + ' 项（' + b.group + '）');
        await Promise.all(b.items.map(runOne));
      } else {
        await runOne(b.items[0]);
      }
    }
    return readings;
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

  // ---------- 断言项级 on_fail + 消息模板 ----------
  // 断言项两种形式：字符串（用步骤级 on_fail）或对象 {assert, on_fail:{error,message}}（项级优先）。
  // on_fail.message 支持 {{响应路径}} 模板（如 "账户状态：{{data.data[0].corpStatus}}"），
  // 对当前步响应 json 解析；路径不存在时保留原样（宁可带着 {{...}} 上屏，也不静默吞掉）。
  ENGINE.assertOnFail = function (item, step, json) {
    const base = (item && typeof item === 'object' && item.on_fail) ? item.on_fail : (step.on_fail || {});
    if (!base.message || base.message.indexOf('{{') < 0) return base;
    const msg = base.message.replace(/\{\{(.+?)\}\}/g, function (_, p) {
      const v = ENGINE.resolvePath(json, p.trim());
      return (v === undefined || v === null) ? '{{' + p.trim() + '}}' : String(v);
    });
    return Object.assign({}, base, { message: msg });
  };

  // 回写「错误类型」列用人话：取失败消息第一段（'｜'前），没有则退回错误码；上限 120 字符。
  // 错误码仍完整保留在 runner 日志与批量报告的错误码分布里。
  ENGINE.failReason = function (err) {
    const seg = String((err && err.message) || '').split('｜')[0].trim();
    return (seg || (err && err.code) || 'E_UNKNOWN').slice(0, 120);
  };

  // 简易字符串哈希（djb2 变体，hex 输出）——仅用于缓存键去重，不做安全用途。
  ENGINE.strHash = function (s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; }
    return h.toString(16);
  };

  /* ==================== ENGINE-END ==================== */

  const GV = {
    RUN_KEY: 'masr_run_v1',          // 运行态（跨页续跑）
    CACHE_KEY: 'masr_cache_v1',      // 步骤缓存
    TRANSPORT_KEY: 'masr_transport', // 通道探测结论（fetch / gm）
    LAST_SPEC_KEY: 'masr_last_spec_v1',     // 上次加载的 spec 原文（刷新/重开自动恢复）
    LAST_PARAMS_KEY: 'masr_last_params_v1', // 按 spec_id 记住的参数值
    SCHEMA_SUPPORTED: '0.1',
    RUNNER_VERSION: '0.9.23',
    // 自更新通道：油猴按 @updateURL 静默更新，指向**自建分发路由**
    //   https://mas.wankahuanju.top/runner.user.js
    // （Worker 内部回源 GitHub，边缘缓存 60s —— 发布即生效）。
    // 为什么不用公共源直连（2026-11-05 实测）：
    //   - Gitee raw 在浏览器/油猴里会被导向内网登录服务 authunicorn.gitee-prod:3000，
    //     客户端不可达，装不上；
    //   - jsDelivr 的 @main 有 12h 文件缓存 + 独立的分支→commit 解析缓存，purge 打不到，长期给旧版；
    //   - GitHub raw 国内 DNS 污染，业务同学基本不可达。
    // 下面的 manifest 列表只用于「检查更新」按钮与启动静默自检（按序尝试，自建优先）。
    UPDATE_MANIFEST: [
      'https://mas.wankahuanju.top/runner.json',
      'https://cdn.jsdelivr.net/gh/liuzheng2014/mas-runner@main/manifest.json',
      'https://raw.githubusercontent.com/liuzheng2014/mas-runner/main/manifest.json'
    ],
    INSTALL_URL: 'https://mas.wankahuanju.top/runner.user.js',
  };

  // ---------- 运行态存取（GM 存储跨域共享，导航后由新页面恢复） ----------
  const RunState = {
    /* 冻结位：同标签交接开始后，本页剩下的收尾代码（log 闭包、final 广播、失败回写）不许再把
     * 运行态写回去。没有它就会出现「刚 clear 完、下一条 log 又把旧状态原样复活」——
     * 0.9.8 真机就是被这条幽灵状态带到新页面去续跑的（见 v0.9.9 注释）。 */
    _frozen: false,
    get() { try { return JSON.parse(GM_getValue(GV.RUN_KEY, 'null')); } catch (e) { return null; } },
    set(st) {
      if (this._frozen) return;
      GM_setValue(GV.RUN_KEY, JSON.stringify(st));
    },
    clear() { GM_deleteValue(GV.RUN_KEY); },
    freeze() { this._frozen = true; },
    thaw() { this._frozen = false; },
  };
  /* 收摊信号：一次流程结束只广播一次，所有「脚本打开的标签页」看到它都自毁。
   * 为什么单独存而不是复用 RunState.final：发起页收到结果后会把 final.consumed 置 true 并很快清掉运行态，
   * 上游辅助页（比如先被打开的子客门户）轮询到 consumed 就提前 return，永远等不到关闭时机——
   * 2026-10-30 实测：密钥页关了、子客首页留着。所以关闭与否只认这个一次性标记。 */
  const CloseSig = {
    KEY: 'masr_close_v1',
    mark(runId) { try { GM_setValue(this.KEY, JSON.stringify({ runId: runId || '', at: Date.now() })); } catch (e) {} },
    get() { try { return JSON.parse(GM_getValue(this.KEY, 'null')); } catch (e) { return null; } },
    clear() { try { GM_deleteValue(this.KEY); } catch (e) {} },
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
    // 含 submit 的步骤必须声明 write:true。
    // 否则 submit 会绕过写配额（配额只数 write 步骤），等于把不可逆操作藏在「只读步骤」里执行——
    // 这是配额制唯一的自毁口子，宁可加载期就拒绝。
    (spec.steps || []).forEach(function (s) {
      const acts = (s.ui && s.ui.actions) || [];
      const hasSubmit = acts.some(function (a) { return String((a && a.do) || '') === 'submit'; });
      if (hasSubmit && s.write !== true) {
        throw new Error('E_SPEC: ' + s.id + ' 含 submit 动作但未声明 write:true —— 提交是不可逆写操作，必须显式声明才能受写配额约束');
      }
    });
    /* 凭据不许走 URL：secret 参数只能由 /task 下发（请求体），不能出现在 scene.trigger.params_query，
     * 也不能出现在 url_patterns 之外的任何 URL 侧声明里。URL 会进浏览器历史、服务端访问日志、
     * 别人的截屏，一旦泄出去收不回来（密码改掉之前一直是活凭据）。 */
    (function () {
      const tr = (spec.scene && spec.scene.trigger) || {};
      const pq = tr.params_query && typeof tr.params_query === 'object' ? tr.params_query : {};
      (spec.params || []).forEach(function (p) {
        if (p && p.secret === true && Object.prototype.hasOwnProperty.call(pq, p.name)) {
          throw new Error('E_SPEC: 参数「' + p.name + '」声明为 secret，却出现在 scene.trigger.params_query —— 凭据不得由 URL 携带');
        }
      });
    })();
    // 版本协商：spec 要求的最低 Runner 版本不满足就停在加载阶段。
    // 否则会跑到用到新原语的那一步才报「未知动作」，看着像页面改版，实际是没更新脚本。
    const needRunner = (spec.runtime || {}).requires_runner;
    if (needRunner) {
      let running = '';
      try {
        if (typeof GM_info !== 'undefined' && GM_info && GM_info.script) running = String(GM_info.script.version || '');
      } catch (e) { running = ''; }
      if (running) {
        const chk = ENGINE.checkRequiresRunner(needRunner, running);
        if (!chk.ok) {
          throw new Error('E_SPEC: 该 spec 需要 Runner ' + needRunner + '，当前是 ' + running
            + '——请先更新脚本（工具面板「检查更新」），更新后再跑');
        }
      }
    }
  }

  /* 写操作放行判定（0.8.9 起取代 v0.1 的「一律拦截」）
   * v0.1 时没有任何写授权通道，所以 write:true 是死路——一律 E_PERM。
   * 现在改成「按 spec 显式声明的配额放行」，规则：
   *   1) draft spec 仍然一律拦（dry_run 门禁不许破，只能跑到写操作前一步）
   *   2) active spec 需声明 runtime.write_caps.max_writes_per_run，缺省 0 = 不许写
   *      —— 缺省拒绝而不是缺省允许：多写一封邀请的代价比多跑一次高得多
   *   3) 单次运行内写步骤数不得超过配额
   * 配额只管「写步骤个数」，写步骤内部怎么点由动作语义管（submit 只点一次、不重试）。
   */
  function writeQuota(spec) {
    const caps = (spec.runtime || {}).write_caps || {};
    const n = Number(caps.max_writes_per_run);
    return (Number.isFinite(n) && n > 0) ? Math.floor(n) : 0;
  }

  function checkWriteAllowed(spec, step, usedCount, dryRun) {
    if (dryRun || spec.status === 'draft') {
      return { ok: false, msg: step.id + ' 是写操作，draft spec 只允许跑到写操作前一步（dry_run 门禁）' };
    }
    const quota = writeQuota(spec);
    if (quota <= 0) {
      return { ok: false, msg: step.id + ' 是写操作，但 spec 未授权写：需在 runtime.write_caps.max_writes_per_run 声明允许的写次数（当前缺省 0 = 拒绝）' };
    }
    if (usedCount >= quota) {
      return { ok: false, msg: step.id + ' 超出写配额：本次运行已执行 ' + usedCount + ' 次写，配额 ' + quota };
    }
    return { ok: true };
  }

  function checkDryRunPermission(spec) {
    if (spec.status === 'draft') {
      const hasWrite = spec.steps.some(s => s.write === true || s.mode === 'human');
      /* draft 允许跑到写操作前一步：执行引擎会在遇 write 步骤时停下（见 runSpec）
       * 纯读 draft：dry_run 即正常执行读步骤 */
      return { dryRun: true, stopAtWrite: true, draft: true, hasWrite };
    }
    return { dryRun: false, stopAtWrite: false, draft: false, hasWrite: false };
  }

  async function runSpec(spec, params, hooks) {
    // hooks: {onLog(entry), onStep(stepId, phase, info)}
    const log = (entry) => { hooks.onLog(entry); };
    const onStep = hooks.onStep || (() => {});
    validateSpecShape(spec);
    const { dryRun, draft, hasWrite } = checkDryRunPermission(spec);

    const { vars, problems } = prepareVars(spec);
    if (problems.length) {
      log({ t: Date.now(), level: 'info', msg: '派生变量延后求值（在使用它的步骤执行时现取）: ' + problems.join('；') });
    }
    log({ t: Date.now(), level: 'info', msg: '派生变量就绪: ' + Object.keys(vars).join(', ') });
    /* draft 的标签必须说实话：以前一律打 [dry_run]，但「没有写步骤的 draft」其实会真点真输入
     * （典型是登录类 spec）——看到 dry_run 以为没真做事，是最容易出事的一种误解。 */
    log({ t: Date.now(), level: 'info', msg: (draft ? (hasWrite ? '[draft·跑到写操作前一步] ' : '[draft·未验证，操作真实生效] ') : '[run] ') + spec.spec_id + ' v' + spec.version + ' (' + spec.status + ')' });
    if (draft && !hasWrite) {
      log({ t: Date.now(), level: 'warn', msg: '本 spec 仍是草稿：流程未全部验证过。它没有写步骤，所以下面的点击/输入/提交都会真实发生，不是空跑' });
    }

    const gate = makeLimiter(spec.rate_limit);
    const extracted = {};
    const stepLogs = [];
    let scope = buildScope(spec, params, extracted, vars);
    let writeCount = 0; // 本次运行的写操作计数（受 runtime.write_caps.max_writes_per_run 约束）

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
        /* 步骤级条件（0.9.17）：不满足就整步跳过，而不是让每个动作各自 optional 等超时。
         * 典型场景：首次登录才有的「改密 → 协议 → 信任」三段弹层。以前只能把每个动作都标
         * optional，弹层不存在时 6 个动作各等 12 秒 —— 整条链白拖一分钟，还把「等到了」和
         * 「本来就没有」混成一件事。条件由 spec 声明（exists / 数值比较），引擎不认识业务含义。
         * 判不出来必须终止（E_GATE）：不确定该不该执行时「跳过」和「执行」都可能造成错误写入。 */
        if (step.when && typeof step.when === 'object') {
          const sw = ENGINE.gateWhen(step.when, scope);
          if (sw.error) {
            log({ t: Date.now(), level: 'fatal', msg: step.id + ' 执行条件无法判定：' + sw.error + '——已终止（不猜该不该执行）' });
            throw new RunnerError('E_GATE', step.id + ' 执行条件无法判定：' + sw.error);
          }
          if (!sw.hit) {
            log({ t: Date.now(), level: 'info', msg: step.id + ' 跳过：执行条件未命中（' + sw.detail + '）' });
            onStep(step.id, 'skipped');
            stepLogs.push({ id: step.id, ms: 0, skipped: true });
            continue;
          }
          log({ t: Date.now(), level: 'info', msg: step.id + ' 执行条件命中（' + sw.detail + '），开始执行' });
        }
        if (step.write === true) {
          const wchk = checkWriteAllowed(spec, step, writeCount, dryRun);
          if (!wchk.ok) {
            log({ t: Date.now(), level: 'fatal', msg: wchk.msg });
            throw new RunnerError('E_PERM', wchk.msg);
          }
          writeCount++;
          log({ t: Date.now(), level: 'warn', msg: step.id + ' 写操作放行（本次运行第 ' + writeCount + '/' + writeQuota(spec) + ' 次）' });
        }
        if (step.mode === 'human') {
          throw new RunnerError('E_PERM', 'human 断点原语 v0.2 提供，本步骤无法执行: ' + step.id);
        }
        if (step.mode === 'navigate') {
          const nav = await execNavigate(spec, step, scope, extracted, stepLogs, log, onStep, i, params);
          if (nav && nav.sameTab) {
            /* 同标签交接：本流程已经结束，页面正在被下一个环节接管。
             * 不能走下面「导航已发起，请点执行续跑」的提示——那句是给「本流程还要在同一
             * 页面继续跑」用的，在这里会让人以为流程没跑完、又去点一次执行。 */
            log({ t: Date.now(), level: 'ok', msg: '=== ' + step.id + ' 已把当前标签页交给下一环节，本流程结束 ===' });
            continue;
          }
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
        if (step.mode === 'ui') {
          await execUi(spec, step, scope, stepLogs, log, onStep, i, extracted, params);
          scope = buildScope(spec, params, extracted, vars);
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
        /* 自带错误码且声明 noOnFail/human 的（人工闸门、闸门条件判不出）不走 on_fail：
         * on_fail 是「这一步的正常失败该怎么向业务解释」的模板，而这两种情况本身
         * 已经把原因说清楚了，再套模板就会把「组织满员」写成「组织没找到」。 */
        if (e && e.code && (e.noOnFail || e.human)) {
          log({ t: Date.now(), level: e.human ? 'warn' : 'fatal', msg: step.id + (e.human ? ' 中止: [' : ' 失败: [') + e.code + '] ' + e.message });
          const re = new RunnerError(e.code, e.message);
          if (e.human) re.human = true;
          throw re;
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

  /* UI 步骤执行：纯页面填充（click/type/wait），无网络请求、无写操作。
   * 选择器与取值全部来自 spec 的 step.ui.actions（业务知识在 spec，引擎只做原语）。 */
  async function execUi(spec, step, scope, stepLogs, log, onStep, idx, extracted, params) {
    onStep(step.id, 'running');
    const ui = step.ui || {};
    const t0 = Date.now();
    log({ t: t0, level: 'info', msg: step.id + ' → 页面填充（' + ((ui.actions) || []).length + ' 个动作，间隔 ' + (Number(ui.gap_ms) || 400) + 'ms）' });
    /* 点击可能整页跳走（例如「去登录」跳到 CAS 登录页）：续跑状态必须在**点之前**写进运行态，
     * 否则页面一卸载就再没人执行后面的步骤。哪个动作会跳，由该动作自己的 nav_after 声明
     * （不是整个 step）——因为同一个 step 里往往还有「元素不存在就跳过」的可选点击。
     * 动作若没真的跳走，这里要把状态回滚并报错：不能留一个永远等不到落地的运行态。 */
    const navWrote = { on: false };
    function clearNav() {
      const sb = RunState.get() || {};
      sb.phase = 'running'; delete sb.navExpect; delete sb.navStepId; RunState.set(sb);
      navWrote.on = false;
    }
    try {
      const rd = await ENGINE.execUiActions(ui.actions || [], scope, {
        gap_ms: ui.gap_ms,
        ready_timeout_ms: ui.ready_timeout_ms,
        log: function (m) { log({ t: Date.now(), level: 'info', msg: step.id + ' · ' + m }); },
        onNavBefore: function (expect) {
          const stn = RunState.get() || {};
          stn.phase = 'await_nav_check';
          stn.navStepId = step.id;
          stn.navExpect = expect;
          stn.navAt = Date.now();
          stn.stepLogs = stepLogs;
          /* 参数与产物必须随行：跳走之后新页面要靠它们续跑（record_id、邮箱后缀…）。
           * 少了这一行，续跑起来 params 是空的，连 record_id 都解析不出来。 */
          stn.params = persistableParams(spec, params);
          stn.extracted = extracted || {};
          RunState.set(stn);
          navWrote.on = true;
          log({ t: Date.now(), level: 'info', msg: step.id + ' 预期整页跳转（' + JSON.stringify(expect) + '），已预写续跑状态（参数 ' +
            Object.keys(stn.params || {}).length + ' 个、产物 ' + Object.keys(stn.extracted || {}).length + ' 项）' });
        },
        onNavAfter: function (ok) { if (!ok) clearNav(); },
      });
      /* read 动作的产物进步骤抽取，key 用「步骤ID.变量名」——与 api 步骤的抽取同一条通道，
       * 因此 outputs / 回写模板都能直接用 {{S3.account_email}} 引用。 */
      if (rd && typeof rd === 'object' && Object.keys(rd).length) {
        const ks = Object.keys(rd);
        ks.forEach(function (k) { if (extracted) extracted[step.id + '.' + k] = rd[k]; });
        log({ t: Date.now(), level: 'info', msg: step.id + ' 读取页面值：' + ks.map(function (k) { return k + '=' + rd[k]; }).join('，') });
      }
    } catch (e) {
      if (navWrote.on) clearNav();
      onStep(step.id, 'fail');
      stepLogs.push({ id: step.id, ms: Date.now() - t0, error: e.message });
      throw e; // 交给 runSpec 的 catch 走 on_fail / RunnerError 通道
    }
    stepLogs.push({ id: step.id, ms: Date.now() - t0 });
    onStep(step.id, 'done');
    log({ t: Date.now(), level: 'ok', msg: step.id + ' ✓ 页面填充完成（共 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's）' });
  }

  async function execApi(spec, step, scope, extracted, stepLogs, log, onStep, idx, gate) {
    onStep(step.id, 'running');
    const url = ENGINE.resolvePlaceholders(step.request.url, scope);
    const headers = ENGINE.resolvePlaceholders(step.request.headers || {}, scope);
    const bodyText = step.request.body !== undefined
      ? JSON.stringify(ENGINE.resolvePlaceholders(step.request.body, scope)) : undefined;
    const noRetry = isNoRetryPath(spec, url);
    // 缓存键必须含完整请求体内容（哈希）。2026-11-02 事故：旧键用 bodyText.length，
    // 两个不同 corpId 长度相同 → A 户的 S1 响应被 B 户命中（串户级）。
    const bodyKey = ENGINE.strHash((bodyText || '') + '\u0001' + url);

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
      // 业务错误信息优先（errorMsg/message）——回写「错误类型」列才能给出人话而不是裸 "HTTP 500"
      let bizMsg = '';
      try {
        const j = JSON.parse(res.text);
        bizMsg = String(j.errorMsg || j.message || '').trim();
        snippet = JSON.stringify(ENGINE.redact(j)).slice(0, 200);
      } catch (e) { /* 非 JSON 原样截断 */ }
      const head = 'HTTP ' + res.status + (bizMsg ? '（' + bizMsg.slice(0, 80) + '）' : '');
      if (res.status === 401 || res.status === 403) throw new RunnerError('E_SESSION', head + '，会话可能已失效｜响应: ' + snippet);
      throw new RunnerError('E_NETWORK', head + '｜响应: ' + snippet);
    }
    if (step.cache_ttl_sec) StepCache.put(spec.spec_id, step.id, bodyKey, json, step.cache_ttl_sec);
    return applyResponse(spec, step, json, scope, extracted, stepLogs, log, onStep, false);
  }

  function applyResponse(spec, step, json, scope, extracted, stepLogs, log, onStep, fromCache) {
    // 断言（项可字符串或 {assert, on_fail} 对象——项级 on_fail 优先于步骤级，message 支持响应模板）
    const assertResults = [];
    for (const a of step.assert || []) {
      const expr = (a && typeof a === 'object') ? a.assert : a;
      let r;
      try { r = ENGINE.evalAssert(expr, json, scope); }
      catch (e) { r = { pass: false, detail: e.message }; }
      assertResults.push({ assert: expr, pass: r.pass, detail: r.detail });
      if (!r.pass) {
        const of = ENGINE.assertOnFail(a, step, json);
        onStep(step.id, 'failed');
        log({ t: Date.now(), level: 'fatal', msg: step.id + ' 断言失败: ' + expr + '（' + r.detail + '）' });
        log({ t: Date.now(), level: 'info', msg: step.id + ' 响应快照: ' + JSON.stringify(ENGINE.redact(json)).slice(0, 600) });
        throw new RunnerError(of.error || 'E_ASSERT', (of.message || '断言失败: ' + expr) + '｜' + r.detail);
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

  /* 落盘的参数副本：剔除 secret（本地存储是明文的，密码不落盘），续跑时再 /task 补回来。
   * 运行态以前根本没存过 params —— 只有 navigate 分支存了 extracted，于是「退出登录导致跳转」
   * 这条路上续跑起来 params 是空的，连 record_id 都解析不出来，S7 直接 E_SPEC。
   * 单点跳转（点「去登录」那种）一直没暴露，因为那些步骤跳过去就结束了，不需要参数。 */
  function persistableParams(spec, params) {
    const out = {};
    const sec = {};
    (spec.params || []).forEach(function (p) { if (p && p.secret === true) sec[p.name] = 1; });
    Object.keys(params || {}).forEach(function (k) { if (!sec[k]) out[k] = params[k]; });
    return out;
  }

  async function execNavigate(spec, step, scope, extracted, stepLogs, log, onStep, idx, params) {
    // navigate 前必须先把运行态落盘（导航会销毁当前 JS 环境）
    const url = ENGINE.resolvePlaceholders(step.url, scope);
    if (!/^https:\/\//.test(url)) throw new RunnerError('E_SPEC', 'navigate 目标非法: ' + url);

    /* ── 交接（handoff）：本流程结束后，下一段流程在新标签页里接着跑 ──────────────
     * 为什么需要独立语义：跨的是「业务环节」，不是「一次页面跳转」。下一段是另一个 spec、
     * 另一套账号体系（管理台 → 广告平台），recordId 在新页面 URL 上不存在（邀请链接只带
     * inviteCode），只能由本流程显式把它交出去。
     * 与 open:new-tab 的区别：那个是「本流程在新标签页继续跑」，这个「本流程到此为止，
     * 新标签页是下一条流水线的起点」——所以不写 await_nav_check，本页后续步骤（如退出登录）
     * 照常执行，最后正常 final + 回写。
     * 交出去的东西：record_id + 下游 script_id + 白名单参数（凭据绝不随行，下游自己 /task 取）。 */
    const handoff = (step.handoff && step.handoff.script_id) ? step.handoff : null;
    if (handoff) {
      const st0h = RunState.get() || {};
      const task0 = st0h.task || UI.currentTask || {};
      const rid = String(task0.record_id || ENGINE.resolvePlaceholders('{{record_id}}', scope) || '');
      if (!rid) throw new RunnerError('E_SPEC', 'handoff 需要 record_id：本流程没有任务上下文（standalone 直接跑无法交接到下一条流水线）');
      const nextId = String(handoff.script_id);
      const keep = Array.isArray(handoff.params) ? handoff.params : [];
      const cp = {};
      for (let i = 0; i < keep.length; i++) {
        const k = keep[i];
        let v = scope[k];
        /* 随行参数常常是**本流程算出来的产物**而不是表里的列（例如 account_email =
         * 前缀 + 页面带出的后缀）。这类值只存在于 outputs 里，scope 里没有——
         * 0.9.6 只查 scope，日志里就出现过「随行参数 无」，交接白带了一趟，
         * 全靠表里已回写才没出事。这里按 outputs 再解析一次兜底。 */
        if ((v === undefined || v === null || String(v) === '') && spec.outputs && spec.outputs[k] !== undefined) {
          try { v = ENGINE.resolvePlaceholders(spec.outputs[k], scope); } catch (e) { v = ''; }
        }
        if (v !== undefined && v !== null && String(v) !== '') cp[k] = String(v);
      }
      let host = '';
      try { host = new URL(url).host; } catch (e) { throw new RunnerError('E_SPEC', 'handoff 目标 URL 非法: ' + url); }
      /* 交接前先把本段结果写进业务表：下一段流程要读表（P3 的「邮箱账号」就是刚建的成员），
       * 等本流程彻底结束再写就晚了——交接已经把下一个标签页打开了。
       * 写失败不阻断交接（失败会进本地待写队列），因为随行参数里带了同一个值兜底。 */
      const stw = RunState.get() || {};
      /* wbDone 存在 = 本次运行已经写过表（例如「交接准备 defer」先写、「同标签交接」再跳）。
       * 没有这个判断，两步式交接会把同一份结果写两遍——飞书那边是覆盖，看不出错，
       * 但会多一次写请求、且失败重试队列里可能出现两条互相矛盾的记录。 */
      if (stw.task && stw.task.record_id && wbModeOf(spec) === 'auto' && !stw.wbDone) {
        const outs = {};
        Object.keys(spec.outputs || {}).forEach(function (k) {
          try { outs[k] = ENGINE.resolvePlaceholders(spec.outputs[k], scope); } catch (e) { outs[k] = ''; }
        });
        /* 默认「先落盘、后台写」：交接之后的步骤（退出登录、跳下一环节）不依赖表，
         * 没理由陪服务端在那里串行打三次飞书（真机最长 48.9s，这段时间页面上什么都不能做）。
         * 只有下一段**只能读表**、随行参数又带不全时，才在 spec 里写 handoff.wait_write: true
         * 退回同步等——这是场景可选的例外，不是默认。 */
        const bgWrite = handoff.wait_write !== true;
        log({ t: Date.now(), level: 'info', msg: step.id + ' 交接准备：' +
          (bgWrite ? '先存本机队列、后台回写业务表（不阻塞，页面继续退出/跳转）…'
            : '先把本次结果回写业务表（本场景声明 wait_write，下一段只能读表）…') });
        const wr = await pushTaskResult(stw, true, outs, null, bgWrite ? { background: true } : undefined);
        /* 绝不能写成 stw.final：收尾轮询器（setInterval 1500ms）只看 final，一看到就播报
         * 「流程完成」并 RunState.clear()——而交接步骤后面还有步骤要跑（退出登录）。
         * 2026-11-06 基线录制时就是这么踩到的：S6 一条日志都没有，横幅却已显示完成。
         * 换成独立标记 wbDone，由 doRun 收尾时合并进 final。 */
        stw.wbDone = {
          ok: true, outputs: outs, at: Date.now(), specId: spec.spec_id,
          written: !!(wr && wr.written), queued: !!(wr && wr.queued), background: !!(wr && wr.background),
        };
        RunState.set(stw);
        if (stw.wbDone.queued) {
          /* 后台模式：这条日志是人唯一能看到「已经安排上了」的地方，必须说清两件事——
           * 表里此刻还没写；被打断也不用管（下个页面会自己补）。 */
          log({
            t: Date.now(), level: 'info',
            msg: step.id + ' 结果已入本机队列，后台回写中（表里此刻可能还是旧状态）：' +
              '写成功会自动出队；若被本站退出/跳转打断，下一个页面启动时会自动补写，不用手动点',
          });
        } else if (!stw.wbDone.written) {
          /* 同步模式写失败不阻断交接（随行参数兜着），但**必须说清后果**：真机上这里只留了一条
           * 「已存本地待写队列」，人以为流程照常完成了，实际表里还是旧状态、没有邮箱账号。
           * 后一段流程若超过 10 分钟才跑，交接上下文已过期，它就拿不到账号只能失败。 */
          log({
            t: Date.now(), level: 'warn',
            msg: step.id + ' 回写没成功（已存本地待写队列）：表里此刻仍是旧状态，邮箱账号等产物还没进表；' +
              '本次交接靠随行参数继续，但**跑完请点「重试回写」补写**，否则下一条记录/超时后再来会取不到这些值',
          });
        }
      }
      /* params_complete：告诉下游「这份参数是齐的，够你跑，不必再查表」。
       * 只有 spec 在 handoff 上显式声明 params_complete:true 才写——是否「齐」是业务判断，
       * 引擎不知道下游需要哪些字段，猜着标会让下游拿着缺项硬跑。
       * display 一并带过去，下游面板还能显示「组织/成员姓名」这类标签。 */
      SVC.pendSet({
        record_id: rid, script_id: nextId, params: cp, handoff: true,
        params_complete: handoff.params_complete === true,
        display: (task0 && task0.display) || null,
      }, host);
      const hdMode = handoff.defer === true ? 'defer' : (step.open === 'same-tab' ? 'same-tab' : 'new-tab');

      /* ── defer：只把交接上下文与回写准备好，不打开任何页面 ─────────────────────
       * 用途是「两段式交接」：业务要求先退出当前账号、再进下一环节（否则下一个标签页
       * 的会话会被退出动作一起清掉）。但退出是一次整页跳转，跳完运行态就没了，
       * 所以回写和交接上下文必须在**退出之前**落盘——这一步干这个，然后流程继续。 */
      if (hdMode === 'defer') {
        log({ t: Date.now(), level: 'info', msg: step.id + ' ⇢ 交接上下文已备好（记录 ' + rid +
          '，随行参数 ' + (Object.keys(cp).join(',') || '无') + '），本步不打开页面——由后续步骤先退出、再跳转' });
        stepLogs.push({
          id: step.id, name: step.name, mode: 'navigate', fromCache: false,
          assertResults: [{ assert: 'handoff.defer(script_id=' + nextId + ')', pass: true, detail: '已写入交接上下文与回写，未打开页面' }], extract: {},
        });
        onStep(step.id, 'passed');
        return { initiated: false, handoff: true, deferred: true, stepId: step.id };
      }

      /* ── same-tab：本流程到此结束，用当前标签页进入下一环节 ─────────────────
       * 为什么先清运行态：本页跳过去就是下一段流水线的起点（P3 会在那儿按 trigger 认领），
       * 若留下 phase=await_nav_check，本场景脚本在新页面注入后会以为自己还要续跑，
       * 跟下一个场景抢同一个页面。用 replace 而非 href：不给人留一条「后退回已退出页面」的历史。 */
      if (hdMode === 'same-tab') {
        /* 冻结 + 清空：本页马上被替换成下一段流程的起点，之后任何一次 log()/final 广播都不许
         * 再把运行态写回来。0.9.8 只 clear 没冻结，S7 自己那条日志随即把旧的 await_nav_check
         * 复活，新页面就拿它去续跑 P2 的 S6（真机 16:07 的整段混乱都出自这里）。 */
        RunState.freeze();
        RunState.clear();
        log({ t: Date.now(), level: 'info', msg: step.id + ' ⇢ 交接给「' + nextId + '」（记录 ' + rid +
          '，随行参数 ' + (Object.keys(cp).join(',') || '无') + '），本页跳转 ' + maskUrl(url) + '（本流程结束）' });
        stepLogs.push({
          id: step.id, name: step.name, mode: 'navigate', fromCache: false,
          assertResults: [{ assert: 'handoff.same-tab(script_id=' + nextId + ')', pass: true, detail: '已写入交接上下文并替换当前标签页' }], extract: {},
        });
        onStep(step.id, 'passed');
        await sleep(200);
        const hrefBefore = String(location.href);
        try { location.replace(url); } catch (e) { try { location.href = url; } catch (e2) {} }
        await sleep(600);
        /* 跳转没生效时**不抛异常**：这已经是本流程最后一步，抛了也只是把横幅变红。
         * 给一条能照着做的提示更有用——表已回写、交接上下文已在本地，人手动点一下表里的
         * 「开户邀请链接」，下一个场景 10 分钟内仍会认领这条记录。 */
        if (String(location.href) === hrefBefore) {
          log({ t: Date.now(), level: 'warn', msg: step.id + ' 当前标签页没有跳转：请手动打开表里的「开户邀请链接」继续开户（交接上下文已备好，10 分钟内有效）' });
        } else {
          log({ t: Date.now(), level: 'ok', msg: step.id + ' ✓ 已跳转 ' + maskUrl(String(location.href)) });
        }
        return { initiated: true, handoff: true, sameTab: true, stepId: step.id };
      }

      log({ t: Date.now(), level: 'info', msg: step.id + ' ⇢ 交接给「' + nextId + '」（记录 ' + rid +
        '，随行参数 ' + (Object.keys(cp).join(',') || '无') + '），打开 ' + maskUrl(url) + '（本页继续走完剩余步骤）' });
      onStep(step.id, 'navigating');
      const wh = window.open(url, '_blank');
      if (!wh) {
        /* 弹窗被拦时不能「假装交接成功」：下游根本没打开，本流程再正常结束就会让人
         * 以为开户流程已经开始了。这里直接终止，页面保留，人可以允许弹窗后重跑。 */
        log({ t: Date.now(), level: 'fatal', msg: step.id + ' 新标签页被浏览器拦截：请允许本站弹窗后重跑本流程（否则下一段不会开始）' });
        throw new RunnerError('E_NAV_POPUP', '交接需要打开新标签页，但被浏览器拦截了（未授权弹窗）');
      }
      try { sessionStorage.setItem('masrTransit', '1'); } catch (e) {}
      stepLogs.push({
        id: step.id, name: step.name, mode: 'navigate', fromCache: false,
        assertResults: [{ assert: 'handoff(script_id=' + nextId + ')', pass: true, detail: '已写入交接上下文并打开新标签页' }], extract: {},
      });
      onStep(step.id, 'passed');
      await sleep(400);
      return { initiated: false, handoff: true, openedTab: true, stepId: step.id };
    }

    const newTab = step.open === 'new-tab';
    log({ t: Date.now(), level: 'info', msg: step.id + ' → ' + (newTab ? '新标签页打开 ' : '导航 ') + maskUrl(url) + '（运行态已保存）' });
    onStep(step.id, 'navigating');
    const st = RunState.get() || {};
    st.phase = 'await_nav_check';
    st.navStepId = step.id;
    st.navExpect = step.expect || {};
    st.navAt = Date.now();
    st.extracted = extracted;   // 产物随行：落地页续跑时恢复变量表
    st.params = persistableParams(spec, params);   // 参数随行（secret 剔除，续跑时重新取）
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
    /* 续跑补凭据：运行态落盘时会剔除 secret 参数（本地存储是明文的，密码不落盘）。
     * 跨页续跑的场景（如「点去登录 → 登录页继续填」）因此拿不到密码——这里按记录重新向
     * 服务端取一次，而不是把凭据写进存储。取不到就如实记录，由后续步骤报「值为空」。 */
    try {
      const need = (spec.params || []).filter(function (p) { return p.secret === true && !params[p.name]; });
      if (need.length) {
        const rid = (st.task && st.task.record_id) || params.record_id || '';
        const sid = (st.task && st.task.script_id) || spec.spec_id;
        if (rid) {
          const tCred = Date.now();
          const fresh = await SVC.record(rid, sid);
          const credMs = Date.now() - tCred;
          const fp = (fresh && fresh.params) || {};
          const got = [];
          need.forEach(function (p) { if (fp[p.name]) { params[p.name] = fp[p.name]; got.push(p.name); } });
          log({ t: Date.now(), level: got.length ? 'info' : 'warn',
            msg: got.length ? '续跑已重新取回凭据参数：' + got.join(',') + '（未落本地存储）'
              : '续跑需要凭据参数 ' + need.map(function (p) { return p.name; }).join(',') + '，但 /task 没有下发（表里为空？）' });
          if (credMs > 800) log({ t: Date.now(), level: 'info',
            msg: '续跑取凭据耗时 ' + (credMs / 1000).toFixed(1) + 's（/task 往返；凭据不落盘，只能重新取）' });
        }
      }
    } catch (e) {
      log({ t: Date.now(), level: 'warn', msg: '续跑补取凭据失败：' + e.message + '（后续步骤可能因参数为空停下）' });
    }
    // 导航步骤也进步骤表/日志（步骤表 ✓ 与结果导出完整）
    (st.stepLogs = st.stepLogs || []).push({
      id: st.navStepId, name: step.name, mode: 'navigate', fromCache: false,
      assertResults: [{ assert: 'expect(url_contains+cookie_exists)', pass: true, detail: '落地校验通过' }],
      extract: {},
    });
    /* 不能在这里 RunState.clear()：后面每一条 log() 都会把闭包里这份状态原样写回（RunState.set(st)），
     * 等于「刚清掉又活过来」，而且 phase 仍然是 await_nav_check —— 下一个页面会把它当成
     * 「还要续跑」。0.9.9 改成把阶段推进到 running：既不会再被当落点续跑，又保住
     * task/runId/stepLogs 供本次收尾正常回写（清空会让收尾拿到空对象，写表直接丢掉）。 */
    st.phase = 'running';
    delete st.navExpect;
    delete st.navStepId;
    RunState.set(st);
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
    // 续跑（navigate 恢复）时，fromIdx 之前的步骤已经跑过了，把它们的写操作计入已用量。
    // 宁可少数一次也不多数一次：配额是防重复提交的最后一道闸，算宽了等于没有。
    let writeCount = spec.steps.slice(0, fromIdx).filter(function (s) { return s && s.write === true; }).length;
    for (let i = fromIdx; i < spec.steps.length; i++) {
      const step = spec.steps[i];
      ensureStepVars(spec, step, vars);
      scope = buildScope(spec, params, extracted, vars); // 懒派生后重建作用域
      if (step.write === true) {
        const wchk = checkWriteAllowed(spec, step, writeCount, false);
        if (!wchk.ok) throw new RunnerError('E_PERM', wchk.msg);
        writeCount++;
      }
      if (step.mode === 'ui') { await execUi(spec, step, scope, stepLogs, log, () => {}, i, extracted, params); continue; }
      if (step.mode === 'navigate') {
        const nav = await execNavigate(spec, step, scope, extracted, stepLogs, log, () => {}, i, params);
        /* 同标签交接＝本流程终点，继续往下走把 outputs 算出来正常收尾（不回 navInitiated）。 */
        if (nav && nav.sameTab) continue;
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
        font:12px/1.6 -apple-system,'Segoe UI',sans-serif;padding:0 12px 12px;display:none;
        /* 面板挂在别人的页面上：宿主若声明了 color-scheme:dark，UA 会给 button/input 用
         * 深色主题的系统色（白字），而我们只设了背景 → 白底白字，字直接看不见。
         * 这里锁死 light，并把所有元素的 -webkit-text-fill-color 归位到自身 color
         * （该属性可继承，宿主在 body 上设一次就会洗掉面板里所有文字）。 */
        color-scheme:light}
      #masr-panel, #masr-panel *{-webkit-text-fill-color:currentColor}
      #masr-panel a{color:#1a66ff}
      #masr-panel h3{margin:2px 0 8px;font-size:13px}
      /* --- 顶部：两行，第一行身份/版本，第二行业务脚本（版本号拆开，避免互相混淆） --- */
      #masr-head{position:sticky;top:0;z-index:5;margin:0 -12px 8px;padding:9px 12px 7px;
        background:#f7f9fc;border-bottom:1px solid #e3e8f0;border-radius:10px 10px 0 0}
      #masr-head .h-row{display:flex;align-items:center;gap:6px;min-height:22px;overflow:hidden}
      #masr-head .h-row+.h-row{margin-top:5px}
      #masr-head .brand{font-size:12.5px;font-weight:700;color:#243447;letter-spacing:.2px;white-space:nowrap}
      #masr-head .brand i{font-style:normal;color:#1a66ff}
      #masr-head .grow{flex:1 1 auto}
      #masr-head .lbl{font-size:10.5px;color:#8f959e;white-space:nowrap}
      .masr-chip{display:inline-block;padding:0 6px;border-radius:9px;font-size:10.5px;line-height:16px;
        border:1px solid #dfe3ec;background:#fff;color:#5a6b87;white-space:nowrap;vertical-align:middle}
      .masr-chip.runner{border-color:#ccdaf5;background:#eef4ff;color:#1a5fd0;font-weight:600}
      .masr-chip.spec{border-color:#c7e6d6;background:#eefaf3;color:#11713f;font-weight:600}
      .masr-spec-name{font-size:12px;font-weight:600;color:#1f2d3d;max-width:185px;overflow:hidden;
        text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:middle}
      .masr-mini{font-size:11px!important;padding:2px 7px!important;line-height:16px!important}
      .masr-upd{font-size:11px;color:#666;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:210px}
      #masr-panel textarea{width:100%;height:110px;font:11px/1.5 Consolas,monospace;box-sizing:border-box}
      #masr-panel .row{margin:6px 0}
      #masr-panel button{margin-right:6px;padding:3px 10px;border:1px solid #bbb;border-radius:6px;background:#f6f7fa;color:#1f2d3d;cursor:pointer;font-size:12px}
      #masr-panel button.primary{background:#1a66ff;color:#fff;border-color:#1a66ff}
      #masr-panel button:disabled{color:#7a828c;background:#eceef2;border-color:#d4d7de;cursor:default}
      #masr-panel .log{background:#101418;color:#d7e8ff;font:11px/1.5 Consolas,monospace;padding:8px;border-radius:8px;
        max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-all;color-scheme:dark}
      #masr-panel .ok{color:#63d193}.fatal{color:#ff8b8b}.warn{color:#ffc266}
      #masr-panel table{border-collapse:collapse;width:100%}
      #masr-panel td,#masr-panel th{border:1px solid #e3e3ec;padding:2px 6px;text-align:left;font-size:11px}
      #masr-panel input,#masr-panel textarea{padding:2px 6px;border:1px solid #c6cad2;border-radius:4px;width:200px;
        background:#fff;color:#1f2d3d;color-scheme:light}
      #masr-panel input::placeholder,#masr-panel textarea::placeholder{color:#6b7785;opacity:1}
      #masr-panel input:disabled,#masr-panel textarea:disabled{background:#f3f4f7;color:#6b7785}
      .masr-tag{display:inline-block;padding:0 6px;border-radius:8px;font-size:10px;margin-left:6px}
    `;
    document.head.appendChild(css);

    const ball = document.createElement('div');
    ball.id = 'masr-ball'; ball.textContent = 'MAS';
    ball.title = 'MAS-Runner v' + GV.RUNNER_VERSION + '（点击打开/收起）';
    const panel = document.createElement('div');
    panel.id = 'masr-panel';
    panel.innerHTML = `
      <div id="masr-head">
        <div class="h-row">
          <span class="brand">MAS <i>Runner</i></span>
          <span class="masr-chip runner" id="masr-runner-ver" title="解释器版本（Tampermonkey 里安装的这个脚本）">v0.4.7</span>
          <span class="grow"></span>
          <span class="masr-upd" id="masr-update-out"></span>
          <button class="masr-mini" id="masr-check-update" title="检查解释器有没有新版本">检查更新</button>
          <button class="masr-mini" id="masr-dev-toggle" title="手工粘贴 spec.json（仅调试用）">dev</button>
        </div>
        <div class="h-row" title="业务脚本 = 这一步要跑的 spec（版本由业务方维护，与解释器版本无关）">
          <span class="lbl">业务脚本</span>
          <span id="masr-spec-badge"><span class="lbl">未加载</span></span>
          <span class="grow"></span>
          <button class="masr-mini" id="masr-spec-upgrade" title="联网强制同步：场景触发规则（绕开 10 分钟缓存）+ 当前业务脚本的最新 spec（绕开本地缓存）。流程执行中不允许点。">同步 spec</button>
        </div>
      </div>
      <div class="row" id="masr-selfcheck"></div>
      <div class="row" id="masr-tasks" style="border:1px solid #d6e4ff;background:#f7faff;border-radius:8px;padding:6px 8px"></div>
      <div class="row" id="masr-conn" style="border:1px solid #e5e6eb;border-radius:8px;padding:6px 8px"></div>
      <div class="row" id="masr-spec-box" style="display:none"><b>spec.json（开发调试用，正常不用碰）</b><br></div>
      <div class="row" id="masr-dev-tools" style="display:none">
        <div class="row" style="margin-bottom:6px">
          <button class="primary" id="masr-load">加载 spec</button>
          <button id="masr-hash">计算 SHA-256</button>
          <span id="masr-hash-out"></span>
        </div>
        <div class="row" style="margin-bottom:6px">
          <button class="primary" id="masr-run" title="手工重跑当前加载的 spec（调试用；正常走任务区的「执行」）">重跑当前 spec</button>
          <button id="masr-export" title="把上次运行结果导出为 JSON（调试排查用）">导出结果 JSON</button>
        </div>
        <div class="row" id="masr-dev-conn" style="border:1px dashed #d6e4ff;border-radius:8px;padding:6px 8px"></div>
        <div class="row" style="margin-top:6px">
          <button id="masr-dev-unbind" title="换人/换电脑用：接入码、身份缓存、授权码一起清掉，回到首次绑定状态">解除绑定（换人用这台电脑）</button>
          <span style="font-size:11px;color:#8f959e">清除本机绑定信息，不影响已回写的结果</span>
        </div>
      </div>
      <div class="row" id="masr-params"></div>
      <div class="row">
        <button id="masr-cancel-run" title="续跑卡住时用：清掉本机的续跑进度（不影响线上数据）">清除续跑状态</button>
        <button id="masr-copy-logs" title="把全部日志（含历史，带时间戳）复制为纯文本，方便贴给同事或发群里排查">复制日志</button>
        <button id="masr-clear-logs">清空日志</button>
      </div>
      <div class="row"><b>步骤时间线</b><div id="masr-steps"></div></div>
      <div class="row"><b>日志</b><div class="log" id="masr-log"></div></div>
      <div class="row" id="masr-result"></div>
    `;
    document.body.appendChild(ball); document.body.appendChild(panel);
    UI.makeSpecInput();
    ball.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
      if (panel.style.display === 'block') {
        UI.renderSelfCheck();
        UI.autoCheckUpdate(10 * 60 * 1000); // 打开面板顺手看一眼有没有新版（10 分钟内不重复请求）
        maybeReloadAfterUpdate();
      }
    });

    document.getElementById('masr-dev-toggle').addEventListener('click', function () {
      const box = document.getElementById('masr-spec-box');
      const tools = document.getElementById('masr-dev-tools');
      const on = box.style.display === 'none';
      box.style.display = on ? '' : 'none';
      tools.style.display = on ? '' : 'none';
      UI.devOn = on;
      this.style.background = on ? '#e8f3ff' : '';
      if (on) UI.renderConn(); // dev 展开时把后端地址编辑区一并渲染出来
    });

    document.getElementById('masr-dev-unbind').addEventListener('click', function () {
      if (!confirm('解除绑定：接入码、身份缓存、授权码全部清除（换人用这台电脑时用）。\\n确定继续？')) return;
      GM_deleteValue(SVC.C_KEY); GM_deleteValue(SVC.M_KEY);
      clearAuthCode();
      UI.appendLog({ t: Date.now(), level: 'warn', msg: '已解除绑定（本机绑定信息已清除），回到首次绑定状态' });
      UI.renderTasks();
    });

    document.getElementById('masr-load').addEventListener('click', () => {
      UI.applySpec(UI.getSpecText(), {});
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
    document.getElementById('masr-spec-upgrade').addEventListener('click', () => UI.forceSyncSpec());
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
    document.getElementById('masr-copy-logs').addEventListener('click', UI.copyLogs);
    document.getElementById('masr-clear-logs').addEventListener('click', UI.clearLogs);
    document.getElementById('masr-check-update').addEventListener('click', function () {
      if (UI._newVer) UI.startUpdate(); else UI.checkUpdate();
    });
    UI.panel = panel;
    UI.renderHead();
  };

  /* 顶部第一行：解释器版本号（GM_info 为准，取不到才用内嵌常量） */
  UI.installedVersion = function () {
    try {
      if (typeof GM_info !== 'undefined' && GM_info && GM_info.script && GM_info.script.version) {
        return String(GM_info.script.version);
      }
    } catch (e) {}
    return GV.RUNNER_VERSION;
  };
  UI.renderHead = function () {
    const el = document.getElementById('masr-runner-ver');
    const v = UI.installedVersion();
    if (el) { el.textContent = 'v' + v; el.title = '解释器版本 v' + v + '（Tampermonkey 里安装的脚本；业务脚本版本见下一行）'; }
  };

  /* 顶部第二行：业务脚本（spec）身份 —— 与解释器版本分开显示，谁的问题一眼可辨 */
  UI.renderSpecBadge = function (spec) {
    const badge = document.getElementById('masr-spec-badge');
    if (!badge) return;
    if (!spec) { badge.innerHTML = '<span class="lbl">未加载</span>'; return; }
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const okSpec = spec.status === 'active';
    badge.innerHTML =
      '<span class="masr-spec-name" title="' + esc(spec.spec_id + ' v' + spec.version) + '">' + esc(spec.spec_id) + '</span>' +
      ' <span class="masr-chip spec" title="业务脚本版本（spec 自带，随业务方发版）">v' + esc(spec.version) + '</span>' +
      ' <span class="masr-chip" style="' + (okSpec ? 'border-color:#c7e6d6;background:#eefaf3;color:#11713f' : 'border-color:#f0dcb0;background:#fff8e8;color:#8a6412') + '">' + esc(spec.status) + '</span>' +
      (spec.owner ? ' <span class="lbl">owner ' + esc(spec.owner) + '</span>' : '');
  };

  /* 手动同步（0.9.22）：一个显式入口把「触发规则」和「业务脚本」都强制拉到线上最新。
   * 为什么需要：spec 是三级缓存（内存 → 本地持久 → 联网），TTL 只看 7 天陈旧，
   * 平时刷新页面**不会**重取——不跑任务就永远看不到新版（2026-11-09 用户报：发布 0.4.4
   * 后刷新页面面板仍是 0.4.3）。场景列表另有 10 分钟 TTL，触发规则发新版后同理。
   * 语义刻意做成「强制」：绕开两级 TTL，失败不清缓存（旧版还能跑，只是没升上去），
   * 流程执行中直接拒绝（跑一半换 spec 会让后续步骤与已执行步骤错位）。 */
  /* 同步失败的原因要说人话（0.9.23）：E_SVC_TIMEOUT 是**真的等到点**，不是「不需要更新」。
   * 2026-11-09 用户看到三条 TIMEOUT 在问到底怎么回事——日志间隔正好 20.0s，是 GM 请求预算耗尽；
   * 真因是当时把 7 个场景全拉了一遍，那三个根本不用同步。 */
  UI.syncErrText = function (e) {
    const m = String((e && e.message) || '');
    if (/E_SVC_TIMEOUT/.test(m)) return '取 spec 超时（45 秒内没返回，后端/链路慢）：过一会儿再点一次，旧缓存仍在';
    if (/E_NOT_FOUND/.test(m)) return '线上没有发布这个场景的 spec（404，不是超时）';
    if (/E_SVC_WATCHDOG/.test(m)) return '脚本管理器网络通道无响应（已自动重发一次）：刷新页面再试';
    if (/E_SVC_NET/.test(m)) return '连不上后端（网络层直接失败）：先确认服务在跑';
    return m;
  };

  UI.forceSyncSpec = async function () {
    const btn = document.getElementById('masr-spec-upgrade');
    if (UI._running) {
      UI.appendLog({ t: Date.now(), level: 'warn', msg: '正在执行流程：等这一趟跑完再同步 spec（跑到一半换 spec 会让后面的步骤对不上）' });
      return;
    }
    const oldLabel = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '同步中…'; }
    const T0 = Date.now();
    try {
      UI.appendLog({ t: Date.now(), level: 'info', msg: '开始同步：场景触发规则 + 业务脚本 spec（联网，绕开本地缓存）' });
      // ① 场景触发规则：强刷（绕 10 分钟 TTL）。失败不致命——最多是触发规则旧，spec 仍可同步。
      let scenes = [];
      try {
        scenes = await SVC.scenes(true);
        UI.appendLog({ t: Date.now(), level: 'ok', msg: '场景触发规则已同步（' + scenes.length + ' 个场景）' });
      } catch (e) {
        UI.appendLog({ t: Date.now(), level: 'warn', msg: '场景触发规则同步失败（' + e.message + '）：继续同步 spec，触发规则仍是本机旧版' });
      }
      /* ② 目标场景（0.9.23）：只同步「人正看着的那一份」，不碰别的场景。
       * 顺序：当前任务 → 面板已加载 → 面板里正显示的 spec（spec_id → script_id）→ 当前页命中。
       * 之前只看前两项，而刷新页面时面板的 spec 是从本地原文恢复的（applySpec{fromStore}），
       * _specCache 是空的 → 认不出面板那份 → 退化成「同步全部 7 个」（98s、3 条假失败），
       * 更糟的是 applySpec 从不被调用 → 缓存升到 0.4.4 而徽标还是 0.4.3（2026-11-09 用户报）。 */
      let sid = (UI.currentTask && UI.currentTask.script_id) || (UI._specCache && UI._specCache.script_id) || '';
      let sidFrom = sid ? '当前任务' : '';
      if (!sid && UI.spec && UI.spec.spec_id) {
        // spec_id 是点号（huawei-ads.xxx），script_id 是下划线；约定可推导，但必须拿场景列表核一遍，
        // 免得把一份对不上的 spec 塞进面板（历史上只有 get-api-key 不符合这个约定）。
        const guess = String(UI.spec.spec_id).replace(/[.\-]/g, '_');
        if (!scenes.length || scenes.some(function (x) { return x && String(x.script_id) === guess; })) {
          sid = guess; sidFrom = '面板当前这份';
        }
      }
      if (!sid && scenes.length) {
        const hit = SVC.matchTriggerIn(scenes, location.href);
        if (hit && hit.script_id) { sid = String(hit.script_id); sidFrom = '当前页命中'; }
      }
      const ids = [];
      if (sid) ids.push(sid);
      else scenes.forEach(function (s) { if (s && s.script_id) ids.push(String(s.script_id)); });
      if (sid) {
        UI.appendLog({ t: Date.now(), level: 'info', msg: '同步目标：' + sid + '（' + sidFrom + '），其余场景不动' });
      } else {
        UI.appendLog({ t: Date.now(), level: 'warn',
          msg: '认不出「当前这份 spec」属于哪个场景（面板没加载、当前页也没命中）：改为同步全部 ' + ids.length + ' 个场景，会慢一些' });
      }
      if (!ids.length) {
        UI.appendLog({ t: Date.now(), level: 'warn', msg: '没有可同步的业务脚本：面板没加载 spec、当前页没命中场景、场景列表也拿不到。先打开一次业务页面或点「加载 spec」再试' });
        return;
      }
      let ups = 0, same = 0, bad = 0;
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const before = SVC.specCache.get(id);
        try {
          /* 手动同步是人在等的一次性动作：给 45s（默认 20s 在这条链路上经常不够——2026-11-09
           * 真机三次失败都正好 20.0s 到点）。真宕机由看门狗兜底，不会无限等。 */
          const s = await SVC.spec(id, { timeout: 45000 });
          SVC.specCache.put(id, s);
          const oldV = before ? String(before.version) : '';
          if (oldV && oldV === String(s.version)) {
            same++;
            UI.appendLog({ t: Date.now(), level: 'info', msg: 'spec 已是最新：' + id + ' v' + s.version });
          } else {
            ups++;
            UI.appendLog({ t: Date.now(), level: 'ok',
              msg: 'spec 已升级：' + id + ' ' + (oldV ? 'v' + oldV + ' → ' : '（本机无缓存）→ ') + 'v' + s.version + '（本地缓存已更新）' });
          }
          /* 只有「面板正显示的那一份」才换上面板，别的场景只更新缓存。
           * 判据用 spec_id（徽标上显示的就是它），不用 script_id：刷新页面时面板是从本地原文
           * 恢复的、_specCache 为空，只有 UI.spec.spec_id 认得出面板到底摆着哪一份。
           * 不调 applySpec 的后果就是 0.9.22 那个 bug：缓存升到 0.4.4，徽标还写着 0.4.3。 */
          const panelSpecId = (UI.spec && UI.spec.spec_id) ? String(UI.spec.spec_id) : '';
          const respSpecId = (s.spec && s.spec.spec_id) ? String(s.spec.spec_id) : '';
          const isPanelOne = panelSpecId ? panelSpecId === respSpecId : (ids.length === 1);
          if (isPanelOne) {
            UI._specCache = { script_id: id, spec: s.spec, version: s.version };
            UI.applySpec(JSON.stringify(s.spec), { persist: true });
            UI.appendLog({ t: Date.now(), level: 'ok',
              msg: '面板已切到 v' + s.version + '（本地缓存同步更新，刷新后也是这一版）' });
          }
        } catch (e) {
          bad++;
          UI.appendLog({ t: Date.now(), level: 'warn',
            msg: 'spec 同步失败：' + id + '（' + UI.syncErrText(e) + '）' + (before ? '——本机缓存 v' + before.version + ' 保留，仍可执行' : '——本机没有该场景缓存') });
        }
      }
      UI.appendLog({ t: Date.now(), level: bad && !ups ? 'fatal' : 'info',
        msg: '同步完成（' + ((Date.now() - T0) / 1000).toFixed(1) + 's）：升级 ' + ups + '、已是最新 ' + same + '、失败 ' + bad +
          (bad && !ups ? '——后端连不上时先把服务起来，再点一次「同步 spec」' : '') });
    } catch (e) {
      UI.appendLog({ t: Date.now(), level: 'fatal', msg: '同步失败：' + e.message });
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldLabel || '同步 spec'; }
    }
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

  /* ==================== 任务服务（v0.4.13 起唯一路径） ====================
   * 业务同学的飞书账号都是外部号，进不了自建应用可用范围 → 客户端拿不到 user_access_token。
   * 身份留在服务端（应用身份代持），客户端只持一个可撤销的「接入码」；
   * app_secret 只存在于服务端（wrangler secret / 环境变量），脚本内不含任何凭证材料。
   * 端点据接入码识别是谁，并强制只返回/只允许改 创建人 = 本人的行。
   * v0.4.13：直连模式（脚本内 ENC 凭证 + 口令解锁）已整体移除——
   *   持口令者即能解出 app_secret，双轨只留攻击面不留价值。
   */
  const SVC = {
    B_KEY: 'masr_svc_base_v1',
    C_KEY: 'masr_svc_code_v1',
    M_KEY: 'masr_svc_me_v1',
    // 默认后端：随版本发布内置（v0.4.14 起）。装完即用，无需手填地址。
    // 「改地址」按钮保留为逃生门：服务迁移/本机 temp-up 调试时临时覆盖。
    DEFAULT_BASE: 'https://mas.wankahuanju.top',
    // v0.5.0：Runner 不再登记任何业务场景。
    // 场景名、待办列、触发规则全部由服务端 /scenes 下发（服务端从 spec.scene 读），
    // 加新场景 = 加一份 spec —— 这里一行不改，也不认识任何表 ID / 业务列名。
    SCENES_KEY: 'masr_scenes_v1',
    SCENES_TTL_MS: 10 * 60 * 1000,
    // 场景列表是「10 分钟缓存」：刚发布的新场景不在旧缓存里，而「零命中」又被当成
    // 「这页确实没场景」静默跳过 → 发版后第一次点按钮什么都不会发生（2026-11-06
    // 发 P2 两个场景时踩到，用户只能干等 10 分钟或清存储）。零命中时强刷一次，
    // 用这个键全局限流，避免在每个无关页面（飞书/跳板）上都多打一次接口。
    SCENES_FORCE_KEY: 'masr_scenes_forced_at',
    SCENES_FORCE_MIN_MS: 60 * 1000,
  };
  /* 场景元数据缓存（进程内 + GM 存储双份，跨页/重开不用重拉）。
   * _scenePending 做在途去重：启动与点「拉待办」几乎同时发生时只打一次 /scenes。 */
  SVC._sceneCache = null;
  SVC._scenePending = null;
  SVC.scenes = function (force) {
    const now = Date.now();
    if (!force && SVC._sceneCache && now - SVC._sceneCache.at < SVC.SCENES_TTL_MS) {
      return Promise.resolve(SVC._sceneCache.list);
    }
    if (!force && SVC._scenePending) return SVC._scenePending;
    if (!force) {
      try {
        const c = JSON.parse(GM_getValue(SVC.SCENES_KEY, '') || 'null');
        if (c && c.at && now - c.at < SVC.SCENES_TTL_MS) {
          SVC._sceneCache = c;
          return Promise.resolve(c.list || []);
        }
      } catch (e) {}
    }
    SVC._scenePending = SVC.call('GET', '/scenes').then(function (j) {
      const c = { at: Date.now(), list: j.scenes || [] };
      SVC._sceneCache = c;
      SVC._scenePending = null;
      try { GM_setValue(SVC.SCENES_KEY, JSON.stringify(c)); } catch (e) {}
      return c.list;
    }).catch(function () {
      SVC._scenePending = null;
      return (SVC._sceneCache && SVC._sceneCache.list) || [];
    });
    return SVC._scenePending;
  };
  /* 零命中时强刷一次场景列表，再判一遍。
   * 为什么需要：缓存 TTL 10 分钟，而「刚发布的场景」必然不在旧缓存里；此时零命中
   * 不等于「这页没场景」，直接挂面板 = 用户点完按钮什么都没发生，也看不出原因。
   * 限流 60s（全局一次），所以代价是每个页面最多每分钟一次额外请求，而不是每次加载。 */
  SVC.scenesWhenUnmatched = function (url) {
    const list = (SVC._sceneCache && SVC._sceneCache.list) || [];
    const hit = SVC.matchTriggerIn(list, url);
    // 多场景歧义命中时 matchTriggerIn 返回 null，但那是「声明不足待人工」，不是「没场景」——
    // 不该为了它去强刷（刷了也一样歧义），原样返回 null 让上层按歧义处理。
    if (hit || SVC._triggerAmbiguous) return Promise.resolve(hit);
    const last = Number(GM_getValue(SVC.SCENES_FORCE_KEY, '0') || 0);
    if (Date.now() - last < SVC.SCENES_FORCE_MIN_MS) return Promise.resolve(null);
    try { GM_setValue(SVC.SCENES_FORCE_KEY, String(Date.now())); } catch (e) {}
    return SVC.scenes(true).then(function () {
      return SVC.matchTriggerIn((SVC._sceneCache && SVC._sceneCache.list) || [], url);
    }).catch(function () { return null; });
  };
  SVC.sceneById = function (scriptId) {
    const list = (SVC._sceneCache && SVC._sceneCache.list) || [];
    for (let i = 0; i < list.length; i++) if (list[i].script_id === scriptId) return list[i];
    return null;
  };
  /* 展示视图：服务端下发的 display 为准；拿不到就保守缺省（不猜业务列名） */
  SVC.sceneView = function (scriptId) {
    const s = SVC.sceneById(scriptId);
    const cols = (s && Array.isArray(s.display)) ? s.display : [];
    return {
      name: (s && s.name) || String(scriptId || '未指定场景').replace(/_/g, ' '),
      columns: cols.length
        ? cols.map(function (d) { return { field: d.param, label: d.label || d.param }; })
        : [{ field: 'record_id', label: '记录' }],
      emptyHint: '没有待处理的记录（过滤条件由该场景的 spec 声明，请核对该行是否满足条件，如状态列的值）',
      requireField: '',
    };
  };
  /* URL 参数可能被上游编码多次（业务表按钮 → 中转页 → 302 → SPA router，每跳都可能 encode 一次）。
   * 只解一次会把 `rec%2525...` 这种串当原值传给服务端，表现为「记录ID格式不对」或查到空。
   * 循环解到稳定为止；解不开就返回原值（宁可报错也不要静默给出半截值）。 */
  SVC.decodeParam = function (v, maxRounds) {
    let s = String(v == null ? '' : v);
    const limit = Math.max(1, Number(maxRounds) || 5);
    for (let i = 0; i < limit; i++) {
      if (s.indexOf('%') < 0) break;
      let n;
      try { n = decodeURIComponent(s); } catch (e) { break; }   // 非法百分号转义：保留原样
      if (n === s) break;
      s = n;
    }
    return s;
  };
  /* URL 触发匹配（纯函数）：规则全部来自 spec.scene.trigger，引擎不认识任何具体网站 */
  SVC.matchTriggerIn = function (list, url) {
    const href = String(url || location.href);
    // 触发参数既可能在 query，也可能在 hash 内的 query（SPA 路由习惯）
    function q(name) {
      if (!name) return '';
      let v = '';
      try { v = new URLSearchParams((href.split('#')[1] || '').split('?')[1] || '').get(name) || ''; } catch (e) {}
      if (!v) {
        /* 只取 ? 到 # 之间：按钮地址是 `index.html?recordId=xxx#/organization/orgList`，
         * 直接 href.split('?')[1] 会把 `#/organization/orgList` 并进值里，
         * 变成 recordId="xxx#/organization/orgList"，查记录必然查不到（2026-11-06 实测）。 */
        try { v = new URLSearchParams(href.split('#')[0].split('?')[1] || '').get(name) || ''; } catch (e) {}
      }
      return SVC.decodeParam(v);
    }
    /* 跨域登录页的安全阀：同一个 CAS 登录页服务很多站点，脚本装在这里不能见登录页就接管。
     * spec 声明 cross_domain.hosts（会落到哪些域）+ require_service_hosts（只接管回跳本业务的登录）。
     * 判定用 URL 里的 service / redirect_uri 参数的主机名；拿不到或不匹配 → 不认领。 */
    function crossDomainOk(tr) {
      const cd = tr && tr.cross_domain;
      if (!cd) return true;                       // 未声明跨域 → 老路径，不改变既有行为
      let here = '';
      try { here = new URL(href).host; } catch (e) { here = String(location.host || ''); }
      here = String(here).toLowerCase();
      const hosts = Array.isArray(cd.hosts) ? cd.hosts.map(function (x) { return String(x).toLowerCase(); }) : [];
      if (!hosts.length || hosts.indexOf(here) < 0) return true;  // 不是登录域，不归本闸管
      const allow = Array.isArray(cd.require_service_hosts)
        ? cd.require_service_hosts.map(function (x) { return String(x).toLowerCase(); }) : [];
      if (!allow.length) return true;             // 声明了登录域但没给白名单：不额外拦（由 spec 作者负责）
      const svcNames = Array.isArray(cd.service_query) ? cd.service_query : ['service', 'redirect_uri'];
      /* 沿跳转链收集主机名：真实链路里 CAS 登录页的 service 往往指向统一登录网关
       * （oauth-login1.cloud.huawei.com），真正的业务回跳目标压在他的 redirect_uri 里，还要再剥一层。
       * 只判第一层会把正确链路误杀——2026-11-06 真机实测：service=oauth-login1 → redirect_uri=id.cloud，
       * 结果登录页上场景永远不被认领（表现还是「点完按钮没反应」）。 */
      function chainHosts(raw, maxHops) {
        const out = [];
        let cur = SVC.decodeParam(raw, 8);
        const hops = Math.max(1, maxHops || 3);
        for (let i = 0; i < hops; i++) {
          let u = null;
          try { u = new URL(cur); } catch (e) { break; }
          if (!u || !u.host) break;
          out.push(String(u.host).toLowerCase());
          let next = '';
          for (let k = 0; k < svcNames.length && !next; k++) next = u.searchParams.get(svcNames[k]) || '';
          if (!next) break;
          cur = SVC.decodeParam(next, 8);         // 链路里每一层都可能再编码一次
        }
        return out;
      }
      for (const n of svcNames) {
        const raw = q(n);
        if (!raw) continue;
        const chain = chainHosts(raw, 3);
        if (!chain.length) continue;   // 解不出主机名（相对路径/畸形值）：看下一个参数，不当成命中
        /* 顶层第一个能解析出跳转链的参数就是「最终落点」，只认它；
         * 但一条链上经过的主机都算数——回跳要经过本业务域，才认领。
         * 不能「有一个顶层参数匹配就算」：service 指向别人的站点、redirect_uri 却带着我们的地址时，
         * 那样会把这页认领下来，登录页上就会跑本业务的脚本。 */
        return chain.some(function (h) { return allow.indexOf(h) >= 0; });
      }
      /* 一个 service/redirect_uri 都没有：分两种情况，必须由 spec 说清楚。
       *   - 登录页（require_service:true）：CAS 登录页必然带 service，没有就是别人的登录入口
       *     或者参数被改写 → 不认领，宁可不跑；
       *   - 业务页（缺省）：自己的落地页本来就没有 service，这里拦会导致业务页永远不触发
       *     （2026-11-06 实测：导入成员在管理台落地页被自己的安全阀挡掉了）。 */
      return !(cd.require_service === true);
    }

    const hits = [];
    for (let i = 0; i < (list || []).length; i++) {
      const s = list[i], tr = s.trigger;
      if (!tr || !Array.isArray(tr.url_patterns)) continue;
      let matched = false;
      for (let k = 0; k < tr.url_patterns.length && !matched; k++) {
        let re = null;
        try { re = new RegExp(tr.url_patterns[k]); } catch (e) { continue; }
        if (!re.test(href)) continue;
        // 表认领：多个场景共用同一个入口 URL（中转页）时，只能靠表 ID 区分。
        // 声明了 table_id_query 就必须对得上，否则跳过——宁可不动，也不猜是哪个场景。
        if (tr.table_id_query) {
          const tid = q(tr.table_id_query);
          if (!tid || !s.table_id || tid !== s.table_id) continue;
        }
        // 动作认领：同一张表可能有多个操作按钮（发邀请 / 导入成员 / 一键开户），
        // 它们指向同一个入口 URL、同一个 recordId，只能靠按钮链接里自带的标记参数区分。
        // 声明了 action_query 就必须对得上；声明了 action_query 但没配 action 视为声明不完整，跳过。
        if (tr.action_query) {
          if (!tr.action) continue;
          if (q(tr.action_query) !== String(tr.action)) continue;
        }
        // 跨域登录页：不是回跳本业务的登录就不认领（别把别人的登录页接管掉）
        if (!crossDomainOk(tr)) continue;
        matched = true;
        // params_query：spec 声明「哪些参数由页面地址直接带」（省掉查业务表那一步）。
        // 映射方向：spec 参数名 → URL 里的 query 参数名。引擎只认这份声明，不认识业务含义。
        // 凭据类参数（secret）禁止走这里：URL 会进浏览器历史/日志/他人截屏，加载期校验会拦下这种声明。
        const params = {};
        if (tr.params_query && typeof tr.params_query === 'object') {
          for (const pname in tr.params_query) {
            const pv = q(tr.params_query[pname]);
            if (pv) params[pname] = pv;
          }
        }
        /* recordId 的第二个来源：跨域登录页。
         * 302 到 CAS 登录页时，recordId 已经不在顶层 query 里了——它被编进了 service/redirect_uri
         * （实测 5 层编码，解码后才是 `...index.html?recordId=xxx`）。只在 spec 显式声明
         * record_id_deep 时才做这层提取：别的站点 service 里也可能有同名参数，猜着捞会捞错记录。 */
        let rid = q(tr.record_id_query);
        let ridFromPend = false;
        if (!rid && tr.record_id_deep === true && tr.record_id_query) {
          const names = (tr.cross_domain && Array.isArray(tr.cross_domain.service_query))
            ? tr.cross_domain.service_query : ['service', 'redirect_uri'];
          const rx = new RegExp('[?&]' + String(tr.record_id_query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^&#]+)');
          for (let n = 0; n < names.length && !rid; n++) {
            const raw = q(names[n]);
            if (!raw) continue;
            const dec = SVC.decodeParam(raw, 8);   // 证据里实测 5 层，留 3 层余量
            const m = dec.match(rx);
            if (m) rid = SVC.decodeParam(m[1], 8);
          }
        }
        /* recordId 的第三个来源：上一段流程的显式交接（record_id_pend）。
         * 场景：P2 在管理台建成员 → 退出登录 → 打开「开户邀请链接」。邀请链接里只有 inviteCode，
         * recordId 在任何一跳 URL 上都不存在（2026-11-06 实测：query / hash / 两处都加，302 后全丢）。
         * 所以只能由交接方在打开新标签前写进本地，由本页认领。
         * 只认「交接给本场景」的那一条（script_id 必须一致）：别的场景留下的上下文绝不借用，
         * 否则会拿着 A 记录的凭据去跑 B 流程。新鲜度由 pendGet 的 TTL 保证。 */
        if (!rid && tr.record_id_pend === true) {
          const pd = SVC.pendGet();
          if (pd && pd.t && pd.t.record_id &&
              String(pd.t.script_id || '') === String(s.script_id)) {
            rid = String(pd.t.record_id);
            ridFromPend = true;
          }
        }
        hits.push({
          script_id: s.script_id, name: s.name, record_id: rid,
          record_id_from_pend: ridFromPend,
          record_id_deep: (tr.record_id_deep === true),
          on_match: tr.on_match || 'fill',
          redirect_to: tr.redirect_to || '',
          params: params,
          /* read-once：声明了就优先用交接上下文里的参数，不查业务表（见 SVC.taskFromPend） */
          params_from_pend: (tr.params_from_pend === true),
          cross_domain: (tr.cross_domain && Array.isArray(tr.cross_domain.hosts)) ? tr.cross_domain.hosts.slice() : [],
          /* 退出登录后多久内不再自动登录。缺省由 logoutGuard 给跨域场景 3 分钟，
           * spec 显式写 0 可关掉（例如确实需要「退出即重登」的站点）。 */
          logout_suppress_ms: (tr.suppress_after_logout_ms === undefined ? undefined : Number(tr.suppress_after_logout_ms)),
        });
      }
    }
    // 多个场景同时命中 = 声明不足（多半是同表多按钮却没配 action 标记）。
    // 这种情况一律不认领，绝不按顺序取第一个——那等于赌。
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      SVC._triggerAmbiguous = hits.map(function (h) { return h.script_id; });
      return null;
    }
    SVC._triggerAmbiguous = null;
    return null;
  };
  SVC.matchTrigger = function (url) {
    return SVC.matchTriggerIn((SVC._sceneCache && SVC._sceneCache.list) || [], url);
  };

  /* ── 主动退出的抑制闸（2026-11-06 真机发现）─────────────────────────────
   * 故障现场：人在管理台点「退出」→ 落到 CAS 登录页 → 跨域场景照常认领 → 自动登录
   * → 8 秒后被登回原组织。人的退出被引擎自己撤销，切账号时完全出不去。
   * 这不是业务场景能修的（退出是人的动作，spec 无从得知），只能由引擎记一笔。
   *
   * 语义：记下「刚刚有人主动退出」，**下一次登录页认领时抑制一次**（消费即作废），
   * 之后（比如人重新点按钮进来）恢复正常自动登录。只抑制一次，不会把人永久挡在外面。 */
  SVC.LOGOUT_KEY = 'masr_logout_v1';
  SVC.LOGOUT_DEFAULT_MS = 180000;
  SVC.siteOf = function (host) {
    const h = String(host || '').toLowerCase();
    const p = h.split('.');
    return p.length >= 2 ? p.slice(-2).join('.') : h;   // huawei.com：id./id1./ads. 视为同一个站
  };
  SVC.markLogout = function (rid) {
    const rec = { at: Date.now(), rid: String(rid || ''), site: SVC.siteOf(location.host) };
    try { GM_setValue(SVC.LOGOUT_KEY, JSON.stringify(rec)); } catch (e) {}
    try {
      if (typeof UI !== 'undefined' && UI.appendLog) {
        UI.appendLog({ t: Date.now(), level: 'info',
          msg: '已记录「主动退出登录」：下一次落地登录页不会自动登录（防止刚退出又被登回去）' });
      }
    } catch (e) {}
  };
  /* 返回 null = 正常执行；返回 {msg} = 本次必须停手 */
  SVC.logoutGuard = function (hit) {
    if (!hit) return null;
    const declared = hit.logout_suppress_ms;
    let win = 0;
    if (declared === 0) win = 0;                                   // spec 显式关闭
    else if (Number(declared) > 0) win = Number(declared);
    else if (hit.cross_domain && hit.cross_domain.length) win = SVC.LOGOUT_DEFAULT_MS;
    if (!win) return null;
    let m = null;
    try { m = JSON.parse(GM_getValue(SVC.LOGOUT_KEY, 'null') || 'null'); } catch (e) { m = null; }
    if (!m || !m.at || m.used) return null;                        // 没用过才抑制；消费一次即止
    const age = Date.now() - Number(m.at);
    if (!(age >= 0) || age > win) return null;
    /* 换了一条记录 = 人主动去办别的任务，不该被上一条的退出挡住。
     * 记录号取不到时（退出页没带 recordId）只能按站点判，宁可多抑制一次。 */
    if (m.rid && hit.record_id && String(m.rid) !== String(hit.record_id)) return null;
    if (m.site && m.site !== SVC.siteOf(location.host)) return null;
    try { GM_setValue(SVC.LOGOUT_KEY, JSON.stringify({ at: m.at, rid: m.rid, site: m.site, used: 1 })); } catch (e) {}
    return { msg: '检测到 ' + Math.round(age / 1000) + ' 秒前刚刚主动退出登录，本次不自动登录' +
      '（否则会把你直接登回去，等于退不掉）。要重新进入这条记录，请回业务表再点一次按钮。' };
  };
  /* 同步预判：直接读存储里的场景缓存，用于「挂面板之前」判断当前页是不是中转页。
   * 中转页不能挂主面板（用户只是点了个按钮，不该看到工作台）。 */
  SVC.peekTrigger = function (url) {
    try {
      const raw = GM_getValue(SVC.SCENES_KEY, '');
      if (!raw) return null;
      const c = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!c || !Array.isArray(c.list)) return null;
      SVC._sceneCache = c;      // 顺手当缓存用，省一次网络
      if (!c.at || Date.now() - c.at >= SVC.SCENES_TTL_MS) return null;  // 过期不预判，等异步刷新后再定
      return SVC.matchTriggerIn(c.list, url);
    } catch (e) { return null; }
  };
  /* 通用模板替换：{{record_id}} / {{参数名}}。只做取值，不做业务判断 */
  SVC.tpl = function (str, vars) {
    return String(str == null ? '' : str).replace(/\{\{\s*([\w.]+)\s*\}\}/g, function (_, k) {
      const v = (vars || {})[k];
      return (v === undefined || v === null) ? '' : String(v);
    });
  };
  /* 跳转收敛成一个出口：便于回归探针拦截验证，也避免各处直接写 location */
  SVC.go = function (url) {
    if (typeof SVC._goHook === 'function') { SVC._goHook(url); return; }
    location.replace(url);
  };
  /* 跨页传递：中转页取到的任务 → 业务页恢复。
   * 用 GM 存储（跨域共享），带时间戳防陈旧；业务页宿主要对得上才恢复，避免跑到别的媒体页面上。 */
  SVC.PEND_KEY = 'masr_pending_task_v1';
  /* TTL 原来 10 分钟，只覆盖「跳转 + 页面渲染」这点时间。但这条链上有人工环节：
   * 等邮箱验证码、等改密、等填表——真机 2026-11-06 就有一次停了半个多小时才回来。
   * 过期 = 交接上下文被清空 = 下游拿不到参数只能回头读表，read-once 直接失效。
   * 所以放宽到 60 分钟，并且每次读取都刷新一次时间戳（见 pendGet）：
   * 只要这条链还在被使用，它就不会中途过期；停下来一小时以上才作废。 */
  SVC.PEND_TTL_MS = 60 * 60 * 1000;
  SVC.pendSet = function (t, host) {
    try { GM_setValue(SVC.PEND_KEY, JSON.stringify({ t: t, host: host || '', ts: Date.now() })); } catch (e) {}
  };
  SVC.pendGet = function () {
    try {
      const raw = GM_getValue(SVC.PEND_KEY, '');
      if (!raw) return null;
      const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!o || !o.t) return null;
      if (Date.now() - Number(o.ts || 0) > SVC.PEND_TTL_MS) { SVC.pendClear(); return null; }
      /* 用一次就续期一次：TTL 的语义是「闲置多久作废」，不是「签发多久作废」。
       * 人工环节（验证码、改密、填表）之间常常隔十几分钟，不续期会在半路丢上下文。 */
      try { o.ts = Date.now(); GM_setValue(SVC.PEND_KEY, JSON.stringify(o)); } catch (e) {}
      return o;
    } catch (e) { return null; }
  };
  SVC.pendClear = function () { try { GM_setValue(SVC.PEND_KEY, ''); } catch (e) {} };
  /* 交接参数合并：**交接上下文优先，表只用来补缺口**（2026-11-06 反转，原来反着来）。
   * 原来的规则是「表里的值永远优先，只有表里是空串才用交接值补」，理由是「表是权威」。
   * 那个前提被异步回写打掉了：P2 建完成员时邮箱账号还在本地待写队列里，表里是空串/旧值，
   * 而内存里是刚算出来的真值——此时「表优先」会稳定地选中错的那一份，而且看不出来。
   * 所以现在的真值顺序：**交接上下文 > 表**；表只在上下文没有这个键时兜底。
   * 冲突时必须留日志（只打字段名，不打值）：既要让人知道「用的不是表里的值」，
   * 也不能把密码这类东西打进日志。 */
  SVC.pendMerge = function (task) {
    if (!task) return task;
    const pd = SVC.pendGet();
    if (!pd || !pd.t || String(pd.t.script_id || '') !== String(task.script_id || '')) return task;
    if (!SVC.pendAccept(pd, location.host)) return task;
    const src = (pd.t && pd.t.params) || {};
    task.params = task.params || {};
    const filled = [], over = [];
    Object.keys(src).forEach(function (k) {
      const hasPend = !(src[k] === undefined || src[k] === null || String(src[k]) === '');
      if (!hasPend) return;
      const cur = task.params[k];
      const hasTable = !(cur === undefined || cur === null || String(cur) === '');
      if (!hasTable) { task.params[k] = src[k]; filled.push(k); return; }
      if (String(cur) !== String(src[k])) { task.params[k] = src[k]; over.push(k); }
    });
    try {
      if (filled.length) {
        UI.appendLog({ t: Date.now(), level: 'info',
          msg: '交接上下文补位 ' + filled.length + ' 个参数（表里为空）：' + filled.join(',') });
      }
      if (over.length) {
        UI.appendLog({ t: Date.now(), level: 'warn',
          msg: '交接上下文覆盖 ' + over.length + ' 个参数（表里的值落后于本机流程，以本机为准）：' + over.join(',') });
      }
    } catch (e) {}
    return task;
  };
  /* 单次取数（read-once）：spec 在 trigger 上声明 params_from_pend 时，只要交接上下文里
   * 参数是齐的（params_complete + script_id 对得上 + host 准入 + TTL 内），就直接用它开跑，
   * **不再发 /task**。省掉的不只是一次网络往返，而是服务端那一次业务表回读（真机 4~8s）。
   * 前置条件由校验器把关：只有 writeback.mode=none 的场景才允许声明——因为 /task 同时
   * 签发回写票据（write_token），跳过它就没有票据，写表会用不了。 */
  SVC.taskFromPend = function (hit) {
    SVC.taskFromPend.lastReason = '';
    if (!hit || hit.params_from_pend !== true) { SVC.taskFromPend.lastReason = 'not_declared'; return null; }
    const pd = SVC.pendGet();
    if (!pd || !pd.t) { SVC.taskFromPend.lastReason = 'no_pend_or_expired'; return null; }
    if (String(pd.t.script_id || '') !== String(hit.script_id || '')) { SVC.taskFromPend.lastReason = 'script_mismatch'; return null; }
    if (!SVC.pendAccept(pd, location.host)) { SVC.taskFromPend.lastReason = 'host_not_allowed'; return null; }
    if (pd.t.params_complete !== true) { SVC.taskFromPend.lastReason = 'upstream_not_complete'; return null; }
    const ps = (pd.t && pd.t.params) || {};
    if (!Object.keys(ps).length) { SVC.taskFromPend.lastReason = 'empty_params'; return null; }
    const out = {};
    Object.keys(ps).forEach(function (k) { if (ps[k] !== undefined && ps[k] !== null && String(ps[k]) !== '') out[k] = ps[k]; });
    if (!Object.keys(out).length) { SVC.taskFromPend.lastReason = 'all_blank'; return null; }
    return {
      record_id: String(pd.t.record_id || hit.record_id || ''),
      script_id: hit.script_id,
      params: out,
      display: pd.t.display || null,
      write_token: '',
      from_pend: true,
    };
  };
  /* 按 script_id 找场景声明（跨域判定要用它声明的 hosts） */
  SVC.sceneById = function (scriptId) {
    const list = (SVC._sceneCache && SVC._sceneCache.list) || [];
    for (let i = 0; i < list.length; i++) {
      if (String(list[i].script_id) === String(scriptId)) return list[i];
    }
    return null;
  };
  /* 跨页任务能不能在本页恢复：同域直接认；跨域只在 spec 声明的 hosts 里认。
   * 301/302 换域是 P2 开户的常态（业务页 → CAS 登录页 → 管理台），若还死守 host 相等，
   * 登录页永远恢复不了任务，recordId 就断了。 */
  SVC.pendAccept = function (o, here) {
    if (!o || !o.t) return false;
    const host = String(o.host || '').toLowerCase();
    const cur = String(here || '').toLowerCase();
    if (!host || !cur || host === cur) return true;
    const s = SVC.sceneById(o.t.script_id);
    const hosts = (s && s.trigger && s.trigger.cross_domain && s.trigger.cross_domain.hosts) || [];
    return hosts.map(function (x) { return String(x).toLowerCase(); }).indexOf(cur) >= 0;
  };
  SVC.base = function () {
    const v = String(GM_getValue(SVC.B_KEY, '') || '').replace(/\/+$/, '');
    return v || SVC.DEFAULT_BASE;
  };
  SVC.code = function () { return String(GM_getValue(SVC.C_KEY, '') || ''); };
  SVC.me = function () { try { return JSON.parse(GM_getValue(SVC.M_KEY, 'null')); } catch (e) { return null; } };

  SVC.call = function (method, path, query, body, opts) {
    const base = SVC.base();
    let url = base + path;
    const q = query || {};
    const ks = Object.keys(q);
    if (ks.length) url += '?' + ks.map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]); }).join('&');
    const budget = (opts && opts.timeout) || 20000;
    return new Promise(function (resolve, reject) {
      /* 看门狗（0.9.20）：GM_xmlhttpRequest 的三个回调在个别页面会**集体失联**——
       * 2026-11-09 ads.huawei.com SPA 实测 /task 静默挂死 4 次：onload/onerror/ontimeout 一个都不来，
       * 连 20s 的 ontimeout 都不触发（脚本管理器通道层挂死；页面 fetch 又被 CSP 拦死，
       * 页面侧无法兜底）。setTimeout 不依赖 GM 事件循环，一定能响：
       * 超预算+5s 还没有任何回调 → 自动重发一次；再超 → 显式报错终止，绝不静默挂着。
       * GM 回调事后才到也没关系：settled 挡住迟到的 resolve/reject，且每次回调先清掉看门狗。 */
      let settled = false, retried = false, wd = null;
      const margin = Math.min(5000, budget);   // 余量不小于预算的怪比例：小预算（测试/探针）不用陪等 5s
      const send = function () {
        clearTimeout(wd);
        wd = setTimeout(function () {
          if (settled) return;
          if (!retried) { retried = true; send(); return; }
          settled = true;
          reject(new Error('E_SVC_WATCHDOG ' + method + ' ' + path +
            '：脚本管理器网络通道无响应（重发一次仍无回调）。这个站点的扩展环境把请求吞了：'
            + '刷新页面重试，或换一个页面/域名发起；同一服务在别的域名的页面上往往是好的。'));
        }, budget + margin);
        GM_xmlhttpRequest({
          method: method,
          url: url,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-mas-code': SVC.code() },
          data: body ? JSON.stringify(body) : null,
          // 回写要等飞书返回（服务端自己还有 15s×2 的超时预算），所以按调用类型给不同上限
          timeout: budget,
          onload: function (r) {
            if (settled) return; settled = true; clearTimeout(wd);
            let j = {};
            try { j = JSON.parse(r.responseText || '{}'); } catch (e) { return reject(new Error('E_SVC_PARSE http=' + r.status)); }
            if (r.status >= 400 || j.ok === false) return reject(new Error(j.error || ('E_SVC ' + r.status)));
            resolve(j);
          },
          onerror: function () { if (settled) return; settled = true; clearTimeout(wd); reject(new Error('E_SVC_NET ' + url)); },
          ontimeout: function () { if (settled) return; settled = true; clearTimeout(wd); reject(new Error('E_SVC_TIMEOUT ' + url)); },
        });
      };
      send();
    });
  };

  /* v0.4.13 起只有一种模式：填了服务地址走服务端，直连已整体移除（app_secret 只在服务端） */

  /* 改后端地址 = 改身份来源：旧设备码可能不是这个端点签的，一并清掉重走绑定 */
  SVC.setBase = function (url) {
    const v = String(url || '').trim().replace(/\/+$/, '');
    if (v) GM_setValue(SVC.B_KEY, v); else GM_deleteValue(SVC.B_KEY);
    GM_deleteValue(SVC.C_KEY); GM_deleteValue(SVC.M_KEY);
    try { clearAuthCode(); } catch (e) {}
    return v;
  };

  /* 探活：打 /health，顺便核对版本。没填地址时由调用方引导填写，不会走到这里 */
  /* 超时 8s→4s（v0.9.11）：这是一个纯健康检查，链路正常时是亚秒级；给到 8s 只会让「标签页被冻住」
   * 这类情况多挂 4 秒静默。真机 2026-11-06 的 27s 空白段里，脚本唯一在等的东西就是它。 */
  /* 两段式（0.9.21）：4s 快探失败后再给 12s 重试一次。真机 2026-11-09：同一次运行里
   * /task 4.2s 成功（后端明明可达），/health 却 4s 超时 fatal，把登录点击之后的续跑整次误杀
   * （当天链路普遍 5~6.5s，4s 预算必炸）。两段都失败才向上报错——真死的服务在重试里会快速
   * 再失败（连接拒绝类 onerror 是瞬时的），总代价有界；budgets 可注入（smoke 用小预算）。 */
  SVC.ping = function (opts) {
    const budgets = (opts && opts.budgets) || [4000, 12000];
    const once = function (budget) {
      return new Promise(function (resolve, reject) {
        GM_xmlhttpRequest({
          method: 'GET', url: SVC.base() + '/health', timeout: budget,
          onload: function (r) {
            let j = {};
            try { j = JSON.parse(r.responseText || '{}'); } catch (e) {}
            if (r.status !== 200) return reject(new Error('地址有响应但不是本服务（HTTP ' + r.status + '）'));
            if (j.service && j.service !== 'mas-service') return reject(new Error('这个地址不是 MAS 后端'));
            resolve({ mode: 'svc', version: j.version || '?' });
          },
          onerror: function () { reject(new Error('连不上 ' + SVC.base())); },
          ontimeout: function () { reject(new Error('超时（' + Math.round(budget / 1000) + ' 秒）' + SVC.base())); },
        });
      });
    };
    return once(budgets[0]).catch(function (e1) {
      return once(budgets[1]).catch(function (e2) {
        throw new Error(e1.message + '；重试（' + Math.round(budgets[1] / 1000) + 's）仍失败：' + e2.message);
      });
    });
  };

  SVC.bind = async function () {
    const me = (await SVC.call('GET', '/me')).me;
    GM_setValue(SVC.M_KEY, JSON.stringify(me));
    return me;
  };
  /* 这条任务该用哪个场景的 spec：行内「场景ID」> 任务表默认 > 全局默认 */
  /* 这条任务该用哪个场景：行内 script_id 优先（服务端按 scene 下发时必有）；
   * 没有且全场只有一个场景 → 用它；否则返回空，由调用方提示「该行未指定场景」，绝不猜。 */
  SVC.scriptFor = function (task) {
    const t = task || (typeof UI !== 'undefined' && UI.currentTask) || {};
    if (t.script_id) return String(t.script_id);
    const list = (SVC._sceneCache && SVC._sceneCache.list) || [];
    return list.length === 1 ? list[0].script_id : '';
  };

  SVC.tasks = function (scriptId) {
    return SVC.call('GET', '/tasks', scriptId ? { script_id: scriptId } : {}).then(function (j) {
      (j.items || []).forEach(function (t) {
        if (!t.script_id) t.script_id = scriptId || '';
      });
      return j;
    });
  };
  /* 单条取数（URL 触发路径）：record_id 来自页面地址，服务端按 scene 声明的状态条件校验后才给参数与票据 */
  SVC.record = function (recordId, scriptId) {
    if (!recordId) return Promise.reject(new Error('E_PARAM 页面地址里没有 record_id'));
    if (!scriptId) return Promise.reject(new Error('E_SCENE 未能确定该 URL 属于哪个场景'));
    return SVC.call('GET', '/task', { script_id: scriptId, record_id: recordId }).then(function (j) {
      return j.item;
    });
  };
  SVC.spec = function (scriptId, opts) {
    const id = scriptId || SVC.scriptFor();
    if (!id) return Promise.reject(new Error('E_SCENE 未能确定场景：该行没有 script_id，且当前不止一个场景'));
    return SVC.call('GET', '/spec', { script_id: id }, null, opts && opts.timeout ? { timeout: opts.timeout } : null);
  };

  /* ---------- spec 本地缓存（v0.8.1） ----------
   * 每点一次业务表里的「操作按钮」都是新开一个标签页，页面内存里的 _specCache 随之销毁，
   * 于是每一条都要重新「公网 → Worker → 飞书」取一次 spec。实测这一枪 14s：
   * 客户端到自定义域的链路抖动 7~8s（偶发 20s 超时）+ 服务端两次飞书读 6~7s。
   * spec 是纯声明式流程、一版发布长期稳定，天然适合落本地：
   *   命中 URL → 直接用缓存开跑（≈0 等待）→ 后台静默拉一次，版本变了才更新缓存，本次仍按缓存版执行。
   * 存的是 spec 原文（业务表 ID / 页面选择器，无任何凭据），与「加载 spec」按钮持久化的那份同性质。 */
  const SPEC_KEY = 'masr.spec.';
  const SPEC_STALE_MS = 7 * 24 * 3600 * 1000;   // 7 天没刷新过的不再采信：宁可等一次网络，也不用过期流程
  SVC.specCache = {
    get: function (id) {
      if (!id) return null;
      try {
        const o = JSON.parse(GM_getValue(SPEC_KEY + id, 'null'));
        if (!o || !o.spec || !o.version) return null;
        if (o.ts && Date.now() - o.ts > SPEC_STALE_MS) return null;
        return o;
      } catch (e) { return null; }
    },
    put: function (id, s) {
      if (!id || !s || !s.spec) return;
      try {
        GM_setValue(SPEC_KEY + id, JSON.stringify({
          spec_id: s.spec_id || id, version: s.version, status: s.status || '', spec: s.spec, ts: Date.now(),
        }));
      } catch (e) { /* 存不下不影响本次执行 */ }
    },
    drop: function (id) { try { GM_deleteValue(SPEC_KEY + id); } catch (e) {} },
  };
  /* 后台刷新：不阻塞主流程；失败静默（缓存只是加速，不是依赖） */
  SVC.specRefresh = function (id) {
    return SVC.spec(id).then(function (s) {
      const old = SVC.specCache.get(id);
      SVC.specCache.put(id, s);
      return { changed: !old || old.version !== s.version, version: s.version, oldVersion: old ? old.version : '' };
    });
  };
  SVC.writeResult = function (payload) {
    // 45s：服务端对飞书是 15s 硬超时 + 重试一次，客户端预算必须比它大，否则会把"正在重试"误判成失败
    return SVC.call('POST', '/result', null, payload, { timeout: 45000 });
  };
  /* 预热任务表：飞书侧对某张表的**第一次**访问很慢（实测 15~20s，热了 2s）。
   * 流程跑一趟要十几秒，正好用来把表捂热，等真回写时就是热路径。
   * 失败一律忽略——预热只是加速，不是依赖。 */
  let _warming = false;
  /* 预热定时器登记表：以前 warmStart 只把 interval 返回给调用方，没人 clear，也没有「提前停」的入口。
   * 实测一次运行结束后它还在打 /health?warm=1（每 6s 一枪、最长 120s），既费请求也和回写抢连接。
   * 现在统一登记，流程收尾一句 SVC.stopWarm() 全部停掉。 */
  const _warmTimers = new Set();
  SVC.stopWarm = function () {
    _warmTimers.forEach(function (x) {
      try { clearInterval(x.iv); } catch (e) {}
      try { clearTimeout(x.to); } catch (e) {}
    });
    _warmTimers.clear();
  };
  SVC.warm = function (scriptId) {
    if (!SVC.base() || _warming) return;
    _warming = true;
    const q = { warm: 1 };
    if (scriptId) q.script_id = scriptId;   // 让服务端预热该场景的表（场景表 ID 只有服务端从 spec 里知道）
    SVC.call('GET', '/health', q, null, { timeout: 25000 })
      .catch(function () {})
      .then(function () { _warming = false; });
  };
  SVC.warmStart = function (ms, scriptId) {
    if (!SVC.base()) return null;
    SVC.warm(scriptId);
    const rec = { iv: null, to: null };
    rec.iv = setInterval(function () { SVC.warm(scriptId); }, 6000);
    rec.to = setTimeout(function () { clearInterval(rec.iv); _warmTimers.delete(rec); }, ms || 90000);
    _warmTimers.add(rec);
    return rec.iv;
  };

  SVC.bindMeta = function () { return SVC.call('GET', '/bind/meta'); };
  SVC.bindPoll = function (q) {
    return SVC.call('GET', '/bind/poll', q || {});
  };

  /* ---------- 授权码：本地随机生成，不经过服务端 ----------
   * 6 位 × 32 字符集（无 I/O/0/1）≈ 10.7 亿种，30 分钟窗口内碰撞概率可忽略。
   * 码只是「把表里某一行对上这次会话」的关联凭证，真正身份来自表单记录的创建人。
   */
  const AUTH_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const AUTH_LEN = 6;
  const AUTH_TTL_MS = 30 * 60 * 1000;
  const AUTH_KEY = 'masr.authcode';
  /* 登记表单地址：固定常量，内置。
   * 为什么不再问服务端（2026-11-06）：这一步是「复制授权码 + 打开表单」，全是本地动作，
   * 而 /bind/meta 只是把这些常量重新下发一遍，却要在一条实测能抖到 17~25 秒的链路上
   * 走一次往返（客户端 20s 判死），于是纯本地动作被一次无关的网络请求拖垮。
   * 表单地址是公开常量（不是凭据）；真要换地址=发版。服务端 MAS_FORM_URL 那份仅作参考，
   * 两边一致性由 scripts/bind-form-fallback-smoke.cjs 守着。 */
  const DEFAULT_FORM_URL = 'https://scnzhojz10ln.feishu.cn/share/base/form/shrcn1WrOocHO5cG8cHrorhXJJe';

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
    return '<span style="font-size:10px;color:#1a7f45;border:1px solid #b7e0c8;border-radius:3px;padding:0 4px;margin-left:4px">后端</span>';
  }

  /* ---------- 连接方式：常驻一行，不随任务面板重绘消失 ----------
   * v0.4.13 起只有后端一条路：密钥只在服务端，客户端持可撤销接入码。
   * 用户要能自己填/换地址，所以这里给一个永远可见的入口。
   */
  let connEditing = false;
  let connOut = '';

  function connTag() {
    return '<span style="font-size:10px;color:#1a7f45;border:1px solid #b7e0c8;border-radius:3px;padding:0 4px">后端</span>';
  }
  const connEsc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  UI.devOn = false; // dev 工具区展开态（由面板的 dev 按钮切换）

  /* 常规模式：连接行只读（后端地址 + 状态，一眼可辨）；
   * 编辑/覆盖能力全部收进 dev 区（masr-dev-conn，仅 dev 展开时渲染）。 */
  UI.renderConn = function () {
    const box = document.getElementById('masr-conn');
    if (!box) return;
    const base = SVC.base();

    box.innerHTML = '<b>连接</b> ' + connTag() +
      ' <span style="font-size:11px;color:#4e5969">' + connEsc(base) + '</span>' +
      (!connEditing && connOut ? '<div style="font-size:11px;color:#8f959e;margin-top:2px;line-height:1.6">' + connOut + '</div>' : '');

    const dev = document.getElementById('masr-dev-conn');
    if (!dev || !UI.devOn) return;

    if (!connEditing) {
      dev.innerHTML = '<b>后端地址</b> <span style="font-size:11px;color:#8f959e">调试用：默认地址已内置，一般不用动</span>' +
        '<div style="font-size:11px;color:#4e5969;margin-top:2px">' + connEsc(base) + '</div>' +
        '<div class="row" style="margin-top:4px"><button id="masr-conn-edit" style="font-size:11px;padding:1px 6px">改地址</button>' +
        (base !== SVC.DEFAULT_BASE ? '<button id="masr-conn-reset" style="font-size:11px;padding:1px 6px">恢复默认</button>' : '') + '</div>' +
        (connOut ? '<div style="font-size:11px;color:#8f959e;line-height:1.6">' + connOut + '</div>' : '');

      document.getElementById('masr-conn-edit').addEventListener('click', function () {
        connEditing = true; connOut = ''; UI.renderConn();
      });
      const rst = document.getElementById('masr-conn-reset');
      if (rst) rst.addEventListener('click', function () {
        SVC.setBase(''); // 清掉覆盖值 → base() 回落到内置默认
        connOut = '已恢复内置默认地址。';
        UI.renderConn(); UI.renderTasks();
      });
      return;
    }

    dev.innerHTML = '<b>后端地址</b> <span style="font-size:11px;color:#8f959e">保存后重新测试；换端点需重新绑定身份</span>' +
      '<div class="row" style="margin-top:4px"><input id="masr-conn-in" value="' + connEsc(base) +
      '" placeholder="https://mas.wankahuanju.top 或 http://127.0.0.1:8787" style="width:100%"></div>' +
      '<div class="row"><button class="primary" id="masr-conn-save">保存并测试</button>' +
      '<button id="masr-conn-cancel">取消</button></div>' +
      '<div id="masr-conn-out" style="font-size:11px;color:#8f959e;line-height:1.6">' + connOut + '</div>';

    document.getElementById('masr-conn-save').addEventListener('click', function () {
      const v = (document.getElementById('masr-conn-in').value || '').trim();
      if (!v) { connOut = '请先填服务地址。'; UI.renderConn(); return; }
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
        connOut = '<span style="color:#c02a2a">' + connEsc(e.message) + '</span><br>地址已存下，服务起来后再试一次。';
        UI.renderConn();
      });
    });

    document.getElementById('masr-conn-cancel').addEventListener('click', function () {
      connEditing = false;
      connOut = '';
      UI.renderConn();
    });
  };

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
    let expiresMin = AUTH_TTL_MS / 60000; // 与码的实际有效期同源，避免两处写死漂移
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
      // 码由本地生成：30 分钟内复用同一个，force=true 才换新的
      bindCode = force ? '' : reuseAuthCode();
      if (!bindCode) { bindCode = genAuthCode(); saveAuthCode(bindCode); }
      if ($code()) $code().textContent = bindCode;

      /* 这一步零网络：授权码、表单地址、有效期全是本地常量，不查服务端也不做任何预检。
       * 有效期由 AUTH_TTL_MS 推导（同一个来源，不会出现「显示 30 分钟但码 20 分钟就过期」）。
       * 必须联网的只有「提交之后」的绑定轮询 —— 服务端要去飞书登记表里找这次提交。 */
      formUrl = DEFAULT_FORM_URL;
      tip('授权码已就绪，' + expiresMin + ' 分钟内有效 —— 点按钮会先复制再打开表单');
      if ($again()) $again().style.display = '';
    }

    if ($code()) {
      $code().addEventListener('click', function () { copyNow(); });
    }

    document.getElementById('masr-bind-go').addEventListener('click', function () {
      if (!bindCode) { tip('授权码还没生成，稍等一下再点'); return; }
      const state = { code: bindCode, since: Date.now() };
      // 开窗必须留在用户手势的同步调用栈里：一旦放进 Promise 回调，
      // 剪贴板写入稍慢就会消耗掉 transient activation，被弹窗拦截器静默吞掉（不抛错、只返回 null）。
      let win = null;
      try { win = window.open(formUrl || DEFAULT_FORM_URL, '_blank'); } catch (e) {}
      if (win) { try { win.opener = null; } catch (e) {} } // 等价 noopener，但要拿到返回值判断是否被拦
      copyNow().then(function () {
        if (!win) tip('授权码 ' + bindCode + ' 已复制，但浏览器拦下了新窗口 —— 允许本页弹窗后重试，或手动打开登记表单粘贴它');
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

  // ③ 已绑定 → 场景选择 → 该场景的待办
  // 交互（用户 2026-11-03 拍板）：打开面板先选业务场景，选完自动按该场景 spec 声明的
  // 过滤条件拉记录；不设「拉待办」总按钮。场景列表/列名/空提示全部来自 /scenes（spec）。
  function renderBound(box, me) {
    const pend = pwList();
    box.innerHTML =
      '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
        '<b>任务</b>' +
        '<span style="color:#1a7f45">' + (me.name || '已绑定') + (me.dept ? ' · ' + me.dept : '') + '</span>' +
        modeTag() +
        '<span style="flex:1 1 auto"></span>' +
        (pend.length ? '<button id="masr-retry-writes" class="masr-mini primary" title="把上次没写进飞书的结果重新提交">重试回写 (' + pend.length + ')</button>' : '') +
      '</div>' +
      '<div id="masr-trigger-box"></div>' +
      '<div id="masr-scene-body" style="margin-top:4px"></div>';

    const rw = document.getElementById('masr-retry-writes');
    if (rw) rw.addEventListener('click', function () { UI.retryWrites(rw); });
    // 单元格取值：优先 display（服务端按 scene.display 算好的），其次 params，最后原字段
    function cellOf(t, f) {
      if (!t) return '';
      if (t.display && t.display[f] !== undefined) return t.display[f];
      if (t.params && t.params[f] !== undefined) return t.params[f];
      return t[f];
    }
    function esc(s) {
      return String(s === undefined || s === null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    const body = document.getElementById('masr-scene-body');

    /* 第 1 页：业务场景选择（列表来自 /scenes，引擎不登记任何场景） */
    async function renderScenePicker() {
      body.innerHTML = '<span style="font-size:11px;color:#8f959e">正在加载业务场景…</span>';
      try {
        const r = await SVC.scenes();
        const list = (Array.isArray(r) ? r : (r && r.list) || []).slice();
        if (!list.length) {
          body.innerHTML = '<div style="font-size:11px;color:#8f959e">服务端暂无可用业务场景</div>';
          return;
        }
        body.innerHTML =
          '<div style="font-size:11px;color:#8f959e;margin:2px 0">选择要处理的业务场景：</div>' +
          list.map(function (s, i) {
            const draft = s.status === 'draft';
            return '<div data-i="' + i + '" style="border:1px solid ' + (draft ? '#e5e5e5' : '#b7d8f5') +
              ';background:' + (draft ? '#fafafa' : '#f2f8ff') + ';border-radius:6px;padding:6px 9px;margin:4px 0;cursor:' +
              (draft ? 'not-allowed' : 'pointer') + ';opacity:' + (draft ? 0.55 : 1) + '">' +
              '<b style="font-size:12px">' + esc(s.name || s.script_id) + '</b>' +
              (draft ? ' <span style="font-size:11px;color:#b26a00">草稿 · 暂不可执行</span>' : '') +
              '</div>';
          }).join('') +
          '<div style="font-size:11px;color:#8f959e;margin-top:2px">也可以直接点业务表里的按钮：页面会自动识别记录并填充，无需在这里选。</div>';
        body.querySelectorAll('[data-i]').forEach(function (el) {
          el.addEventListener('click', function () {
            const s = list[Number(el.getAttribute('data-i'))];
            if (!s || s.status === 'draft') return;      // 草稿场景不可执行
            renderSceneTasks(s.script_id);
          });
        });
      } catch (e) {
        body.innerHTML = '<div style="font-size:11px;color:#c02a2a">' + esc(e.message) + '</div>';
      }
    }

    /* 第 2 页：单个场景的待办——过滤条件完全由该场景 spec 声明，服务端执行 */
    async function renderSceneTasks(sid) {
      const view = SVC.sceneView(sid);
      body.innerHTML =
        '<div style="display:flex;align-items:center;gap:6px;margin:2px 0">' +
          '<button id="masr-back-picker" class="masr-mini">← 场景</button>' +
          '<b style="font-size:12px">' + esc(view.name) + '</b>' +
        '</div>' +
        '<div id="masr-task-list"><span style="font-size:11px;color:#8f959e">按该场景声明的过滤条件查询中…</span></div>';
      document.getElementById('masr-back-picker').addEventListener('click', renderScenePicker);
      const list = document.getElementById('masr-task-list');
      try {
        const j = await SVC.tasks(sid);
        if (!j.total) {
          list.innerHTML = '<div style="font-size:11px;color:#8f959e">' + esc(view.emptyHint) + '</div>';
          return;
        }
        const totalShown = j.items.length;
        list.innerHTML =
          '<div style="font-size:11px;color:#8f959e;margin-bottom:2px">共 ' + j.total + ' 条：点「执行」单条跑，或点「批量执行」一次性串行跑完（同一浏览器会话全局共用，必须串行，跑的过程中勿把本窗口切到后台/最小化）</div>' +
          '<div style="display:flex;align-items:center;gap:6px;margin:4px 0;flex-wrap:wrap">' +
            '<input id="masr-batch-n" type="number" min="1" max="' + totalShown + '" value="' + totalShown + '" style="width:58px">' +
            '<button class="primary" id="masr-batch-run">批量执行（前 <span id="masr-batch-n-lab">' + totalShown + '</span> 条）</button>' +
            '<button id="masr-batch-stop" style="display:none">停止</button>' +
            '<span id="masr-batch-prog" style="font-size:11px;color:#1a7f45"></span>' +
          '</div>' +
          '<table><tr>' + view.columns.map(function (c) { return '<th>' + esc(c.label) + '</th>'; }).join('') + '<th></th></tr>' +
          j.items.map(function (t, i) {
            return '<tr>' + view.columns.map(function (c) {
              const v = cellOf(t, c.field);
              return '<td>' + (v === null || v === undefined || v === '' ? '-' : esc(v)) + '</td>';
            }).join('') + '<td><button class="primary" data-idx="' + i + '">执行</button></td></tr>';
          }).join('') + '</table>' +
          '<div id="masr-batch-report"></div>';
        const nEl = document.getElementById('masr-batch-n');
        const nLab = document.getElementById('masr-batch-n-lab');
        const batchRun = document.getElementById('masr-batch-run');
        const batchStop = document.getElementById('masr-batch-stop');
        const prog = document.getElementById('masr-batch-prog');
        if (nEl && nLab) nEl.addEventListener('input', function () { nLab.textContent = nEl.value; });
        if (batchRun) batchRun.addEventListener('click', function () {
          const n = Math.min(Math.max(Number(nEl ? nEl.value : totalShown) || totalShown, 1), totalShown);
          UI.runBatch(j.items.slice(0, n), prog, batchRun, batchStop);
        });
        if (batchStop) batchStop.addEventListener('click', function () {
          UI._batchStop = true; batchStop.disabled = true; batchStop.textContent = '正在停止…';
        });
        list.querySelectorAll('button[data-idx]').forEach(function (b) {
          b.addEventListener('click', function () { UI.runTask(j.items[Number(b.getAttribute('data-idx'))], b); });
        });
      } catch (e) {
        list.innerHTML = '<div style="font-size:11px;color:#c02a2a">' + esc(e.message) + '</div>';
      }
    }

    renderScenePicker();
    if (UI.renderTrigger) UI.renderTrigger();
  }

  UI.renderTasks = function () {
    const box = document.getElementById('masr-tasks');
    if (!box) return;
    // 第一步永远是服务地址（v0.4.13 起没有别的路径）
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
  /* ---------- 执行期「节奏探针」：把静默段归因，而不是让人猜（v0.9.11） ----------
   * 真机日志里出现过 27s / 49s 的空白段：面板上两条日志之间什么都没有。三种原因的日志长相一样：
   *   ① 网络往返慢          → 阶段计时（/task 取数、/health 预检、回写）能对上，见各调用点；
   *   ② 主线程被业务页占满  → 1s 定时器整体漂移，脚本一行都没跑（EAM 这类大 SPA 首屏就会这样）；
   *   ③ 标签页被切到后台    → Chrome 直接冻结后台标签的 JS，定时器和 XHR 回调一起停。
   * ②③ 的共同点是「不是我们的请求慢」，靠 timer 漂移 + visibilitychange 区分。只在执行期挂着，
   * 空闲时零开销；阈值取得比正常抖动大，正常流程一条都不会多打（golden trace 因此仍 0 diff）。 */
  function startPaceWatch() {
    let last = Date.now();
    let lastTap = 0;
    const iv = setInterval(function () {
      const now = Date.now();
      const drift = now - last - 1000;
      last = now;
      if (drift > 2500 && now - lastTap > 5000) {
        lastTap = now;
        UI.appendLog({
          t: now, level: 'warn',
          msg: '⏱ 页面卡了 ' + (drift / 1000).toFixed(1) + 's：这段时间脚本一行都没跑' +
            '（业务页占满主线程，或标签页被浏览器冻结）——不是回写/取数慢，别往网络上找',
        });
      }
    }, 1000);
    let hiddenAt = 0;
    function onVis() {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      if (!hiddenAt) return;
      const d = Date.now() - hiddenAt;
      hiddenAt = 0;
      if (d > 1500) {
        UI.appendLog({
          t: Date.now(), level: 'info',
          msg: '⏸ 标签页在后台待了 ' + (d / 1000).toFixed(1) + 's（后台标签会被降频/冻结，流程只能等着；' +
            '真机要跑就别切走，或把该站点加进「保持活跃」）',
        });
      }
    }
    try { document.addEventListener('visibilitychange', onVis); } catch (e) {}
    return function stop() {
      clearInterval(iv);
      try { document.removeEventListener('visibilitychange', onVis); } catch (e) {}
    };
  }

  UI.runTask = async function (task, btn) {
    if (UI._running) return;
    UI._running = true;
    const paceStop = startPaceWatch();
    const old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '执行中…'; }
    try {
      UI.currentTask = {
        record_id: task.record_id,
        table_id: task.table_id, script_id: task.script_id || '',
        // 服务端按 spec.scene.task_source.params 映射好的参数（引擎只负责透传，不认识参数含义）
        params: task.params || null,
        display: task.display || null,
        // 回写凭据：拉待办时服务端签好的（含 script_id），回写时原样带回 → 服务端零查表
        write_token: task.write_token || '',
      };
      const scene = SVC.scriptFor(UI.currentTask);
      // 任务摘要只取 scene.display 的第一个值（列名是业务侧声明的，Runner 不认识具体含义）
      const dk = task.display ? Object.keys(task.display) : [];
      const dv = dk.length ? task.display[dk[0]] : '';
      UI.appendLog({ t: Date.now(), level: 'info', msg: '载入任务：' + SVC.sceneView(scene).name + ' · ' + (dv || task.record_id) + '（' + task.record_id + '）' });
      // spec 三级取用：页面内存（本轮已载入）→ 本地持久缓存（跨标签页/跨重启）→ 联网取
      const memc = (UI._specCache && UI._specCache.script_id === scene) ? UI._specCache : null;
      const diskc = memc ? null : SVC.specCache.get(scene);
      let s = memc ? { spec: memc.spec, version: memc.version }
        : (diskc ? { spec_id: diskc.spec_id || scene, version: diskc.version, status: diskc.status || '', spec: diskc.spec } : null);
      if (!s) { s = await SVC.spec(scene); SVC.specCache.put(scene, s); }
      UI._specCache = { script_id: scene, spec: s.spec, version: s.version };
      UI.currentTask.spec_version = s.version;
      UI.applySpec(JSON.stringify(s.spec), { persist: true });
      // 只有需要往业务表回写的场景才探活后端 + 捂热那张表；纯填表场景两样都不做（少两次往返，也不再被捂表拖慢）
      const needWrite = wbModeOf(s.spec) === 'auto';
      if (needWrite) {
        // 预检后端：票据是一次性的，如果回写通道断了就别开跑（跑完写不回去等于白跑一趟）
        const tPing = Date.now();
        try { await SVC.ping(); }
        catch (e) {
          connOut = '<span style="color:#c02a0a">后端连不上：' + connEsc(e.message) + '</span> —— 本次不执行（避免票据白用一次）';
          UI.appendLog({ t: Date.now(), level: 'fatal', msg: '后端连不上（' + e.message + '），本次不执行：先把服务起来（temp-up / Workers），再点「重试连接」' });
          UI.renderConn();
          return;
        }
        const pingMs = Date.now() - tPing;
        // 只报慢的，快的不打——省得每单多一行噪音（也保住 golden 基线）
        if (pingMs > 800) UI.appendLog({ t: Date.now(), level: 'info', msg: '预检后端 ' + (pingMs / 1000).toFixed(1) + 's（/health 往返，慢在链路上）' });
        UI._warmTimer = SVC.warmStart(90000, scene); // 跑流程的十几秒里顺手把该场景的表捂热，回写时就快了
      }
      UI.appendLog({ t: Date.now(), level: 'ok', msg: '开始执行 ' + (s.spec_id || scene) + ' v' + s.version + '（任务参数已带入）' });
      await UI.doRun({ keepLog: true });
    } catch (e) {
      UI.appendLog({ t: Date.now(), level: 'fatal', msg: '执行失败（载入阶段）：' + e.message });
    } finally {
      UI._running = false;
      paceStop();
      // 预热是「跑的时候顺手捂热」，跑完就该停：实测它会在流程结束后继续每 6s 打一次 /health?warm=1，
      // 一个标签页挂 90s 就是十几枪白请求，还要跟真正的回写抢连接。
      try { clearInterval(UI._warmTimer); } catch (e) {}
      SVC.stopWarm();
      if (btn) { btn.disabled = false; btn.textContent = old || '执行'; }
      /* 本流程跑完再看一眼队列：后台回写若在跳转里被打断、而下一个页面又没及时注入，
       * 这里是最后一次自动补救的机会（不成功也只是留在队列里等人工点重试）。 */
      setTimeout(function () { autoFlushPending(); }, 1500);
    }
  };

  // 批量执行：串行跑一整批待办（ADS 会话全局，必须串行；每条仍是完整 S1→S6 流程 + 多标签页握手）
  UI.runBatch = async function (tasks, prog, runBtn, stopBtn) {
    if (UI._running) return;
    if (!tasks || !tasks.length) return;
    UI._running = true;
    UI._batchStop = false;
    if (runBtn) runBtn.style.display = 'none';
    if (stopBtn) { stopBtn.style.display = ''; stopBtn.disabled = false; stopBtn.textContent = '停止'; }
    const rows = Array.prototype.slice.call(document.querySelectorAll('#masr-task-list button[data-idx]'));
    rows.forEach(function (b) { b.disabled = true; });
    const total = tasks.length;
    // 场景视图：批量混场景在待办层已拦截，这里按首条定视图（列/场景名/必填字段）
    const view = SVC.sceneView((tasks[0] && tasks[0].script_id) || '');
    const keyOf = function (t) {
      if (!t) return '-';
      const f = view.columns[0].field;
      const v = (t.display && t.display[f] !== undefined) ? t.display[f]
        : (t.params && t.params[f] !== undefined) ? t.params[f] : t[f];
      return (v === null || v === undefined || v === '') ? '-' : v;
    };
    const specCache = {}; // 批内 spec 缓存：同批同场景只拉一次（省每条 2~4s 的飞书全表读）
    let okN = 0, failN = 0, skipN = 0, unknownN = 0, sessFail = 0, done = 0;
    const recs = [];
    const setProg = function () {
      if (prog) prog.textContent = '进度 ' + done + '/' + total + ' · 成功 ' + okN + ' / 失败 ' + failN + (skipN ? ' / 跳过 ' + skipN : '');
    };
    const batchStart = Date.now();
    setProg();
    UI.appendLog({ t: batchStart, level: 'info', msg: '=== 批量执行开始：共 ' + total + ' 条，串行处理（前台运行，勿切窗）===' });
    SVC.warmStart(120000, (tasks[0] && tasks[0].script_id) || ''); // 顺手把该场景的表捂热：首条回写可省 1~2s（失败静默）

    // 在途回写：批量里回写不阻塞下一条任务（回写走服务端→飞书，与 ADS 会话无关，天然可并行），
    // 收尾前统一等全部落定再出报告 —— 账目口径不变，只是把 3~4s/条 的干等挪到了后台。
    const writeSettles = [];

    // 等本条回写拿到飞书接口的真实结果：'written'（已落表）/ 'queued'（进待写队列）/ 'unknown'（等不到）
    // 回写 job 由发起页轮询器触发（1.5s 一个周期），所以先等它登记，再直接 await 那个 promise。
    async function settleWrite(rid) {
      if (!rid) return { status: 'norecord', msg: '' };
      if (!UI._writeJobs) UI._writeJobs = {};
      const jDeadline = Date.now() + 4000; // 等登记：轮询器周期 1.5s + 余量
      while (Date.now() < jDeadline && !UI._writeJobs[rid]) await delay(100);
      const job = UI._writeJobs[rid];
      if (!job) return { status: 'unknown', msg: '本轮未发起回写' };
      let r = null, tid = null;
      const timeoutP = new Promise(function (res) { tid = setTimeout(function () { res(null); }, 45000); });
      try {
        r = await Promise.race([job, timeoutP]);
      } catch (e) {
        r = { written: false, msg: String((e && e.message) || e) };
      } finally {
        if (tid) clearTimeout(tid);
      }
      delete UI._writeJobs[rid]; // 消费后删，避免堆积
      if (!r) return { status: 'unknown', msg: '回写 45s 未返回' };
      return { status: r.written ? 'written' : 'queued', msg: r.msg || '' };
    }

    for (let i = 0; i < total; i++) {
      if (UI._batchStop) { UI.appendLog({ t: Date.now(), level: 'warn', msg: '⏹ 用户中止，已处理 ' + done + '/' + total }); break; }
      const task = tasks[i];
      const rec = {
        idx: i + 1,
        keys: view.columns.map(function (c) { return { label: c.label, val: (task && task[c.field]) || '' }; }),
        record_id: (task && task.record_id) || '', ok: null, error: '', message: '', ms: 0, write: 'notrun', writeMsg: ''
      };
      recs.push(rec);
      const reqField = view.requireField || 'record_id';
      if (!task || !task[reqField]) {
        skipN++; done++; rec.ok = 'skip'; rec.write = 'skip'; setProg();
        UI.appendLog({ t: Date.now(), level: 'warn', msg: '[' + rec.idx + '/' + total + '] 跳过：必填字段为空（' + reqField + '，' + (rec.record_id || '无记录ID') + '）' });
        continue;
      }
      UI.appendLog({ t: Date.now(), level: 'info', msg: '▶ [' + rec.idx + '/' + total + '] ' + keyOf(task) + '（' + (task.record_id || '') + '）' });
      const t0 = Date.now();
      let r = { ok: null, error: '' };
      try { r = await runOneTask(task, specCache); }
      catch (e) { r = { ok: false, error: 'E_BATCH', message: e.message }; UI.appendLog({ t: Date.now(), level: 'fatal', msg: '[' + rec.idx + '/' + total + '] 异常：' + e.message }); }
      rec.ms = Date.now() - t0;
      rec.ok = r.ok; rec.error = r.error || ''; rec.message = r.message || '';
      if (r.ok === true) { okN++; sessFail = 0; }
      else if (r.ok === false) {
        failN++;
        if (/E_SESSION|E_AUTH|NO_AGENCY_CSRF|101133/.test(r.error || '')) sessFail++; else sessFail = 0;
      } else { unknownN++; sessFail = 0; } // 运行态提前清空，状态未知 → 不计入失败/连错
      done++; setProg();
      // 回写异步定态（不阻塞下一条）；「密钥取到了但没写进表」仍会在收尾报告前被抓住
      writeSettles.push(settleWrite(task.record_id).then(function (w) {
        rec.write = w.status; rec.writeMsg = w.msg || '';
        if (rec.write === 'queued') {
          UI.appendLog({ t: Date.now(), level: 'warn', msg: '↳ [' + rec.idx + '/' + total + '] ' + keyOf(task) + ' 回写未成功，已入本地待写队列（收尾点「重试回写」）' });
        } else if (rec.write === 'unknown') {
          UI.appendLog({ t: Date.now(), level: 'fatal', msg: '↳ [' + rec.idx + '/' + total + '] ' + keyOf(task) + ' 未检测到回写结果，需人工核对是否已落表' });
        }
      }));
      // 连续 2 条会话类失败 → 疑似登录态失效，硬停（避免把失败刷满、也避免反复触发登出）
      if (sessFail >= 2) {
        UI.appendLog({ t: Date.now(), level: 'fatal', msg: '⛔ 连续 2 条会话类失败，疑似登录态失效；已停止批量。请检查登录态后单独跑一条验证。' });
        break;
      }
      await delay(1200); // 等辅助标签页收摊、运行态清空，再开下一条
    }

    UI._running = false;
    UI._batchStop = false;
    if (runBtn) runBtn.style.display = '';
    if (stopBtn) { stopBtn.style.display = 'none'; stopBtn.disabled = false; stopBtn.textContent = '停止'; }
    rows.forEach(function (b) { b.disabled = false; });
    // 等所有在途回写落定，再出收尾报告（报告里的落表数必须是飞书的真实结果，不允许带猜）
    if (writeSettles.length) {
      UI.appendLog({ t: Date.now(), level: 'info', msg: '⏳ 等待全部回写落定（' + writeSettles.length + ' 条在途）…' });
      await Promise.allSettled(writeSettles);
    }
    UI.renderBatchReport(recs, { total: total, skipN: skipN, okN: okN, failN: failN, unknownN: unknownN, batchStart: batchStart, view: view });
    SVC.stopWarm();   // 批量跑完就停预热，别让定时器在后台一直打 /health?warm=1
  };

  // 批次收尾报告：失败清单（可一键复制）+ 对账 + 耗时/错误码分布
  UI.renderBatchReport = function (recs, s) {
    const esc = function (x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); };
    const fmtDur = function (ms) {
      if (!ms || ms < 0) return '0s';
      const sec = Math.round(ms / 1000);
      if (sec < 60) return sec + 's';
      const m = Math.floor(sec / 60), r = sec % 60;
      return m + 'm' + (r ? r + 's' : '');
    };
    const execRecs = recs.filter(function (r) { return r.ok !== 'skip'; });
    const failRecs = recs.filter(function (r) { return r.ok === false; });
    const skipRecs = recs.filter(function (r) { return r.ok === 'skip'; });
    const execN = execRecs.length;
    // 中途停止/会话失效硬停时，后面的任务根本没进 recs —— 必须单独计数，否则会误报"全部落表"
    const notYetN = Math.max(0, s.total - recs.length);
    const writtenN = recs.filter(function (r) { return r.write === 'written'; }).length;
    const queuedN = recs.filter(function (r) { return r.write === 'queued'; }).length;
    // norecord = 有账户ID但没 record_id，物理上无法回写，同样算未落账（否则账目对不上）
    const lostRecs = recs.filter(function (r) { return r.write === 'unknown' || r.write === 'notrun' || r.write === 'norecord'; });
    const lostN = lostRecs.length;
    const times = execRecs.filter(function (r) { return r.ms > 0; }).map(function (r) { return r.ms; });
    const sumMs = times.reduce(function (a, b) { return a + b; }, 0);
    const avgMs = times.length ? sumMs / times.length : 0;
    const byErr = {};
    failRecs.forEach(function (r) { const k = r.error || 'E_UNKNOWN'; byErr[k] = (byErr[k] || 0) + 1; });
    const errLine = Object.keys(byErr).sort(function (a, b) { return byErr[b] - byErr[a]; })
      .map(function (k) { return k + ' ×' + byErr[k]; }).join('、');
    const totalMs = Date.now() - s.batchStart;
    const view = s.view || { name: '批量', columns: [{ field: 'record_id', label: '记录' }] }; // 兼容旧调用：没传 view 时走保守缺省
    const keyLabels = view.columns.map(function (c) { return c.label; });

    // 结论只看一件事：实跑的每条，结果有没有真进飞书表
    let verdict, vColor;
    if (notYetN > 0) {
      verdict = '⏹ 批次未跑完：还有 ' + notYetN + ' 条没处理（已跑 ' + recs.length + '/' + s.total + '）' +
        (lostN ? '，另有 ' + lostN + ' 条未落账' : '') + ' —— 未处理的那批不在本次结果里';
      vColor = '#b8860b';
    } else if (lostN > 0) { verdict = '🔴 有 ' + lostN + ' 条未落账 —— 结果可能取到了但没进表，必须人工核对（见下方明细）'; vColor = '#c02a2a'; }
    else if (queuedN > 0) { verdict = '🟡 ' + queuedN + ' 条在本地待写队列 —— 点任务面板上方「重试回写」补写，补完才算完'; vColor = '#b8860b'; }
    else if (execN === 0) { verdict = '本次没有可执行的任务（全部跳过）'; vColor = '#8f959e'; }
    else { verdict = '✅ 全部已落表（' + writtenN + '/' + execN + '），账目清晰'; vColor = '#1a7f45'; }

    const head = '批量结果 · ' + new Date().toLocaleString('zh-CN');
    let html = '<div style="margin-top:8px;padding:8px;border:1px solid #d9dde3;border-radius:6px;background:#fafbfc;font-size:11px;line-height:1.7">' +
      '<div style="font-weight:600;margin-bottom:4px">' + esc(head) + '</div>' +
      '<div>对账：选中 <b>' + s.total + '</b> · 实跑 <b>' + execN + '</b> · 跳过 <b>' + skipRecs.length + '</b></div>' +
      '<div>' + esc(view.name) + '：成功 <b style="color:#1a7f45">' + s.okN + '</b> / 失败 <b style="color:#c02a2a">' + s.failN + '</b>' + (s.unknownN ? ' / 状态未知 <b>' + s.unknownN + '</b>' : '') + '</div>' +
      '<div>回写飞书：已落表 <b>' + writtenN + '</b> / 待补写 <b>' + queuedN + '</b> / 未落账 <b style="color:' + (lostN ? '#c02a2a' : '#1a7f45') + '">' + lostN + '</b></div>' +
      '<div style="color:' + vColor + ';font-weight:600;margin:3px 0">' + esc(verdict) + '</div>' +
      '<div style="color:#5c6672">耗时：总 ' + fmtDur(totalMs) + ' · 平均 ' + (avgMs / 1000).toFixed(1) + 's/条' +
        (times.length ? ' · 最快 ' + (Math.min.apply(null, times) / 1000).toFixed(1) + 's · 最慢 ' + (Math.max.apply(null, times) / 1000).toFixed(1) + 's' : '') + '</div>' +
      (errLine ? '<div style="color:#5c6672">失败错误码：' + esc(errLine) + '</div>' : '');

    // 失败清单（含未落账 —— 后者更要紧：跑了、也可能取到了，但没进表）
    const needRows = failRecs.concat(lostRecs.filter(function (r) { return r.ok !== false && r.ok !== 'skip'; }));
    if (needRows.length) {
      html += '<div style="margin-top:6px"><b>需处理明细（' + needRows.length + ' 条）</b>' +
        '<table style="margin-top:3px"><tr><th>#</th>' + keyLabels.map(function (lb) { return '<th>' + esc(lb) + '</th>'; }).join('') + '<th>结论</th><th>原因</th></tr>' +
        needRows.map(function (r) {
          const what = r.ok === false ? esc(view.name) + '失败' : '未落账';
          const why = r.ok === false ? (r.error + (r.message ? '：' + r.message : ''))
            : (r.write === 'norecord' ? '缺少 record_id，无法回写' : ('回写状态未确认' + (r.writeMsg ? '（' + r.writeMsg + '）' : '')));
          return '<tr><td>' + r.idx + '</td>' + (r.keys || []).map(function (k) { return '<td>' + esc(k.val || '-') + '</td>'; }).join('') +
            '<td style="color:' + (r.ok === false ? '#c02a2a' : '#b8860b') + '">' + what + '</td><td>' + esc(why.slice(0, 90)) + '</td></tr>';
        }).join('') + '</table></div>';
    }
    if (skipRecs.length) {
      html += '<div style="margin-top:4px;color:#8f959e">跳过 ' + skipRecs.length + ' 条（必填字段缺失）：' +
        skipRecs.map(function (r) { return esc(r.record_id || '-'); }).join('、') + '</div>';
    }
    html += '<div style="margin-top:6px"><button id="masr-batch-copy">复制结果清单</button>' +
      '<span id="masr-batch-copy-tip" style="margin-left:6px;color:#8f959e"></span></div></div>';

    const box = document.getElementById('masr-batch-report');
    if (box) box.innerHTML = html;

    // 复制用纯文本：直接粘到群里/文档里就能交接
    const buildText = function () {
      const L = [];
      L.push('华为ADS ' + view.name + ' · 批量结果  ' + new Date().toLocaleString('zh-CN'));
      L.push('对账：选中 ' + s.total + ' · 实跑 ' + execN + ' · 跳过 ' + skipRecs.length);
      L.push(view.name + '：成功 ' + s.okN + ' / 失败 ' + s.failN + (s.unknownN ? ' / 状态未知 ' + s.unknownN : ''));
      L.push('回写飞书：已落表 ' + writtenN + ' / 待补写 ' + queuedN + ' / 未落账 ' + lostN);
      if (notYetN > 0) L.push('未处理：' + notYetN + ' 条（批次中止，未执行）');
      L.push('耗时：总 ' + fmtDur(totalMs) + ' · 平均 ' + (avgMs / 1000).toFixed(1) + 's/条');
      if (errLine) L.push('失败错误码：' + errLine);
      if (needRows.length) {
        L.push('');
        L.push('需处理明细（' + needRows.length + ' 条）：');
        needRows.forEach(function (r) {
          const why = r.ok === false ? (r.error + (r.message ? ' ' + r.message : ''))
            : ('未落账 ' + (r.write === 'norecord' ? '缺 record_id' : (r.writeMsg || '')));
          L.push(r.idx + '. ' + (r.keys || []).map(function (k) { return k.val || '-'; }).join('\t') + '\t' + why);
        });
      }
      if (skipRecs.length) L.push('跳过（必填字段缺失）：' + skipRecs.map(function (r) { return r.record_id || '-'; }).join('、'));
      return L.join('\n');
    };
    const cp = document.getElementById('masr-batch-copy');
    if (cp) cp.addEventListener('click', function () {
      const txt = buildText();
      const tip = document.getElementById('masr-batch-copy-tip');
      const ok = function () { if (tip) { tip.textContent = '已复制 ✓'; setTimeout(function () { tip.textContent = ''; }, 2000); } };
      const fb = function () {
        const ta = document.createElement('textarea');
        ta.value = txt; ta.style.position = 'fixed'; ta.style.left = '-9999px'; ta.style.top = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); ok(); } catch (e) { if (tip) tip.textContent = '复制失败，请手动选中下方文本'; }
        document.body.removeChild(ta);
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(ok, fb);
        else fb();
      } catch (e) { fb(); }
    });

    // 日志里也留一份摘要（跨页保留，事后能翻）
    UI.appendLog({ t: Date.now(), level: lostN ? 'fatal' : (queuedN ? 'warn' : 'ok'),
      msg: '=== 批量结束：实跑 ' + execN + '/' + s.total + ' · 成功 ' + s.okN + ' / 失败 ' + s.failN +
        ' · 已落表 ' + writtenN + (queuedN ? ' / 待补写 ' + queuedN : '') + (lostN ? ' / 未落账 ' + lostN : '') +
        ' · 总耗时 ' + fmtDur(totalMs) + ' ===' });
    if (needRows.length) {
      UI.appendLog({ t: Date.now(), level: 'warn', msg: '↳ 需处理 ' + needRows.length + ' 条：' +
        needRows.map(function (r) { return ((r.keys && r.keys[0].val) || '-') + '(' + (r.ok === false ? r.error : '未落账') + ')'; }).join('、') });
    }
  };

  function delay(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  // 跑单条任务（与 runTask 同流程，但可 await 完成，并回传结果），供批量串行复用。
  // specCache（可选）：批内 spec 缓存 {scene, s} —— 同批同场景只拉一次，
  // 省掉每条 2~4s 的「服务端→飞书全表读」；spec 中途发版只会影响下一个批次（版本已锁定在日志里）。
  async function runOneTask(task, specCache) {
    UI.currentTask = {
      record_id: task.record_id,
      table_id: task.table_id, script_id: task.script_id || '',
      write_token: task.write_token || '',
    };
    {
      try { await SVC.ping(); }
      catch (e) { UI.appendLog({ t: Date.now(), level: 'fatal', msg: '后端连不上（' + e.message + '），中止批量' }); throw e; }
    }
    const scene = SVC.scriptFor(UI.currentTask);
    let s = specCache && specCache.scene === scene ? specCache.s : null;
    if (s) {
      UI.appendLog({ t: Date.now(), level: 'info', msg: 'spec 命中批内缓存：' + s.spec_id + ' v' + s.version + '（跳过服务端拉取）' });
    } else {
      s = await SVC.spec(scene);
      if (specCache) { specCache.scene = scene; specCache.s = s; }
    }
    UI.currentTask.spec_version = s.version;
    UI.applySpec(JSON.stringify(s.spec), { persist: true });
    UI.appendLog({ t: Date.now(), level: 'ok', msg: '开始执行 ' + s.spec_id + ' v' + s.version + '（任务参数已带入）' });
    await UI.doRun({ keepLog: true });
    return await waitRunDone();
  }

  // 等待本轮流程结束：监听 RunState.final（发起页轮询消费后置位），超时返回 E_TIMEOUT
  function waitRunDone(timeoutMs) {
    timeoutMs = timeoutMs || 180000;
    const start = Date.now();
    return new Promise(function (resolve) {
      const iv = setInterval(function () {
        let s = null;
        try { s = RunState.get(); } catch (e) { s = null; }
        if (s && s.final) {
          clearInterval(iv);
          resolve({ ok: !!s.final.ok, error: s.final.error || '', message: s.final.message || '' });
          return;
        }
        if (Date.now() - start > timeoutMs) { clearInterval(iv); resolve({ ok: false, error: 'E_TIMEOUT', message: '等待结果超时（' + (timeoutMs / 1000) + 's）' }); return; }
        // RunState 已清空（最终态被发起页消费后清理）→ 视为本轮已结束，但状态未知
        if (!s && Date.now() - start > 3000) { clearInterval(iv); resolve({ ok: null, error: '', message: '运行态已清空' }); return; }
      }, 600);
    });
  }

  // 执行完成 → 回写飞书（按 record_id 更新，服务端二次校验归属）
  /* 回写失败不丢结果：落本地待办队列，服务恢复后一键重试（本机验证服务常被关掉） */
  const PENDW_KEY = 'masr_pending_writes_v1';
  function pwList() { try { return JSON.parse(GM_getValue(PENDW_KEY, '[]')) || []; } catch (e) { return []; } }
  function pwSave(arr) { try { GM_setValue(PENDW_KEY, JSON.stringify(arr.slice(-100))); } catch (e) {} } // 上限 100：批量一次 50 条，留 20 会丢掉最早的结果
  function pwAdd(payload) {
    const a = pwList();
    /* 一条记录只留一条待写：失败重跑会越堆越多，而「重试回写」是按顺序逐条 PUT 的，
     * 同一条记录的多份 payload 会互相覆盖，最后落表的可能反而是早就作废的那份。 */
    const i = a.findIndex(function (p) { return p && p.record_id === payload.record_id; });
    const item = Object.assign({}, payload, { queued_at: Date.now() });
    if (i >= 0) a[i] = item; else a.push(item);
    pwSave(a);
  }
  /* 出队：后台回写成功后才调用。失败一律留在队列里——队列就是「还没进表」的唯一真值。 */
  function pwDel(record_id) {
    pwSave(pwList().filter(function (p) { return !p || p.record_id !== record_id; }));
  }

  /* 「这条记录的成功结果已经进表了」的跨页凭证。
   * 为什么需要：回写改成异步后，成功可能发生在**上一张页面**（S5 入队 → S6 退出跳转 → 下个页面补写成功），
   * 而 RunState 在交接时已被清空/冻结，收尾步骤再失败时拿不到 wbDone.written，
   * 就会把表改写成「失败」——业务看到失败会重跑一条、多建一个成员（2026-11-06 真机踩过这个坑）。
   * sessionStorage 在同标签页导航后仍然存活，正好覆盖「跳转之后才知道写成功了」这段窗口。 */
  const WB_OK_KEY = 'masr_wb_ok_v1';
  function wbOkList() {
    try { return JSON.parse(sessionStorage.getItem(WB_OK_KEY) || '[]') || []; } catch (e) { return []; }
  }
  function markWbOk(record_id) {
    if (!record_id) return;
    try {
      const a = wbOkList().filter(function (x) { return x && x.id !== record_id; });
      a.push({ id: record_id, at: Date.now() });
      sessionStorage.setItem(WB_OK_KEY, JSON.stringify(a.slice(-20)));
    } catch (e) {}
  }
  function wbOkRecent(record_id, ms) {
    if (!record_id) return false;
    const t = Date.now() - (ms || 30 * 60 * 1000);
    return wbOkList().some(function (x) { return x && x.id === record_id && (x.at || 0) >= t; });
  }

  /* 回写：超时/断连自动再试一次（这类失败九成是连接抖了一下，重试就过；见 service fsFetch 注释） */
  async function writeWithRetry(payload, tries) {
    tries = tries || 2;
    let lastErr = null;
    let notReadyTries = 0;
    for (let i = 0; i < tries; i++) {
      try { return await SVC.writeResult(payload); }
      catch (e) {
        lastErr = e;
        const s = String((e && e.message) || e);
        /* 飞书 1254607「Data not ready, please try again later」是**瞬时**的：刚建/刚改过的
         * 记录索引还没就绪，隔一两秒再 PUT 基本就过。2026-11-06 真机 S5 就撞上它：整条流程
         * 带着「表里没写」继续往下走，P3 只能靠交接随行参数兜，表里一直是旧状态。
         * 这类失败单独给两次机会（1s/2s），且不占用「换连接」的次数。 */
        if (/1254607|Data not ready/i.test(s) && notReadyTries < 2) {
          notReadyTries++;
          UI.appendLog({ t: Date.now(), level: 'warn',
            msg: '飞书返回 1254607（Data not ready，索引未就绪），' + notReadyTries + ' 秒后自动重试…' });
          await sleep(notReadyTries * 1000);
          i--;                        // 不消耗本轮尝试次数，由 notReadyTries 单独封顶
          continue;
        }
        const transient = /E_FS_TIMEOUT|E_FS_NET|E_SVC_TIMEOUT|E_SVC_NET/.test(s);
        if (i === tries - 1 || !transient) throw e;
        UI.appendLog({ t: Date.now(), level: 'warn', msg: '回写超时/断连，1 秒后自动重试一次…' });
        await sleep(1000);
      }
    }
    throw lastErr;
  }

  /* 回写字段核对：HTTP 200 只说明「这次请求成了」，不说明「每个字段都进表了」。
   * 服务端按 spec.scene.writeback 逐字段渲染模板，**解析为空就跳过该字段**（避免抹掉已有值），
   * 且照样返回 200。2026-11-06 真机就是这么静默丢字段的：模板写成 {{account_email}}
   * （少了 outputs. 前缀）→ 取不到值 → 「开户状态」写进去、「邮箱账号」永远空着，
   * 日志却显示「已回写成功」。用户看到的就是「状态有了，邮箱没写，是不是没存」。
   * 所以要拿服务端返回的 written（实际写入的字段名）跟 spec 声明对一遍，少了就点名报出来。 */
  function wbDeclared(st, ok) {
    try {
      const sp = st && st.specJson ? JSON.parse(st.specJson) : null;
      const wb = sp && sp.scene && sp.scene.writeback;
      const blk = wb ? wb[ok ? 'ok' : 'fail'] : null;
      return (blk && typeof blk === 'object' && Object.keys(blk).length) ? Object.keys(blk) : null;
    } catch (e) { return null; }
  }
  function wbMissing(declared, written) {
    if (!declared || !Array.isArray(written) || !written.length) return [];
    return declared.filter(function (k) { return written.indexOf(k) < 0; });
  }
  function warnMissingFields(declared, written, tag) {
    const miss = wbMissing(declared, written);
    if (!miss.length) return;
    UI.appendLog({
      t: Date.now(), level: 'warn',
      msg: '⚠️ ' + (tag || '回写') + '只写进 ' + written.length + ' 个字段，这几个**没写**：' + miss.join('、') +
        '——多半是回写模板里的占位符取不到值（业务值要写 {{outputs.xxx}}，裸写会被当成空）或值本身为空。' +
        '表里这几列仍是旧值，别当成已经写好',
    });
  }

  // 回写一条任务结果。返回 Promise<{written, msg}> —— 批量直接 await 这个真实结果，不用轮询猜状态。
  // 原有调用方（发起页轮询器 / 失败分支）不 await，行为与之前一致。
  function pushTaskResult(st, ok, outputs, err, opt) {
    const task = st && st.task;
    if (!task || !task.record_id) return Promise.resolve({ written: false, msg: 'no-record' });
    const job = (async function () {
      /* 失败结果不许盖掉「还没补写成功的成功结果」。
       * 真机 2026-11-06：S5 的「管理式导入完成」因 1254607 进了待写队列，几分钟后 P3 的
       * 收尾步骤失败，一条 fail 把同一条记录写成了「失败」——业务看到失败会以为成员没建成，
       * 于是重跑一条、多建一个成员。队列里已有同记录的 ok，就以 ok 为准：这次 fail 不写。 */
      if (!ok) {
        const pendingOk = pwList().filter(function (p) {
          return p && p.record_id === task.record_id && p.status === 'ok';
        });
        if (pendingOk.length) {
          UI.appendLog({
            t: Date.now(), level: 'warn',
            msg: '这条记录的成功结果还在本地待写队列里（未补写成功），本次失败不覆盖它：' +
              '请点「重试回写」把成功状态补进表，再人工确认这次失败是否需要处理',
          });
          return { written: true, skipped: true, msg: 'pending-ok' };
        }
        /* 异步化之后还有一个更晚的窗口：成功结果**已经**被后台写进表、队列也清了，
         * 之后收尾步骤才失败。这时队列里查不到，但 sessionStorage 里留着成功凭证。
         * 没有这一条，异步回写会把「不覆盖成功」的保护撕开一个洞。 */
        if (wbOkRecent(task.record_id)) {
          UI.appendLog({
            t: Date.now(), level: 'warn',
            msg: '这条记录的成功结果已经写进表了（本页或上一页后台写成功），本次失败不覆盖它：' +
              '表里保留成功状态，失败原因只在面板上提示，请人工确认这一处是否需要处理',
          });
          return { written: true, skipped: true, msg: 'ok-already-written' };
        }
      }
      // v0.5.0：不再拼任何业务字段名。只上报「成功/失败 + outputs」，
      // 写什么列、写什么值，由服务端按该 spec 的 scene.writeback 渲染（Runner 零场景知识）。
      const payload = {
        record_id: task.record_id,
        // 透传：这条记录从 /tasks 下来就带着凭据（含 script_id），回写只做一次 PUT，服务端不再回读记录
        write_token: task.write_token || '',
        status: ok ? 'ok' : 'fail',
        values: outputs || {},
        elapsed_ms: Date.now() - (st.startedAt || Date.now()),
        runner_version: GV.RUNNER_VERSION,
        spec_version: st.specVersion || '',
      };
      if (!ok) {
        payload.error_type = ENGINE.failReason(err);
        payload.error_message = (err && (err.message || err.code)) || '';
      }
      /* ── 后台回写（opt.background）：先落盘、再发请求、不等结果 ──────────────
       * 为什么要有这条路径：S5 交接准备必须写表（下一段流程要读），而一次回写要串行打三次
       * 飞书（读 spec → 复验记录 → PUT），撞上 1254607 重试能拖 40~50s（真机 48.9s）。
       * 这段等待纯粹是「等表写好」，页面本身已经没事干了——退出登录、交接下一段都不依赖它。
       * 所以：结果先写进本机队列（跨页/断网/标签被关都不丢），再异步发；主线立刻往下走。
       * 请求若被页面跳转打断，下一个页面启动时 autoFlushPending 会自己补写。 */
      if (opt && opt.background) {
        payload._expect_fields = wbDeclared(st, ok) || undefined;
        pwAdd(payload);          // 先落盘：这一步成功了，后面无论怎么断都不会丢
        UI.appendLog({ t: Date.now(), level: 'info',
          msg: '结果已存入本机队列，后台开始回写（不阻塞流程，页面继续往下走）' });
        const bgJob = (async function () {
          const t0 = Date.now();
          try {
            const wr = await writeWithRetry(payload);
            pwDel(task.record_id);        // 真写成功才出队
            markWbOk(task.record_id);
            const wrote = !wr || !Array.isArray(wr.written) || wr.written.length > 0;
            UI.appendLog({
              t: Date.now(), level: 'ok',
              msg: (wrote ? '✅ 后台回写完成（上报状态=' + (ok ? '成功' : '失败 ' + payload.error_type) + '）'
                : '本场景该分支声明不回写（业务表无对应字段），已跳过写入') +
                '（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）',
            });
            warnMissingFields(wbDeclared(st, ok), (wr && wr.written) || [], '回写');
            if (!UI._running) UI.renderTasks();
            return { written: true, skipped: !wrote, background: true, msg: '' };
          } catch (e) {
            const msg = String((e && e.message) || e);
            UI.appendLog({
              t: Date.now(), level: 'fatal',
              msg: '⚠️ 后台回写失败：' + msg + ' —— 结果仍在本机队列（不会丢），到「任务」行点「重试回写」补写',
            });
            if (!UI._running) UI.renderTasks();
            updResultWarn(pwList().length);
            return { written: false, background: true, msg: msg };
          }
        })();
        if (!UI._writeJobs) UI._writeJobs = {};
        UI._writeJobs[task.record_id] = bgJob;
        /* 对外语义仍是「这条已经处理了、收尾别再发一次」；是否真写成功由 background/queued 表达 */
        return Promise.resolve({ written: true, queued: true, background: true, job: bgJob, msg: '' });
      }
      const t0 = Date.now();
      UI.appendLog({ t: t0, level: 'info', msg: '→ 正在回写飞书（' + task.record_id + '）…' });
      try {
        const wr = await writeWithRetry(payload);
        /* 服务端可能「按声明故意不写」：例如 writeback.fail 声明为空对象（业务表没有失败态字段），
         * 它返回 written: []。这时候打印「已回写成功」是假的——表里一个字段都没动。
         * 业务上两者差别很大：真写了才会看到「开户状态」变化，没写就得人工去表里补。 */
        const wrote = !wr || !Array.isArray(wr.written) || wr.written.length > 0;
        UI.appendLog({
          t: Date.now(), level: 'ok',
          /* 文案歧义修正：原先写「✅ 已回写飞书：失败」——「失败」到底是「回写失败」还是
           * 「回写的是一次失败结果」，读的人分不清（2026-11-06 用户当场提出）。
           * 现在把「请求成功」和「上报的状态」拆成两截说。 */
          msg: (wrote ? '✅ 已回写飞书（请求成功，上报状态=' + (ok ? '成功' : '失败 ' + payload.error_type) + '）'
            : '本场景该分支声明不回写（业务表无对应字段），已跳过写入') +
            '（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）'
        });
        if (!UI._running) UI.renderTasks();
        /* 字段级核对：写了几个、少了哪几个，当场说清（见 wbDeclared 上方注释） */
        warnMissingFields(wbDeclared(st, ok), (wr && wr.written) || [], '回写');
        /* written 的语义是「这次回写已经处理完、收尾不要再发一次」，不是「字段真的写了」。
         * 空分支（noop）也算处理完——否则收尾会再发一遍请求。是否真写用 skipped 表达。 */
        return { written: true, skipped: !wrote, msg: '' };
      } catch (e) {
        /* 带上「这次该写哪些字段」，补写成功后同样能核对，不至于补完还静默漏列 */
        payload._expect_fields = wbDeclared(st, ok) || undefined;
        pwAdd(payload);
        const msg = String((e && e.message) || e);
        const local = /127\.0\.0\.1|localhost/.test(SVC.base() || '');
        // 分清是谁的问题：后端连不上飞书 ≠ 本机服务没跑 ≠ 结果本身有问题
        let hint;
        if (/E_FS_TIMEOUT|E_FS_NET/.test(msg)) hint = '（后端连飞书超时/被网络掐了，与结果本身无关）';
        else if (/E_FS_TOKEN|E_FS_API|E_FS_PARSE/.test(msg)) hint = '（飞书接口报错，看括号里的错误码）';
        else if (/E_SVC_NET|E_SVC_TIMEOUT/.test(msg)) hint = local ? '（本机验证服务没在跑？起来后点「重试回写」即可）' : '（连不上后端，恢复后点「重试回写」）';
        else hint = '';
        UI.appendLog({
          t: Date.now(), level: 'fatal',
          msg: '⚠️ 回写飞书失败：' + msg + hint +
            ' —— 该结果已存本地待写队列，不会丢'
        });
        if (!UI._running) UI.renderTasks();
        updResultWarn(pwList().length);
        return { written: false, msg: msg };
      }
    })();
    // 登记 job：批量收尾用 UI._writeJobs[record_id] 直接 await 到飞书接口的真实返回
    if (!UI._writeJobs) UI._writeJobs = {};
    if (Object.keys(UI._writeJobs).length > 200) UI._writeJobs = {}; // 兜底，正常每条消费后即删
    UI._writeJobs[task.record_id] = job;
    return job;
  }
  function updResultWarn(n) {
    const el = document.getElementById('masr-result');
    if (!el || !n) return;
    const tip = document.createElement('div');
    tip.style.cssText = 'margin-top:6px;padding:6px 8px;border:1px solid #f0d8a8;background:#fff8e8;border-radius:6px;font-size:11px;color:#8a6412';
    tip.textContent = '有 ' + n + ' 条结果未写进飞书（已存本地）。服务恢复后到「任务」那一行点「重试回写」。';
    el.appendChild(tip);
  }

  UI.retryWrites = async function (btn) {
    const all = pwList();
    if (!all.length) { UI.renderTasks(); return; }
    if (btn) { btn.disabled = true; btn.textContent = '重试中…'; }
    const left = [];
    let okN = 0;
    for (const p of all) {
      const body = Object.assign({}, p);
      const expect = body._expect_fields || null;
      delete body.queued_at;
      delete body._expect_fields;          // 只在本地产物里，不往服务端发
      try {
        const wr = await writeWithRetry(body, 2);
        okN++;
        UI.appendLog({ t: Date.now(), level: 'ok', msg: '✅ 补写成功：' + body.record_id });
        /* 补写成功 ≠ 字段补齐：模板取不到值时服务端照样 200 却跳过该字段 */
        warnMissingFields(expect, (wr && wr.written) || [], '补写');
      } catch (e) {
        left.push(p);
        UI.appendLog({ t: Date.now(), level: 'fatal', msg: '⚠️ 补写仍失败：' + body.record_id + ' · ' + e.message });
      }
    }
    pwSave(left);
    UI.appendLog({ t: Date.now(), level: okN ? 'ok' : 'warn', msg: '重试完成：成功 ' + okN + ' 条，剩余 ' + left.length + ' 条' });
    UI.renderTasks();
  };

  /* 启动时自动补写队列：上一张页面把结果塞进队列就跳走了（S5 入队 → S6 退出 → 整页跳转），
   * 在途请求会被导航打断，队列里就留一条。这件事不该让人知道——下次注入时自己补上就行。
   * 为什么只补 30 分钟内的：更早的多半是当时后端就没起来，硬撞只会一条条超时，
   * 那种情况留给人点「重试回写」（有人看着，能判断是不是服务没开）。 */
  let _autoFlush = false;
  async function autoFlushPending() {
    /* 不因为「页面正在跑流程」就跳过：补写走的是后台 HTTP，不碰 DOM、不参与步骤编排，
     * 和下一段流程可以并行。反倒是跳过之后没人再触发，队列会一直躺到下次页面加载。 */
    if (_autoFlush || !SVC.base()) return;
    const all = pwList().filter(function (p) {
      return p && p.record_id && (Date.now() - (p.queued_at || 0)) < 30 * 60 * 1000;
    });
    if (!all.length) return;
    _autoFlush = true;
    UI.appendLog({ t: Date.now(), level: 'info',
      msg: '发现 ' + all.length + ' 条结果还没进表（上一次被页面跳转打断了），后台自动补写…' });
    for (const p of all) {
      const body = Object.assign({}, p);
      const expect = body._expect_fields || null;
      delete body.queued_at;
      delete body._expect_fields;          // 只在本地产物里，不往服务端发
      try {
        const wr = await writeWithRetry(body, 1);
        pwDel(body.record_id);
        markWbOk(body.record_id);
        UI.appendLog({ t: Date.now(), level: 'ok', msg: '✅ 自动补写成功：' + body.record_id });
        warnMissingFields(expect, (wr && wr.written) || [], '自动补写');
      } catch (e) {
        UI.appendLog({ t: Date.now(), level: 'warn',
          msg: '自动补写没成功（' + String((e && e.message) || e) + '）：结果还在本机队列，' +
            '稍后到「任务」行点「重试回写」补写' });
        break;   // 服务多半不通，别一条条硬撞
      }
    }
    _autoFlush = false;
    updResultWarn(pwList().length);
    if (!UI._running) UI.renderTasks();
  }

  /* 参数取值：只认服务端按 spec.scene.task_source.params 映射好的 params。
   * v0.5.0 删掉了「参数名 → 账户ID」那类业务特判——参数名映射属于场景，不该写在引擎里。 */
  UI.taskParamValue = function (name) {
    const t = UI.currentTask || {};
    if (name === 'record_id' || name === '$record_id') return t.record_id || '';
    if (t.params && t.params[name] !== undefined && t.params[name] !== null) return String(t.params[name]);
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
        /* 凭据类参数（secret:true）在面板上一律打码：面板会被截屏、录屏、共享屏幕，
         * 贴到群里求助时密码就跟着出去了。打码只影响展示，实际执行用的仍是原值。 */
        const secret = p.secret === true;
        if (auto) {
          const shown = secret ? (String(ENGINE.maskValue(auto)) + '（已打码）') : auto;
          return '<div class="row"><label>' + esc(p.label || p.name) + '：</label>' +
            '<code style="background:#f2f3f5;padding:1px 6px;border-radius:4px">' + esc(shown) + '</code>' +
            '<span style="font-size:10px;color:#8f959e;margin-left:6px">任务行</span></div>';
        }
        // 数据源参数（如 子客ID）：不再提供人工输入框，只能由任务行带入 —— 抄错账户ID会跑到别人头上
        if (p.source === 'manual') {
          // secret 的手工输入框用 password 类型，且不回填历史值（不把密码留在本机 DOM 里）
          return '<div class="row"><label>' + esc(p.label || p.name) + ' (' + p.name + ')：</label>' +
            '<input id="masr-p-' + p.name + '" type="' + (secret ? 'password' : 'text') + '" autocomplete="off"' +
            ' value="' + esc(secret ? '' : (last[p.name] || '')) + '" placeholder="' + esc(p.description || '') + '"></div>';
        }
        return '<div class="row"><label>' + esc(p.label || p.name) + '：</label>' +
          '<span style="font-size:11px;color:#5a6b87">由任务带入（从「任务」点待办的「执行」或「批量执行」时自动填充）</span></div>';
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
      UI.renderSpecBadge(spec);
      UI.renderParams(spec);
      document.getElementById('masr-run').textContent = spec.status === 'active' ? '重跑当前 spec' : '执行（draft → dry_run）';
      // 自动恢复（fromStore）静默处理：只更新 badge/参数表，不往跨页日志里灌噪音
      // 同一份 spec 重复 apply 也不重复播报：URL 触发 → runTask 会把同一份 spec 载两遍，
      // 日志里出现两条一模一样的「spec 已加载」会让人以为加载了两次、版本可能不同
      const specKey = String(spec.spec_id) + '@' + String(spec.version) + '#' + ENGINE.strHash(text);
      if (!opts.fromStore && UI._lastSpecKey !== specKey) {
        UI.appendLog({ t: Date.now(), level: 'ok', msg: 'spec 已加载: ' + spec.spec_id + ' v' + spec.version + '，' + spec.steps.length + ' 步' });
      }
      UI._lastSpecKey = specKey;
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

  // 复制日志为纯文本（从 LogStore 取权威数据：含跨页历史，不带 HTML 标记）
  UI.copyLogs = function () {
    const entries = LogStore.get();
    if (!entries.length) { alert('暂无日志可复制'); return; }
    const text = entries.map(function (e) {
      const d = new Date(e.t);
      const pad = function (n) { return (n < 10 ? '0' : '') + n; };
      return '[' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '] ' + e.msg;
    }).join('\n');
    const done = function () { UI.appendLog({ t: Date.now(), level: 'ok', msg: '已复制 ' + entries.length + ' 条日志到剪贴板' }); };
    // GM_setClipboard 不受页面 CSP/焦点限制，最可靠；没有时退回 execCommand 方案
    if (typeof GM_setClipboard === 'function') { GM_setClipboard(text); done(); return; }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    if (ok) done(); else alert('复制失败：请手动选中日志区文本复制');
  };

  // ---------- 自更新 ----------
  // 油猴自己会按 @updateURL 定期拉新（默认一天一次），但「装完之后当前页面还在跑旧代码」
  // 是它的固有行为：脚本只在新页面加载时才注入。这里补上最后一步——装完切回来自动重载。
  function cmpVer(a, b) {
    const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }
  const UPD = {
    PEND_KEY: 'masr_upd_pending_v1', // { ver, url, at, tries, stale }
    CHK_KEY: 'masr_upd_checked_at_v1',
    SEEN_KEY: 'masr_upd_seen_ver_v1',
  };
  function pendGet() { try { return JSON.parse(GM_getValue(UPD.PEND_KEY, 'null')); } catch (e) { return null; } }
  function pendSet(o) { try { GM_setValue(UPD.PEND_KEY, JSON.stringify(o)); } catch (e) {} }
  function pendClear() { try { GM_deleteValue(UPD.PEND_KEY); } catch (e) {} }

  // 有新版本时在悬浮球上点一颗红点：不打扰，但一眼能看到
  function setUpdateDot(on, ver) {
    const ball = document.getElementById('masr-ball');
    if (!ball) return;
    const cur = UI.installedVersion();
    let dot = document.getElementById('masr-dot');
    if (on) {
      if (!dot) {
        dot = document.createElement('span');
        dot.id = 'masr-dot';
        ball.appendChild(dot);
      }
      dot.title = '有新版本 v' + (ver || '') + ' 可更新';
      ball.title = 'MAS-Runner v' + cur + '｜有新版本 v' + (ver || '') + '（点击打开/收起）';
    } else {
      if (dot) dot.remove();
      ball.title = 'MAS-Runner v' + cur + '（点击打开/收起）';
    }
  }
  UI.setUpdateDot = setUpdateDot;

  function updOut(html) {
    const out = document.getElementById('masr-update-out');
    if (out) { out.innerHTML = html; out.title = out.textContent || ''; }
  }

  // 检查结果落到「检查更新」按钮上：有新版就把按钮变成「更新 vX」，点一下就走安装
  function applyUpdateState(ver) {
    const btn = document.getElementById('masr-check-update');
    UI._newVer = ver || '';
    if (!btn) return;
    if (ver) {
      btn.textContent = '更新 v' + ver;
      btn.classList.add('primary');
      btn.title = '打开安装页升级到 v' + ver + '（装完切回本页会自动重载）';
      setUpdateDot(true, ver);
    } else {
      btn.textContent = '检查更新';
      btn.classList.remove('primary');
      btn.title = '检查解释器有没有新版本';
      setUpdateDot(false);
    }
  }

  /* 从 manifest 的地址推出「同一源上的脚本地址」。
   * 为什么不用 manifest 里的 install_url：那个字段永远指向自建分发地址，
   * 而自建地址的版本恰恰可能因为 KV 没刷新而落后 —— 这时候点「更新」会被送回旧版，
   * 就是用户嘴里的「点了更新还是拉不到最新版」。用胜出那条源自己的地址，才能绕开坏指针。 */
  function installUrlOf(r) {
    const u = String((r && r.url) || '');
    if (/\/manifest\.json(\?|$)/.test(u)) return u.replace(/manifest\.json(\?|$)/, 'mas-runner.user.js');
    return (r && r.m && r.m.install_url) || GV.INSTALL_URL;
  }

  /* 更新检查：并发问所有源，取「版本最大」的那个。
   * 旧实现是「见第一个 200 就 return」，看似省事，实则自欺：自建源 runner.json 背后是
   * KV 里的 commit，KV 没刷新时它会**正常返回 200 + 旧版本**，于是直接判「已是最新」，
   * 后面 jsDelivr/GitHub 上明明已有新版也永远看不到。2026-11-06 真机就是这样：
   * 自建源给 0.9.7、jsDelivr @main 已是 0.9.11，面板却报「已是最新 v0.9.10」，
   * 用户点「检查更新」什么反应都没有 —— 不是拉不到，是根本没去看。 */
  UI.checkUpdate = async function (silent) {
    if (!silent) updOut('检查中…');
    const cur = UI.installedVersion();
    const got = await Promise.all(GV.UPDATE_MANIFEST.map(async function (url) {
      try {
        const res = await gmFetch(url, { method: 'GET' });
        if (res.status !== 200) return { url: url, err: 'HTTP ' + res.status };
        const m = JSON.parse(res.text);
        if (!m || !m.version) return { url: url, err: '清单里没有 version 字段' };
        return { url: url, m: m };
      } catch (e) { return { url: url, err: String((e && e.message) || e) }; }
    }));
    const errs = got.filter(function (r) { return r.err; });
    const oks = got.filter(function (r) { return !r.err; });
    if (!oks.length) {
      if (!silent) updOut('<span style="color:#b00">检查失败</span>');
      if (!silent) UI.appendLog({ t: Date.now(), level: 'warn',
        msg: '更新检查失败（' + (errs[0] ? errs[0].err : '没有可用的更新源') + '）——不影响使用，可稍后重试或手动到仓库安装' });
      return;
    }
    // 版本最大者胜；同版本优先排在前面的源（自建源带宽最好）
    let best = oks[0];
    oks.forEach(function (r) { if (cmpVer(r.m.version, best.m.version) > 0) best = r; });
    GM_setValue(UPD.CHK_KEY, String(Date.now()));
    const ver = best.m.version;
    if (cmpVer(ver, cur) > 0) {
      UI._newUrl = installUrlOf(best);
      applyUpdateState(ver);
      updOut('<span style="color:#1a7f43">新版 v' + ver + '</span>');
      const viaSelf = installUrlOf(best).indexOf('mas.wankahuanju.top') >= 0;
      UI.appendLog({
        t: Date.now(), level: 'warn',
        msg: '发现新版本 Runner v' + ver + '（当前 v' + cur + '）：' + (best.m.notes || '') +
          ' —— 点右上角「更新 v' + ver + '」安装，装完切回本页会自动重载' +
          (viaSelf ? '' : '（安装地址改走 ' + best.url.split('/')[2] + '，自建分发源版本落后）')
      });
      return;
    }
    applyUpdateState('');
    if (!silent) updOut('<span style="color:#666">已是最新 v' + cur + '</span>');
    if (!silent) UI.appendLog({ t: Date.now(), level: 'ok', msg: 'Runner 已是最新版本 v' + cur });
    // 有源报的版本比当前装的还旧 = 那条分发链没跟上（最常见是 KV 里的 commit 没刷新）。
    // 这种时候「检查更新」是瞎的：它只看得见旧版本，必须点名，否则用户会一直以为已是最新。
    const stale = oks.filter(function (r) { return cmpVer(r.m.version, cur) < 0; });
    if (stale.length && !silent) {
      UI.appendLog({ t: Date.now(), level: 'warn',
        msg: '⚠️ 有更新源给的版本比当前还旧（' + stale.map(function (r) { return 'v' + r.m.version; }).join(' / ') +
          '）——那条分发链没刷新，自动更新会失灵：需要手动装一次，或由发布方重写分发指针' });
    }
  };

  /* 装完自动重载：只有「当前页面不忙」时才动手，避免打断正在跑的任务 */
  function busyNow() {
    if (UI._running) return true;
    const st = RunState.get();
    return !!(st && (st.phase === 'running' || st.phase === 'await_nav_check'));
  }
  let _watchArmed = false;
  function armReloadWatch() {
    if (_watchArmed) return;
    _watchArmed = true;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') maybeReloadAfterUpdate();
    });
    window.addEventListener('focus', maybeReloadAfterUpdate);
  }
  function maybeReloadAfterUpdate() {
    const p = pendGet();
    if (!p) return;
    if (Date.now() - (p.at || 0) > 30 * 60 * 1000) { pendClear(); updatePendingHint(); return; }
    if (cmpVer(UI.installedVersion(), p.ver) >= 0) {
      // 本页已经是新版本：说明重载已生效，收尾
      pendClear(); UI.renderHead(); applyUpdateState(''); updOut('已更新到 v' + UI.installedVersion());
      UI.appendLog({ t: Date.now(), level: 'ok', msg: 'Runner 已更新到 v' + UI.installedVersion() + '（本页已生效）' });
      return;
    }
    if (busyNow()) { updatePendingHint('正在执行任务，跑完后再重载'); return; }
    if (p.tries >= 1) { // 已经重载过一次还是旧版 → 安装多半没完成，改手动，绝不循环刷新
      p.stale = true; pendSet(p); updatePendingHint(); return;
    }
    p.tries = 1; p.at = Date.now(); pendSet(p);
    let n = 3;
    updOut('<span style="color:#1a7f43">3 秒后自动重载…</span>');
    const tick = setInterval(function () {
      n--;
      if (n > 0) { updOut('<span style="color:#1a7f43">' + n + ' 秒后自动重载…</span>'); return; }
      clearInterval(tick);
      try { location.reload(); } catch (e) {}
    }, 1000);
  }
  // 顶部提示：安装待完成 / 需要手动重载
  function updatePendingHint(extra) {
    const p = pendGet();
    if (!p) return;
    const cur = UI.installedVersion();
    if (p.stale) {
      updOut('<span style="color:#b26a00">仍是 v' + cur + '</span>' +
        ' <button class="masr-mini primary" id="masr-reload-now">重载</button>' +
        ' <button class="masr-mini" id="masr-reopen-install">安装页</button>');
      bindPendingButtons(p);
    } else if (extra) {
      updOut('<span style="color:#8f959e">' + extra + '</span>');
    }
  }
  function bindPendingButtons(p) {
    const r = document.getElementById('masr-reload-now');
    if (r) r.addEventListener('click', function () {
      pendClear(); // 先清标记，避免重载后又被判成"待重载"
      try { location.reload(); } catch (e) {}
    });
    const o = document.getElementById('masr-reopen-install');
    if (o) o.addEventListener('click', function () {
      try { window.open(p.url || GV.INSTALL_URL, '_blank', 'noopener'); } catch (e) {}
    });
  }

  UI.startUpdate = function () {
    const ver = UI._newVer;
    if (!ver) { UI.checkUpdate(); return; }
    const url = UI._newUrl || GV.INSTALL_URL;
    pendSet({ ver: ver, url: url, at: Date.now(), tries: 0, stale: false });
    updOut('<span style="color:#1a7f43">安装页已打开 v' + ver + '</span>');
    UI.appendLog({
      t: Date.now(), level: 'info',
      msg: '已打开安装页 v' + ver + '：在油猴弹窗里点「安装」，装完切回本页会自动重载（日志/参数/待办都已存好，重载不丢）'
    });
    try { window.open(url, '_blank', 'noopener'); } catch (e) { UI.appendLog({ t: Date.now(), level: 'warn', msg: '打开安装页被拦截，请放行弹窗或手动访问 ' + url }); }
    armReloadWatch();
  };

  // 启动时静默自检（默认 1 小时一次）：不打扰、不弹窗，发现新版只在悬浮球点个红点
  UI.autoCheckUpdate = async function (minGapMs) {
    const now = Date.now();
    const last = parseInt(GM_getValue(UPD.CHK_KEY, '0'), 10) || 0;
    if (now - last < (minGapMs || 60 * 60 * 1000)) return;
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

  UI.setSpecBadge = function (spec) { UI.renderSpecBadge(spec); };

  // 回放跳转前已完成的步骤（恢复日志可见性）
  UI.replayStepLogs = function (stepLogs) {
    (stepLogs || []).forEach(s => {
      UI.appendLog({ t: Date.now(), level: 'ok', msg: s.id + ' ✓（跳转前已完成）' + (s.name || '') +
        '，断言 ' + ((s.assertResults || []).length) + ' 条' + (s.extract ? '，抽取: ' + Object.keys(s.extract).join(', ') : '') });
      UI.markStep(s.id, 'passed');
    });
  };

  /* 回写模式：auto=跑完自动回写（默认，老场景用）；none=本场景不回写（只填表，提交与状态由人管）。
   * 2026-11-03 用户拍板：发邀请场景只要「把表填好」这一段——提交动作在页面按钮上、状态不回写，
   * 因此引擎不再有 manual 档位，也不做提交监听（submit_watch 已随需求收窄整体移除）。 */
  function wbModeOf(spec) {
    return (spec && spec.scene && spec.scene.writeback && spec.scene.writeback.mode) || 'auto';
  }

  UI.doRun = async function (opts) {
    opts = opts || {};
    // 新一次执行：解除上一次「同标签交接」留下的写冻结（跳转失败、页面没换掉时才会用到）
    RunState.thaw();
    // 续跑优先：落地页上 spec/参数从运行态恢复，不要求本页先粘贴 spec
    const st0 = RunState.get();
    let resuming = !!(st0 && st0.phase === 'await_nav_check');
    /* 续跑只在本页**确实是它的落点**时成立。
     * 反例（2026-11-06 真机 16:07）：P2 的 S7 用同标签跳到邀请链接后，运行态没清干净，
     * 残留是「等 loginAuth.html」；P3 在注册页启动时读到了它，于是丢下自己的 4 步，
     * 拿 P2 的 specJson 从 S6 续起 —— 在注册页上找不到「退出」菜单，直接 E_UI 终止，
     * 还把表写成了失败。判据就是本步自己声明的落地 URL：对不上就不叫续跑，叫别人的残影。
     * 没有 url_contains 的（只声明 cookie_exists）无法判断，保持原行为不拦。 */
    if (resuming) {
      const wantUrl = String((st0.navExpect && st0.navExpect.url_contains) || '');
      if (wantUrl && String(location.href).indexOf(wantUrl) < 0) {
        UI.appendLog({
          t: Date.now(), level: 'warn',
          msg: '忽略一条不属于本页的续跑状态（' + (st0.navStepId || '?') + ' 在等 "' + wantUrl +
            '"，当前页不是它的落点）：已清除，按本页场景正常执行',
        });
        RunState.clear();
        resuming = false;
      }
    }
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
        if (p.source === 'manual') {
          const el = document.getElementById('masr-p-' + p.name);
          const v = el ? el.value.trim() : '';
          if (p.required && !v) { alert('必填参数: ' + (p.label || p.name)); return; }
          if (v) params[p.name] = v;
          continue;
        }
        // 数据源参数（子客ID 等）：人工输入框已移除，必须由任务行带入。
        // 没有任务上下文（standalone 粘贴 spec 直接点执行）时不再弹「必填参数」让人手填，而是提示走任务。
        if (p.required) {
          /* 话要说准：这一支只说明「任务里没带这个字段」，最常见的原因是**业务表那一列是空的**
           * （read-once 之后这条链只查一次表，缺项在 P2 就该拦住，而不是等到下游才发现）。
           * 原来只说「请点一条待办执行」，人会以为自己点错了地方，实际是表里少填了一格。 */
          alert('「' + (p.label || p.name) + '」没有取到值：任务参数里缺这一项——多半是业务表里这一列是空的。'
            + '请先在表里补全再重跑（本条记录已按设计拦下，没有做任何操作）。');
          return;
        }
      }
      /* 参数记忆只记非凭据项：GM 存储是明文落盘的，密码写进去等于在本机留一份长期副本，
       * 而且「下次自动回填」会把密码塞回 DOM。凭据每次从 /task 重新取，不落本地。 */
      const keep = {};
      (spec.params || []).forEach(function (p) {
        if (p && p.secret === true) return;
        if (params[p.name] !== undefined) keep[p.name] = params[p.name];
      });
      UI.saveParams(spec.spec_id, keep);
      // 角色标记：发起页（通常为代理页）永不自毁，负责展示最终结果
      try { sessionStorage.setItem('masrRole', 'origin'); } catch (e) {}
      CloseSig.clear();   // 新一次流程：抹掉上一轮的收摊信号，避免误关本次打开的标签页
    }
    UI.spec = spec;
    UI.setSpecBadge(spec);
    if (!opts.keepLog) document.getElementById('masr-log').innerHTML = '';
    UI.renderSteps(spec);
    if (resuming) {
      UI.appendLog({ t: Date.now(), level: 'info', msg: '=== 续跑模式：从运行态恢复（' + st0.navStepId + ' 之后）===' });
      UI.replayStepLogs(st0.stepLogs);
    } else {
      /* 运行态落盘时剔除凭据：RunState 走 GM 存储（明文）、会被跨页复制、并可能长期留着。
       * 跨域登录页需要凭据时由它自己的场景从 /task 重新取（P2 就是拆成两个场景做的）。
       * 代价写在这里：同一个 spec 里既有 navigate 又用 secret 参数时，续跑那一段拿不到凭据。 */
      const pubParams = {};
      const secretNames = [];
      (spec.params || []).forEach(function (p) {
        if (p && p.secret === true) { secretNames.push(p.name); return; }
        if (params[p.name] !== undefined) pubParams[p.name] = params[p.name];
      });
      if (secretNames.length) {
        /* 只在「跳转**之后**还要用凭据」时才警告。原来的判据是「有 navigate 且有凭据」，
         * 对 P2 0.5.0 这种「先填密码、最后一步才跳走」的 spec 完全是误报——
         * 真机日志里它挂在正常流程中间，看着像出了问题，实际什么都没发生。 */
        const navIdx = (spec.steps || []).findIndex(function (s) { return s.mode === 'navigate'; });
        const tail = navIdx >= 0 ? JSON.stringify((spec.steps || []).slice(navIdx + 1)) : '';
        const usedAfterNav = secretNames.filter(function (n) { return tail.indexOf('{{' + n + '}}') >= 0; });
        if (usedAfterNav.length) {
          UI.appendLog({
            t: Date.now(), level: 'warn',
            msg: '⚠️ 跳转之后的步骤还要用凭据 ' + usedAfterNav.join(',') + '：跨页后会丢弃凭据（安全策略），落地页需自行从 /task 取，否则那些步骤会因值为空停下',
          });
        }
      }
      // 运行态初始化（供 navigate 续跑恢复用）
      // task 也要脱敏：它是 /task 原样回来的对象，params 里就带着密码。
      const pubTask = UI.currentTask ? Object.assign({}, UI.currentTask, {
        params: (function () {
          const p = Object.assign({}, (UI.currentTask && UI.currentTask.params) || {});
          secretNames.forEach(function (n) { delete p[n]; });
          return p;
        })(),
      }) : null;
      RunState.set({
        phase: 'running', specId: spec.spec_id, specVersion: spec.version,
        specJson: JSON.stringify(spec), params: pubParams, log: [], startedAt: Date.now(),
        runId: 'r' + Date.now(),   // 一次流程的唯一标识：收摊信号只认它，避免误关别的流程的标签页
        runnerVersion: GV.RUNNER_VERSION,
        task: pubTask,
      });
    }
    /* 心跳：给「这次运行还活着」留证据。页面被 302/关闭打断时 finally 跑不到，
     * 下一张页面只能靠 startedAt/beatAt 判断这是「真在跑」还是「卡死」。 */
    const beat = setInterval(function () {
      try {
        const s = RunState.get();
        if (s && s.phase === 'running') { s.beatAt = Date.now(); RunState.set(s); }
      } catch (e) { /* 心跳失败不影响执行 */ }
    }, 15000);
    const hooks = { onLog: UI.appendLog, onStep: UI.markStep };
    try {
      let result;
      if (resuming) result = await resumeAfterNavigate(spec, params);
      else result = await runSpec(spec, params, hooks);
      UI.lastResult = result;
      if (result.navInitiated) {
        // 这一页接下来只是"等落地"的中间页（脚本打开的）：标记成辅助页，链条跑完它也要一起关掉
        try {
          if ((sessionStorage.getItem('masrRole') || '') !== 'origin') {
            sessionStorage.setItem('masrRole', 'helper');
            const stn = RunState.get() || {};
            if (stn.runId) sessionStorage.setItem('masrRunId', stn.runId);
          }
        } catch (e) {}
        const tip = result.openedTab
          ? '=== ' + result.stepId + ' 已在新标签页打开。落地页就绪会自动续跑（通常 1 秒内，慢链路按 cookie 到位触发），若没续上再切过去点「执行」 ==='
          : '=== ' + result.stepId + ' 导航已发起。落地页就绪会自动续跑（通常 1 秒内），本页无需操作 ===';
        UI.appendLog({ t: Date.now(), level: 'warn', msg: tip });
        document.getElementById('masr-result').innerHTML = result.openedTab
          ? '<b style="color:#b8860b">⏳ 新标签页已打开</b>：落地后自动续跑，全部跑完辅助标签页会自动关闭、结果回到本页。'
          : '<b style="color:#b8860b">⏳ 等待导航落地</b>：落地后自动续跑；若 8 秒后未自动续跑，切到落地页点「执行」。';
      } else {
        // 回写模式 none：本场景只负责把表填好（提交与状态由人在页面上管），引擎不写表、不出确认按钮。
        // 仍要广播收摊信号（辅助页自毁），但 final.manual=true 让发起页轮询器跳过回写。
        if (wbModeOf(spec) === 'none') {
          const stm = RunState.get() || {};
          UI._runStartedAt = stm.startedAt || Date.now();
          /* 文案必须跟 spec 实际做到哪一步一致：P1 早期只填表，0.8.0 起改成了自动提交。
           * 还在说「请手动提交」会诱导人多点一次 —— 那等于多给广告主发一封邀请，不可逆。 */
          const didSubmit = (spec.steps || []).some(function (s) {
            return ((s.ui && s.ui.actions) || []).some(function (a) { return a && a.do === 'submit'; });
          });
          UI.appendLog({
            t: Date.now(), level: 'ok',
            msg: didSubmit
              ? '=== 已完成（含提交动作，判定结果见上方；本场景不回写飞书）==='
              : '=== 表单填充完成（本场景不回写：请在页面核对后手动提交）===',
          });
          renderOutputs(result.outputs || {});
          const stcN = RunState.get() || {};
          stcN.phase = 'done';
          stcN.final = { ok: true, outputs: result.outputs || {}, at: Date.now(), specId: spec.spec_id, manual: true };
          RunState.set(stcN);
          CloseSig.mark(stcN.runId);
          console.log('[MASR] result =', result);
          return;
        }
        UI.appendLog({ t: Date.now(), level: 'ok', msg: '=== 执行完成 ===' });
        renderOutputs(result.outputs || {});
        // 广播最终结果：辅助标签页自毁，发起页弹窗展示
        /* 续跑页就是「本流程的同一个标签页」，不能按 masrRole 判辅助页：
         * masrRole 在 sessionStorage 里，而 sessionStorage **不跨域**——退出登录从
         * id.cloud 跳到 id1.cloud 时它必然丢失，续跑页于是被判成辅助标签页，跑完 2 秒把自己关掉，
         * 人连提示都看不清。 */
        const role = resuming ? 'origin'
          : (function(){ try { return sessionStorage.getItem('masrRole') || ''; } catch (e) { return ''; } })();
        const stc = RunState.get() || {};
        stc.phase = 'done';
        /* 保留「已回写」标记：交接型流程在打开下一个标签页之前就写过表了（见 execNavigate
         * 的 handoff 分支，标记在 wbDone 上），这里不能把它冲掉，否则收尾轮询器会再写一次。 */
        const alreadyWritten = !!(stc.final && stc.final.written) || !!(stc.wbDone && stc.wbDone.written);
        stc.final = { ok: true, outputs: result.outputs || {}, at: Date.now(), specId: spec.spec_id, written: alreadyWritten };
        if (stc.wbDone) delete stc.wbDone;
        RunState.set(stc);
        CloseSig.mark(stc.runId);   // 广播收摊：链条上所有辅助页（含上游的子客门户）自毁，发起页留
        if (role !== 'origin') {
          UI.appendLog({ t: Date.now(), level: 'info', msg: '⏪ 本页为辅助标签页，2 秒后自动关闭；结果将回到发起页展示' });
          setTimeout(function () { try { window.close(); } catch (e) {} }, 2000);
        }
      }
      console.log('[MASR] result =', result); // 本地调试用，不入表格
    } catch (e) {
      const code = e.code || 'E_UNKNOWN';
      /* human=true 表示「按设计停在人工环节」，不是故障。
       * 横幅与提示必须区分开：把它写成「失败」，人会以为脚本坏了、要重跑一遍，
       * 而重跑往往要多发一封邀请/多建一个成员。 */
      const human = !!e.human;
      UI.appendLog({ t: Date.now(), level: human ? 'warn' : 'fatal', msg: (human ? '=== 已按设计终止（需人工接手）: [' : '=== 终止: [') + code + '] ' + e.message + ' ===' });
      UI.lastResult = { ok: false, error: code, message: e.message, human: human };
      // 失败也广播（发起页能看到）；但辅助页不自毁，保留现场供排查
      try {
        const role = sessionStorage.getItem('masrRole') || '';
        const stc = RunState.get() || {};
        if (stc.phase) {
          stc.phase = 'done';
          stc.final = { ok: false, error: code, message: e.message, at: Date.now() };
          CloseSig.mark(stc.runId);   // 失败也收摊：上游辅助页别留着，出错的那一页自己保留现场
          if (role === 'origin') {
            // 本页直接展示过，轮询器不再重复播报；但「失败」同样要回写（错误类型要进飞书表）
            stc.final.consumed = true;
            const wbAlready = !!(stc.wbDone && stc.wbDone.written) ||
              wbOkRecent(stc.task && stc.task.record_id);
            if (wbAlready) {
              /* 业务结果已经在交接准备阶段写成功了（例：「开户状态=管理式导入完成」），
               * 这次失败的只是交接之后的收尾步骤（例：退出登录没点上）。
               * 此时绝不能把表改写成失败——那会让业务以为成员根本没建成，进而重跑一次、
               * 多建一个成员。表里保留成功状态，失败原因只在面板上说清楚。 */
              stc.final.written = true;
              UI.appendLog({ t: Date.now(), level: 'warn', msg: '表内业务结果已在交接准备阶段回写成功（' + code +
                ' 发生在交接之后的收尾步骤），本次不覆盖表内状态；请按上方提示人工处理这一处' });
            } else if (stc.task && stc.task.record_id && !stc.final.written) {
              if (wbModeOf(spec) !== 'auto') {
                // none 模式：填充失败不写表（记录保持原状态，可重试）；提示人现场处置
                stc.final.manual = true;
                UI.appendLog({ t: Date.now(), level: 'warn', msg: human
                  ? '本场景不回写：流程按设计停在人工环节，记录保持原状态；人工处理完成后可重新触发'
                  : '本场景不回写：填充失败不写表，记录保持原状态；可排查后重新触发' });
              } else {
                stc.final.written = true;
                pushTaskResult(stc, false, null, { code: code, message: e.message });
              }
            }
          }
          RunState.set(stc);
        }
      } catch (e2) {}
    } finally {
      clearInterval(beat);
      const st = RunState.get();
      /* 0.9.20：清态规则——
       * ① running：被打断的残影（原行为）；
       * ② done 且 final 已被消费：发起页轮询器消费完会自己清（1.5s 延迟），这里兜一道，
       *    防轮询器那趟没跑页面就关了。
       * 未消费的 final 绝不清：'origin' 的播报/补回写、'helper' 的自毁都还指着它；
       * 没人消费的陈年残留由 mountAll 的 2 分钟兜底压掉（见下）。
       * 注意 role 要现读：doRun 开跑时才把 masrRole 设成 'origin'，入口快照恒为 ''，不可靠。 */
      const roleNow = (function () { try { return sessionStorage.getItem('masrRole') || ''; } catch (e) { return ''; } })();
      if (st && st.phase === 'running') RunState.clear();
      else if (st && st.phase === 'done' && st.final && st.final.consumed) RunState.clear();
      else if (st && st.phase === 'done' && !st.final && roleNow !== 'helper') RunState.clear();
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

  // 导航落地「就绪即续」：替代原来固定 2.5s 的盲等。
  // 触发条件（由调用处保证）：本页 URL 已命中 expect.url_contains、状态新鲜（10 分钟内）。
  // 本函数只负责「什么时候真正续跑」：
  //   - 若该步 expect 声明了 cookie_exists（dsp_csrf_token），就按 250ms 细粒度轮询，cookie 一到位立刻续；
  //   - 未声明 cookie（如 S5 落地 key 页）时，URL 命中后再留 ~300ms 给页面 SPA 起手，即续；
  //   - 页面重新可见（用户切到该标签页）或 pageshow 时立即再查一次，避免后台节流拖慢；
  //   - 超过 MAX_WAIT 仍未就绪 → 降级为提示手动点「执行」，绝不静默挂死。
  // 续跑函数 resumeAfterNavigate 内部仍会二次校验 url_contains / cookie，本函数只是把等待提前、做细。
  function armNavResumeReady(st0) {
    const needCookie = (st0.navExpect && st0.navExpect.cookie_exists) || '';
    const MAX_WAIT = 15000;
    const SETTLE = 300;               // 无 cookie 可等时，给 SPA 的起手缓冲
    const started = Date.now();
    let fired = false, iv = null, settleT = null;

    function cleanup() {
      if (iv) { clearInterval(iv); iv = null; }
      if (settleT) { clearTimeout(settleT); settleT = null; }
      try {
        window.removeEventListener('pageshow', wake);
        document.removeEventListener('visibilitychange', onVis);
      } catch (e) {}
    }
    function stillLive() {
      const s = RunState.get();
      return !!(s && s.phase === 'await_nav_check' && s.navStepId === st0.navStepId);
    }
    function cookieReady() { return !needCookie || !!ENGINE.readCookie(document.cookie, needCookie); }

    function doResume(src) {
      if (fired) return;
      if (!stillLive()) { cleanup(); return; }
      fired = true; cleanup();
      try {
        sessionStorage.setItem('masrRole', 'helper');
        if (st0.runId) sessionStorage.setItem('masrRunId', st0.runId);
      } catch (e) {}
      UI.appendLog({ t: Date.now(), level: 'info', msg: '⏩ ' + st0.navStepId + ' 落地就绪（' + ((Date.now() - started) / 1000).toFixed(1) + 's' + (src ? '·' + src : '') + '），续跑' });
      UI.doRun();
    }
    // 首次就绪 → 按是否等过 cookie 决定是否留一点点缓冲
    function fireWhenReady(src) {
      if (!stillLive() || !cookieReady()) { if (!stillLive()) cleanup(); return; }
      if (needCookie) doResume(src);              // cookie 到位本身就是强就绪信号，立即续
      else if (!settleT) settleT = setTimeout(function () { doResume(src); }, SETTLE);
    }
    function wake() { fireWhenReady('事件'); }
    function onVis() { if (document.visibilityState === 'visible') fireWhenReady('可见'); }

    // 已经就绪：下一拍起飞（不阻塞 boot 其余逻辑）
    if (cookieReady()) { settleT = setTimeout(function () { doResume('已就绪'); }, needCookie ? 0 : SETTLE); return; }

    window.addEventListener('pageshow', wake, { passive: true });
    document.addEventListener('visibilitychange', onVis);
    UI.appendLog({ t: Date.now(), level: 'info', msg: '⏩ ' + st0.navStepId + ' 等 cookie「' + needCookie + '」就位，到位即续跑（不再固定等 2.5s）' });
    iv = setInterval(function () {
      if (!stillLive()) { cleanup(); return; }
      if (cookieReady()) { doResume('轮询'); return; }
      if (Date.now() - started > MAX_WAIT) {
        cleanup();
        UI.appendLog({ t: Date.now(), level: 'warn', msg: '⚠️ ' + st0.navStepId + ' 等 cookie 超时（' + (MAX_WAIT / 1000) + 's），请切到该页点「执行」手动校验' });
      }
    }, 250);
  }

  /* ===== URL 触发：地址带 recordId → 自动按记录取数并填充（不自动开跑） =====
   * 规则全部来自 spec.scene.trigger（Runner 不登记任何业务 URL）。
   * 取数由服务端按 scene 声明的状态条件校验（如「邀请状态=未邀请」），不满足直接拒绝。
   * 不自动执行：这类流程含不可逆/不可幂等步骤，必须人看到参数后点「运行」。 */
  /* 无面板场景（中转页）用的极简提示条：不依赖主面板 DOM，失败时人至少知道发生了什么 */
  UI.notice = function (text, level) {
    try {
      let el = document.getElementById('masr-notice');
      if (!el) {
        el = document.createElement('div');
        el.id = 'masr-notice';
        el.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;right:0;padding:8px 12px;' +
          'font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;' +
          'text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.12)';
        (document.body || document.documentElement).appendChild(el);
      }
      const bad = level === 'error' || level === 'warn';
      el.style.background = bad ? '#fff2f0' : '#f0fff4';
      el.style.color = bad ? '#c02a2a' : '#1a7f45';
      el.style.borderBottom = '1px solid ' + (bad ? '#ffccc7' : '#b7eb8f');
      el.textContent = 'MAS · ' + String(text || '');
      if (!bad) setTimeout(function () { try { el.parentNode && el.parentNode.removeChild(el); } catch (e) {} }, 4000);
    } catch (e) {}
  };

  function trigEsc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  UI.renderTrigger = function () {
    const box = document.getElementById('masr-trigger-box');
    if (!box) return;
    const t = UI._triggerTask, err = UI._triggerErr || '', mark = UI._triggerMark;
    if (!t && !err && !mark) { box.innerHTML = ''; return; }
    const bar = 'margin-top:4px;padding:5px 7px;border-radius:6px;';
    if (!t && !err && mark) {
      // on_match=mark 的场景：只提示匹配到，不自动取数
      box.innerHTML = '<div style="' + bar + 'background:#f2f8ff;border:1px solid #b7d8f5;color:#1c5da8;font-size:11px">' +
        '当前页面匹配场景「' + trigEsc(mark.name || mark.script_id) + '」' +
        (mark.record_id ? '（记录 ' + trigEsc(mark.record_id) + '）' : '') +
        '——该场景声明只标注、不自动取数，请从面板选择场景后操作</div>';
      return;
    }
    if (!t && err) {
      box.innerHTML = '<div style="' + bar + 'background:#fff2f0;border:1px solid #ffccc7;color:#c02a2a;font-size:11px">' +
        trigEsc(err) + '</div>';
      return;
    }
    const view = SVC.sceneView(t.script_id);
    // 主标题优先取业务字段（昵称/名称之类），record_id 只在没有别的可显示时才顶上
    const dk = (t.display ? Object.keys(t.display) : []).filter(function (k) { return k !== 'record_id'; });
    const dv = dk.length ? t.display[dk[0]] : '';
    const draft = String(t.spec_status || '') === 'draft';
    const fromUrl = !!t.from_url;
    // fill_and_run 的场景引擎自己就开跑了，卡片上不再放「运行」按钮（免得人以为要点）
    const autoRun = String(t.on_match || 'fill') === 'fill_and_run';
    const head = fromUrl
      ? '已从页面地址读取参数：<b>' + trigEsc(view.name) + '</b>' + (t.record_id ? ' · ' + trigEsc(t.record_id) : '') + '—— 正在自动填充表单'
      : (t.from_pend
        /* read-once：参数来自上一段流程的交接上下文，本页**没有**查业务表。
         * 卡面必须说实话——写「已按页面记录取数」会让人以为又读了一次表，
         * 真去核对日志时就对不上（这行字是我唯一能看到「走的哪条路」的地方）。 */
        ? '参数取自上游交接上下文（未查业务表）：<b>' + trigEsc(view.name) + '</b> · ' +
          trigEsc(dv || t.record_id) + '（' + trigEsc(t.record_id) + '）—— 参数已填充，确认后点「运行」'
        : '已按页面记录取数：<b>' + trigEsc(view.name) + '</b> · ' +
          trigEsc(dv || t.record_id) + '（' + trigEsc(t.record_id) + '）—— 参数已填充，确认后点「运行」');
    box.innerHTML =
      '<div style="' + bar + 'background:#f0fff4;border:1px solid #b7eb8f">' +
        '<div style="font-size:11px;color:#1a7f45">' + head + '</div>' +
        (draft ? '<div style="font-size:11px;color:#b26a00;margin-top:2px">⚠ 该场景的 spec 仍是草稿（draft）：流程未全部验证过，运行会真的发请求，请确认参数无误</div>' : '') +
        (autoRun ? '' :
          '<div class="row" style="margin-top:4px">' +
            '<button class="primary" id="masr-trigger-run">运行</button>' +
            '<span style="font-size:11px;color:#8f959e">会真发请求/不可逆的步骤不会自动执行</span>' +
          '</div>') +
      '</div>';
    const btn = document.getElementById('masr-trigger-run');
    if (btn) btn.addEventListener('click', function () { UI.runTask(t, btn); });
  };

  UI.loadTriggeredTask = async function (task) {
    UI.currentTask = {
      record_id: task.record_id,
      table_id: task.table_id, script_id: task.script_id || '',
      params: task.params || null,
      display: task.display || null,
      write_token: task.write_token || '',
      from_url: !!task.from_url,
      on_match: task.on_match || '',
    };
    // 缓存优先：命中本地 spec 就立刻开跑，不等公网；版本校验放后台（见下面 specRefresh）
    const t0 = Date.now();
    const cached = SVC.specCache.get(task.script_id);
    let s = cached
      ? { spec_id: cached.spec_id || task.script_id, version: cached.version, status: cached.status || '', spec: cached.spec }
      : null;
    /* 缓存版本 vs 线上版本（0.9.19）：/task 会把线上 spec 的版本号一起带回来（服务端 0.6.10+）。
     * 对不上就**本次就换新版**，而不是「本次仍按缓存版执行，下次生效」。
     *
     * 为什么改：2026-11-09 真机连续踩三次同一个坑——缓存里是 0.2.0、线上是 0.4.0，
     * 于是照旧跑旧流程：验证码处硬终止（旧版设计就是终止）、日期用 type 写 DOM 假绿、
     * 表里漏读新字段。人看到的现象是「说好的自动接管没有」。缓存是加速手段，
     * 不能拿「跑错版本」当代价；这里多花的只是一次 /spec（仅在版本真的变了时）。
     * 服务端没下发该字段（老服务）→ 保持原行为，不影响兼容。 */
    const onlineVer = String(task.spec_version || '');
    /* usedCache 语义（勿动）：「**本次要跑的这份 spec** 是不是来自缓存」。
     * 必须在重取之前求值——刚联网取过新版就不再叠加后台校验（同一秒的第二次 /spec，纯浪费）；
     * 回退缓存版的分支要改回 true，让后台 specRefresh 接着尝试升缓存。 */
    let usedCache = !!s;
    if (s && onlineVer && String(s.version) !== onlineVer) {
      UI.appendLog({ t: Date.now(), level: 'warn',
        msg: '本地缓存的 spec 是 v' + s.version + '，线上已是 v' + onlineVer + '：本次改用线上版（重取一次，避免拿旧流程跑新数据）' });
      const stale = s;
      SVC.specCache.drop(task.script_id);
      s = null;
      usedCache = false;                     // 重取成功 → 这份是刚联网拿的，不需要后台再校验
      try {
        s = await SVC.spec(task.script_id);
        SVC.specCache.put(task.script_id, s);
      } catch (eSpec) {
        /* 0.9.20：重取失败（超时/网络抖动/GM 通道挂死）不再中止整次运行——
         * 2026-11-09 真机实测：同一次运行里 /task 5.8s 成功、/spec 20s 超时，
         * 任务被卡死在「校验版本」这一步，而缓存版明明可用。回退缓存版继续跑并如实记录；
         * usedCache=true 的分支会后台 specRefresh，成功后缓存自动升版，下次生效。 */
        if (!stale) throw eSpec;
        SVC.specCache.put(task.script_id, stale);
        s = stale;
        usedCache = true;                    // 跑的是缓存版 → 后台继续校验/升版
        UI.appendLog({ t: Date.now(), level: 'warn',
          msg: '重取线上 spec 失败（' + eSpec.message + '）：本次回退本地缓存 v' + stale.version + ' 继续执行（后台会再试升级缓存）' });
      }
    }
    if (!s) {
      s = await SVC.spec(task.script_id);
      SVC.specCache.put(task.script_id, s);
    }
    UI.currentTask.spec_version = s.version;
    UI._specCache = { script_id: task.script_id, spec: s.spec, version: s.version };
    let applied = UI.applySpec(JSON.stringify(s.spec), { persist: true });
    if (!applied && cached) {
      // 本地那份坏掉（格式/校验不通过）：丢掉重取，绝不让坏缓存把流程卡死
      usedCache = false;
      UI.appendLog({ t: Date.now(), level: 'warn', msg: '本地缓存的 spec 无法加载，改为联网重取…' });
      SVC.specCache.drop(task.script_id);
      s = await SVC.spec(task.script_id);
      SVC.specCache.put(task.script_id, s);
      UI.currentTask.spec_version = s.version;
      UI._specCache = { script_id: task.script_id, spec: s.spec, version: s.version };
      applied = UI.applySpec(JSON.stringify(s.spec), { persist: true });
    }
    /* 只有「这次真的用了缓存」才需要后台校验版本：刚重取过新版（usedCache=false 的反面）再校验
     * 就是同一秒里的第二次 /spec，纯浪费（真机上这一跳 0.5~14s）。 */
    if (usedCache) {
      // 后台校验版本：变了只提示、不打断本次（选择器若真被换掉，页面填充的断言会自己报错，不会静默填错）
      SVC.specRefresh(task.script_id).then(function (r) {
        if (r && r.changed) {
          UI.appendLog({ t: Date.now(), level: 'warn', msg: '检测到新版 spec v' + r.version + '（本地缓存 v' + r.oldVersion + '）：本次仍按缓存版执行，下次自动生效' + (onlineVer ? '' : '（本次取数没带回线上版本号，只能跑完再提示）') });
        }
      }).catch(function () { /* 校验失败静默：不能因为刷新失败就否定缓存 */ });
    }
    if (UI.spec && UI.restoreSpecText) UI.restoreSpecText();
    UI._triggerTask = task;
    UI._triggerErr = '';
    UI.renderTrigger();
    const ps = task.params || {};
    const keys = Object.keys(ps).filter(function (k) { return k !== 'record_id'; });
    /* 这一行曾经把 params 原样打进日志——参数级脱敏做了面板/存储/回写，
     * 唯独漏了这里，等于密码照样进日志（2026-11-05 golden trace 基线里抓到的明文）。
     * 秘密参数一律走 maskValue，且注明已打码，免得人以为看到了真值。 */
    /* 注意 params 在 s.spec.params 里（s 是 /spec 的回包 {spec,version,spec_id}），
     * 写 s.params 会拿到 undefined → secretNames 空 → 静默退化成明文打印。 */
    const secretNames = (((s && s.spec && s.spec.params) || (s && s.params) || []))
      .filter(function (p) { return p && p.secret === true; })
      .map(function (p) { return p.name; });
    UI.appendLog({
      t: Date.now(), level: 'ok',
      msg: (task.from_url ? '已从页面地址读取参数'
        : (task.from_pend ? '参数取自上游交接上下文（本页未查业务表） ' + task.record_id
          : '已按页面记录取数 ' + task.record_id)) + '（' + s.spec_id + ' v' + s.version +
        (cached ? '｜本地缓存，取 spec 用时 ' + (Date.now() - t0) + 'ms' : '｜联网取 spec 用时 ' + (Date.now() - t0) + 'ms') + '）' +
        (keys.length ? '；参数 ' + keys.map(function (k) {
          if (secretNames.indexOf(k) >= 0) return k + '=' + ENGINE.maskValue(ps[k]) + '（已打码）';
          return k + '=' + ps[k];
        }).join('，') : ''),
    });
    // 只有「要往业务表回写」的场景才需要捂热那张表；纯填表场景（URL 自带参数）不查表也不写表，捂热纯属浪费。
    if (!task.from_url) SVC.warmStart(90000, task.script_id);
  };

  /* 监听 URL 变化：hashchange / popstate + 1.2s 轮询兜底（SPA 可能用 pushState 静默改地址） */
  async function armUrlTrigger() {
    const seen = {};
    let lastHref = location.href;
    let busy = false;

    // 有没有场景声明 URL 触发，由 /scenes 决定；一个都没有就不起监听（零开销，不是靠开关猜）
    const list = await SVC.scenes().catch(function () { return []; });
    const hasTrig = list.some(function (s) { return s.trigger && (s.trigger.url_patterns || []).length; });
    if (!hasTrig) return;

    async function fire(reason) {
      if (busy || !SVC.code()) return;
      busy = true;
      try {
        await SVC.scenes();
        const hit = SVC.matchTrigger();
        UI._trigger = hit;
        if (!hit) {
          /* 静默是这里最坏的选项：人站在登录页上，面板挂出来了、什么都没发生、
           * 日志一行没有，只能猜是脚本坏了。两种情况必须说话：
           *   ①多个场景同时命中（声明不足）；
           *   ②命中但取不到 recordId（recordId 在 service 里且 spec 没声明 record_id_deep）。 */
          const amb = SVC._triggerAmbiguous;
          if (amb && amb.length > 1) {
            UI._triggerErr = '当前地址同时匹配多个场景（' + amb.join('、') + '）：声明里缺少区分标记（action_query），引擎不做猜测，已跳过';
            UI.appendLog({ t: Date.now(), level: 'warn', msg: UI._triggerErr });
            UI.renderTrigger();
            return;
          }
          /* 站在「某个场景声明的跨域落地域」上却零命中 —— 必须说一句。
           * 这多半是场景列表还是旧的（TTL 10 分钟，刚发布的场景不在里面），
           * 或者登录页的 service 里根本没有回跳本业务的地址（被别的站点复用）。 */
          const here = String(location.host || '').toLowerCase();
          const list = (SVC._sceneCache && SVC._sceneCache.list) || [];
          const owners = list.filter(function (x) {
            const hs = (x.trigger && x.trigger.cross_domain && x.trigger.cross_domain.hosts) || [];
            return hs.map(function (h) { return String(h).toLowerCase(); }).indexOf(here) >= 0;
          }).map(function (x) { return x.name || x.script_id; });
          if (owners.length) {
            UI.appendLog({ t: Date.now(), level: 'warn', msg: '当前在「' + here + '」（' + owners.join('、') +
              ' 声明的跨域落地域），但没有场景认领本页：多半是场景列表还是旧缓存，或登录页 service 里没有回跳本业务的地址' });
          }
          return;
        }
        /* 刚主动退出过就别再自动登录：否则 8 秒后又被登回原组织，人根本退不出去。
         * 命中也要说出来——「明明匹配上了却什么都没发生」是最难排查的那种故障。 */
        const lo = SVC.logoutGuard(hit);
        if (lo) {
          UI._triggerErr = lo.msg;
          UI.appendLog({ t: Date.now(), level: 'warn', msg: lo.msg });
          UI.renderTrigger();
          return;
        }
        const hasUrlParams = !!(hit.params && Object.keys(hit.params).length);
        if (!hit.record_id && !hasUrlParams) {
          UI._triggerTask = null;
          UI._triggerErr = '当前页面匹配场景「' + (hit.name || hit.script_id) + '」，但地址里没有 record_id，无法取数';
          /* 这条曾经只写进面板的错误条，而错误条挂在任务区、会被 renderTasks 重绘抹掉，
           * 结果就是「点完按钮跳到登录页 → 没反应、没日志」。跨域登录页上 recordId 被编码进
           * service 参数，必须显式告诉人「是取不到记录」，不是「脚本没加载」。 */
          UI.appendLog({ t: Date.now(), level: 'warn', msg: UI._triggerErr +
            '｜当前地址：' + String(location.href).slice(0, 160) +
            '（跨域登录页的 recordId 在 service 参数里，需 spec 声明 record_id_deep）' });
          UI.renderTrigger();
          return;
        }
        const key = hit.script_id + '|' + (hit.record_id || ENGINE.strHash(JSON.stringify(hit.params)));
        if (seen[key]) return;                 // 同一页面生命周期内一条记录只取一次
        seen[key] = true;
        // 命中后做什么由 spec.scene.trigger.on_match 声明，Runner 不预设业务偏好
        if (hit.on_match === 'mark') {
          UI._triggerMark = hit;
          UI.renderTrigger();
          UI.appendLog({ t: Date.now(), level: 'info', msg: '当前页面匹配场景「' + (hit.name || hit.script_id) + '」，记录 ' + hit.record_id + '（该场景声明只标注、不自动取数）' });
          return;
        }
        // 场景自带 URL 参数（trigger.params_query）：不查业务表，直接用地址里的参数。
        // 这条路径省掉「按记录回查业务表」整步，也就不需要写回票据（本场景不回写）。
        if (hasUrlParams) {
          const task = {
            record_id: hit.record_id || '', script_id: hit.script_id,
            params: hit.params, display: null, write_token: '', from_url: true,
            on_match: hit.on_match,
          };
          UI.appendLog({ t: Date.now(), level: 'info', msg: 'URL 触发命中「' + (hit.name || hit.script_id) + '」，参数直接取自页面地址（不查业务表）：' +
            Object.keys(hit.params).map(k => k + '=' + hit.params[k]).join('，') + '（' + reason + '）' });
          await UI.loadTriggeredTask(task);
          if (hit.on_match === 'fill_and_run') {
            UI.appendLog({ t: Date.now(), level: 'warn', msg: '该场景声明 on_match=fill_and_run：参数已就位，立即开跑' });
            await UI.runTask(task, document.getElementById('masr-trigger-run'));
          }
          return;
        }
        /* read-once 优先：交接上下文齐了就直接开跑，省掉「服务端回读业务表」这一跳。
         * 回退是隐式的——上下文缺参数/过期/不是给本场景的，就照旧查表一次，
         * 并且打一行说明为什么回退，避免「说好只读一次却读两次」变成查不出来的谜。 */
        let task = SVC.taskFromPend(hit);
        if (task) {
          UI.appendLog({ t: Date.now(), level: 'info',
            msg: '参数取自上游交接上下文（按 read-once 约定，本页不查业务表）：' + Object.keys(task.params).join(',') });
          task.on_match = hit.on_match;
        } else {
          if (hit.params_from_pend === true) {
            UI.appendLog({ t: Date.now(), level: 'warn',
              msg: '本场景声明「参数取自交接上下文」，但上下文不可用（' + (SVC.taskFromPend.lastReason || 'unknown') + '）→ 回退查表一次' });
          }
          UI.appendLog({ t: Date.now(), level: 'info', msg: 'URL 触发命中「' + (hit.name || hit.script_id) + '」，按记录 ' + hit.record_id + ' 取数…（' + reason + '）' + (hit.record_id_from_pend ? '｜记录来自上游交接（本页地址不含 recordId）' : '') });
          /* 这一枪要服务端回读业务表（真机 4~8s，冷表更久），是「命中→开跑」这段空档的主要成分。
           * 只在慢的时候报一行，快的不打——否则每个页面都多一行噪音。 */
          const tRec = Date.now();
          task = SVC.pendMerge(await SVC.record(hit.record_id, hit.script_id));
          const recMs = Date.now() - tRec;
          if (recMs > 800) UI.appendLog({ t: Date.now(), level: 'info', msg: '取数 ' + (recMs / 1000).toFixed(1) + 's（/task 往返：服务端回读业务表）' });
          task.on_match = hit.on_match;
        }
        task.on_match = hit.on_match;
        // 中转页：当前页只是跳板，取到数就把这个标签页「原地替换」成业务页。
        // 用 replace 而不是 open+close：脚本无权关闭不是自己打开的标签页，close 会被浏览器拒绝；
        // replace 还能保证浏览器历史里不留中转页，用户按后退不会再次触发。
        if (hit.redirect_to) {
          const vars = Object.assign({}, task.params || {}, task.display || {}, { record_id: hit.record_id });
          const to = SVC.tpl(hit.redirect_to, vars);
          if (!/^https:\/\//.test(to)) throw new Error('E_SPEC redirect_to 不是 https 地址：' + to);
          let host = '';
          try { host = new URL(to).host; } catch (e) {}
          SVC.pendSet(task, host);
          UI.notice('已取到记录 ' + hit.record_id + '，正在打开业务页面…');
          SVC.go(to);
          return;
        }
        await UI.loadTriggeredTask(task);
        if (hit.on_match === 'fill_and_run') {
          UI.appendLog({ t: Date.now(), level: 'warn', msg: '该场景声明 on_match=fill_and_run：参数已填充，立即开跑' });
          await UI.runTask(task, document.getElementById('masr-trigger-run'));
        }
      } catch (e) {
        UI._triggerTask = null;
        UI._triggerErr = '按记录取数失败：' + e.message;
        UI.renderTrigger();
        UI.appendLog({ t: Date.now(), level: 'warn', msg: '按记录取数失败：' + e.message });
        // 中转页没有主面板，必须让人看见失败原因，否则会以为按钮坏了
        if (!document.getElementById('masr-trigger-box')) {
          UI.notice('取数失败：' + e.message + '（不会继续，请回业务表核对该行状态）', 'error');
        }
      } finally {
        busy = false;
      }
    }

    window.addEventListener('hashchange', function () { fire('hashchange'); }, true);
    window.addEventListener('popstate', function () { fire('popstate'); }, true);
    setInterval(function () {
      if (location.href === lastHref) return;
      lastHref = location.href;
      fire('url-change');
    }, 1200);
    fire('boot');
    return fire;
  }

  /* 记一笔「人点了退出」：随后落到登录页时不再自动登录（见 SVC.logoutGuard）。
   * 退出是人的动作，spec 无从得知，只能由引擎在捕获阶段旁听这一次点击。
   * 只认菜单项文本精确等于退出语义的，避免把「退出全屏」之类误记成登出。 */
  function watchLogoutClick() {
    if (window.__masrLogoutWatch) return;
    window.__masrLogoutWatch = true;
    try {
      document.addEventListener('click', function (ev) {
        try {
          let el = ev.target;
          for (let i = 0; i < 5 && el; i++) {
            const cls = String(el.className || '');
            if (cls.indexOf('el-dropdown-menu__item') >= 0 || cls.indexOf('dropdown-item') >= 0) {
              const t = String(el.textContent || '').replace(/\s+/g, '');
              if (t === '退出' || t === '退出登录' || t === '登出' || t === '注销') {
                let rid = '';
                try { rid = new URLSearchParams(location.href.split('#')[0].split('?')[1] || '').get('recordId') || ''; } catch (e) {}
                SVC.markLogout(rid);
              }
              break;
            }
            el = el.parentElement;
          }
        } catch (e) {}
      }, true);
    } catch (e) {}
  }

  function boot() {
    watchLogoutClick();
    // 中转页判定必须发生在「挂面板之前」：脚本同样注入在跳板域名（如业务表按钮打开的百度页）上，
    // 若先挂面板，用户日常打开那些页面就会看到工作台——那是污染，不是功能。
    if (!SVC.code()) { mountAll(); return; }
    const peek = SVC.peekTrigger();                    // 快路径：缓存新鲜时同步判定，零等待
    if (peek && peek.redirect_to) { try { armUrlTrigger(); } catch (e) {} return; }
    SVC.scenes().then(function () {                    // 慢路径：首次安装/缓存过期，先取规则再决定
      const hit = SVC.matchTrigger();
      if (hit && hit.redirect_to) { try { armUrlTrigger(); } catch (e) {} return; }
      if (hit) { mountAll(); return; }
      /* 零命中：可能只是「刚发布的新场景不在旧缓存里」（TTL 10 分钟），不是「这页没场景」。
       * 强刷一次再判（内部 60s 限流），否则发版后第一次点按钮会静默无反应。 */
      return SVC.scenesWhenUnmatched(location.href).then(function (fresh) {
        if (fresh && fresh.redirect_to) { try { armUrlTrigger(); } catch (e) {} return; }
        mountAll();
      });
    }).catch(function () { mountAll(); });
  }

  /* 常规业务页：挂面板、恢复中转页带过来的任务、起触发监听 */
  function mountAll() {
    UI.mount();
    UI.renderTasks();
    UI.replayPersistedLogs(); // 跨页日志回放：任何页面加载都能看到之前全部输出
    // 中转页刚取到的任务：跳到业务页后在这里恢复。宿主要对得上，
    // 否则在别的媒体页面上也会冒出这张卡（pending 只对声明它的业务页有效）。
    if (SVC.code()) {
      const pend = SVC.pendGet();
      if (pend && pend.t) {
        if (SVC.pendAccept(pend, location.host)) {
          if (pend.t.handoff === true) {
            /* 交接上下文不动手：它只是「上一条流水线把哪条记录交给了本场景」的凭据，
             * 参数要由本页场景自己按 record_id 去 /task 取（凭据不下发到本地存储）。
             * 这里点明一句，否则新标签页打开后一片空白，看不出到底接没接上。
             * 同一页会 mountAll 多次（路由变化/刷新），同一份交接只提示一次，别刷屏。 */
            if (UI._pendLoggedFor !== pend.t.record_id) {
              UI._pendLoggedFor = pend.t.record_id;
              UI.appendLog({ t: Date.now(), level: 'info', msg: '已接管上游交接的任务上下文（记录 ' +
                pend.t.record_id + ' → 场景 ' + pend.t.script_id + '），由本页场景认领后取数' });
            }
          } else {
            (async function () {
              try { await UI.loadTriggeredTask(pend.t); SVC.pendClear(); }
              catch (e) { UI.notice('已取到记录，但载入场景失败：' + e.message + '（可回业务表重新点按钮）', 'error'); }
            })();
          }
        }
      }
    }
    // 场景元数据 + URL 触发：规则同样来自 spec.scene.trigger（Runner 不登记任何场景）
    // 命中后自动按 record_id 取数并填充参数，但不自动开跑——含不可逆步骤的流程必须人点。
    if (SVC.code()) {
      try { armUrlTrigger(); } catch (e) { /* 触发失败不影响手动流程 */ }
    }
    // 版本落点：解释器升级后第一次加载，明确告诉人「现在跑的是哪个版本」
    try {
      const cur = UI.installedVersion();
      const seen = String(GM_getValue(UPD.SEEN_KEY, '') || '');
      if (seen !== cur) {
        GM_setValue(UPD.SEEN_KEY, cur);
        if (seen) UI.appendLog({ t: Date.now(), level: 'ok', msg: 'Runner 已从 v' + seen + ' 更新到 v' + cur + '（本页已生效）' });
      }
    } catch (e) {}
    // 更新流程收尾：装完回到页面 → 自动重载（不打断正在跑的任务；最多自动重载一次，绝不循环）
    armReloadWatch();
    if (pendGet()) maybeReloadAfterUpdate();
    // 有没写进飞书的结果：提示一次，按钮在「任务」行
    const pw = pwList();
    if (pw.length) {
      /* 同一份队列会在每次页面加载/每次注入时都提醒一遍（真机上 8 秒里刷了 4 次，全是同一件事）。
       * 用「队列签名」去重：内容没变就只说一次，内容变了（新增/补写成功）才再说。
       * 同时把记录和上报状态写清楚——只说「有 1 条」没法判断表里现在是什么状态。 */
      const sig = pw.map(function (p) { return p.record_id + ':' + p.status + ':' + (p.queued_at || 0); }).join(',');
      let seenSig = '';
      try { seenSig = sessionStorage.getItem('masrPwWarnSig') || ''; } catch (e) {}
      if (sig !== seenSig) {
        try { sessionStorage.setItem('masrPwWarnSig', sig); } catch (e) {}
        UI.appendLog({
          t: Date.now(), level: 'warn',
          msg: '有 ' + pw.length + ' 条结果还没写进飞书（已存本地）：' +
            pw.map(function (p) { return p.record_id + '（上报状态=' + p.status + '）'; }).join('、') +
            '——表里此刻还是旧状态，点「重试回写」补写后才算完',
        });
      }
    }
    /* 队列里有货 → 上面那条提示照旧出现（人需要知道表里还没写），但别停在这儿等人工：
     * 后台自己补写一遍。延迟 3s 把首次渲染/取 spec 的机会让出来；补不成功也只是留在队列里，
     * 顶多回到「点重试回写」的老路，不会更差。 */
    if (pw.length) setTimeout(function () { autoFlushPending(); }, 3000);
    // 自动恢复上次加载的 spec 与参数：刷新、跳转落地、新标签页都不用重新粘贴
    try {
      const lastSpec = GM_getValue(GV.LAST_SPEC_KEY, '');
      if (lastSpec) {
        UI.applySpec(lastSpec, { fromStore: true, persist: false });
        if (UI.spec) UI.restoreSpecText();
      }
    } catch (e) { /* 恢复失败不影响手动粘贴 */ }
    const st = RunState.get();
    /* 卡在 running 的运行态：页面被 302/关标签打断时，doRun 的 finally 根本没机会跑，
     * 状态会永远停在 running。之前这种状态完全没人提——下一张页面既不复跑也不提示，
     * 人只能看到「续跑状态=存在: running」和一片空白日志（2026-11-06 实测）。
     * 心跳超过 2 分钟没有更新 → 判定为「被打断」，只标记不清理：
     * 别的标签页可能真的在跑，清掉会拆掉别人正在用的状态。 */
    if (st && st.phase === 'running' && Date.now() - Number(st.beatAt || st.startedAt || 0) > 120000) {
      const when = new Date(Number(st.startedAt || 0));
      st.phase = 'interrupted';
      RunState.set(st);
      UI.appendLog({
        t: Date.now(), level: 'warn',
        msg: '上一次执行「' + (st.specId || '?') + ' v' + (st.specVersion || '?') + '」没有跑完（' +
          (st.startedAt ? when.toLocaleString('zh-CN') : '时间未知') + ' 开始，页面被跳转或关闭打断）：已标记为中断，' +
          '不影响本页重新执行；需要彻底清掉就在任务区点「清除续跑状态」',
      });
    }
    /* 0.9.20 兜底：done 且 final 未消费、躺了 2 分钟以上 → 压掉重播（不再重复弹结果）。
     * 老版本留下的残留 / 发起页已关掉没人消费的 final 都归这里；2 分钟内的留着，
     * 给发起页轮询器留出消费窗口（结果展示 + 补回写）。 */
    if (st && st.phase === 'done' && st.final && !st.final.consumed &&
        Date.now() - Number(st.final.at || 0) > 120000) {
      st.final.consumed = true;
      RunState.set(st);
    }
    if (st && st.phase === 'await_nav_check') {
      UI.replayStepLogs(st.stepLogs);
      // 自动续跑条件：①状态新鲜（10 分钟内）②当前页 URL 匹配本步 expect——避免在错误的标签页上误启动
      const fresh = Date.now() - (st.navAt || 0) < 10 * 60 * 1000;
      const urlOk = !st.navExpect || !st.navExpect.url_contains ||
                    location.href.indexOf(st.navExpect.url_contains) >= 0;
      if (fresh && urlOk) {
        try {
          sessionStorage.setItem('masrRole', 'helper');
          if (st.runId) sessionStorage.setItem('masrRunId', st.runId);
        } catch (e) {}
        armNavResumeReady(st);   // 就绪即续：不再盲等固定 2.5s（快页面省 2s，慢链路按 cookie 到位触发）
      } else {
        UI.appendLog({ t: Date.now(), level: 'warn', msg: '检测到未完成的导航续跑（' + st.navStepId + '）：本页不匹配落地条件或状态过旧，点「执行」手动校验' });
      }
      console.log('[MASR] await_nav_check:', st.navStepId, 'expect=', st.navExpect, 'auto=', fresh && urlOk);
    }
    // 辅助页收摊：监听一次性「流程结束」信号，与本页所属的 runId 对上就自毁。
    // 这条独立于发起页是否已消费结果——否则上游页会被 final.consumed 卡住永远不关。
    setInterval(function () {
      let role, myRun;
      try { role = sessionStorage.getItem('masrRole') || ''; myRun = sessionStorage.getItem('masrRunId') || ''; } catch (e) { return; }
      if (!role || role === 'origin') return;
      const sig = CloseSig.get();
      if (!sig || Date.now() - sig.at > 5 * 60 * 1000) return;
      // runId 必须对上（任一为空则保守不关，宁可留着也不误杀别的流程的页面）
      if (!sig.runId || !myRun || sig.runId !== myRun) return;
      try { window.close(); } catch (e) {}
    }, 800);

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
        // 回写飞书（只有带任务上下文时才写；服务端会再校验归属；manual 模式的 final 不自动写）
        if (!s.final.written && !s.final.manual) {
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
  /* 回写与运行态的测试钩子：待写队列去重、「队列里有 ok 就不许写 fail」、冻结后不许复活，
   * 这几条都只能从内部触发，但从 UI 端又很难稳定构造。它们每一个出错都意味着
   * 「表里状态错」或「多建一个成员」，所以明确暴露出来给单测钉住（生产路径不会调用）。 */
  try {
    (unsafeWindow || window).__MASR_TEST_WB__ = {
      pushTaskResult: pushTaskResult, pwList: pwList, pwSave: pwSave, RunState: RunState,
      /* 节奏探针只能在「主线程被真的占住」时验证，UI 上没法稳定构造；单独暴露给 pace-watch-smoke
       * （不暴露就只能靠真机等下一次卡顿，等于不验证）。生产路径不会调用。 */
      startPaceWatch: startPaceWatch,
      /* 更新检查要能用「三个源互相矛盾」的假响应验证（真机很难等到这种现场），暴露给
       * update-source-smoke。只读引用，生产路径不经过这里。 */
      checkUpdate: UI.checkUpdate,
      newUrl: function () { return UI._newUrl || ''; },
      /* 异步回写要能验证「入队→后台写→出队→跨页成功凭证」这条链，暴露给 async-writeback-smoke */
      autoFlushPending: autoFlushPending, pwDel: pwDel, markWbOk: markWbOk, wbOkRecent: wbOkRecent,
      /* spec 缓存版本校验（0.9.19）：要验证「缓存 0.2.0 / 线上 0.4.0 → 本次就换新版」，
       * 只能从 /task 回包里带版本号那条路走，UI 上没法稳定构造（线上不会配合同时发两个版本）。
       * 生产路径不会调用。 */
      loadTriggeredTask: UI.loadTriggeredTask,
      appliedSpecVersion: function () { return (UI._specCache || {}).version || ''; },
      /* 手动同步 spec（0.9.22）：要验证「强制绕开缓存 / 失败不清旧缓存 / 只换当前这份」，
       * 只能构造「本机缓存旧、线上新」的假响应，真机等不到。生产路径不会调用。 */
      forceSyncSpec: function () { return UI.forceSyncSpec(); },
    };
  } catch (e) {
    window.__MASR_TEST_WB__ = {
      pushTaskResult: pushTaskResult, pwList: pwList, pwSave: pwSave, RunState: RunState,
      startPaceWatch: startPaceWatch,
      checkUpdate: UI.checkUpdate,
      newUrl: function () { return UI._newUrl || ''; },
      /* 异步回写要能验证「入队→后台写→出队→跨页成功凭证」这条链，暴露给 async-writeback-smoke */
      autoFlushPending: autoFlushPending, pwDel: pwDel, markWbOk: markWbOk, wbOkRecent: wbOkRecent,
      /* spec 缓存版本校验（0.9.19）：要验证「缓存 0.2.0 / 线上 0.4.0 → 本次就换新版」，
       * 只能从 /task 回包里带版本号那条路走，UI 上没法稳定构造（线上不会配合同时发两个版本）。
       * 生产路径不会调用。 */
      loadTriggeredTask: UI.loadTriggeredTask,
      appliedSpecVersion: function () { return (UI._specCache || {}).version || ''; },
      /* 手动同步 spec（0.9.22）：要验证「强制绕开缓存 / 失败不清旧缓存 / 只换当前这份」，
       * 只能构造「本机缓存旧、线上新」的假响应，真机等不到。生产路径不会调用。 */
      forceSyncSpec: function () { return UI.forceSyncSpec(); },
    };
  }
  // 触发匹配/模板/跨页传递是纯逻辑，单独暴露给回归探针（只读引用，不改变运行行为）
  try { (unsafeWindow || window).__MASR_TEST_SVC__ = SVC; } catch (e) { window.__MASR_TEST_SVC__ = SVC; }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.__MASR_BOOT__ = boot;
})();
