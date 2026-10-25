# dsh-memory-curve

四层记忆，从 AstrBot 插件 [`astrbot_plugin_memory_curve`](https://github.com/)（作者：宅家大肥鱼，v1.0.3）搬到 DeepSeek Harness 上。

作者：宅家大肥鱼。两版同一个作者，接口换了，脾气没换。

原来那套设计一句话就能说完：**该记的留着，跑腿的事别留着**。

| 层 | 是什么 | 存在哪 | 什么时候进提示 |
| --- | --- | --- | --- |
| L1 | 原文窗口 | `l1.json`，保留 `l1MaxTurns × 4` 条 | 不进（宿主自己有历史），只给判分器当上下文 |
| L2 | 短期摘要 | `l2.json`，`score ≥ 2` 入，默认 24h 过期 | 【短期记忆】，最近 `l2MaxItems` 条 |
| L3 | 长期事实 | `l3.json`，`score ≥ 4` 且不是一次性任务，每天提升一次，默认 30 天没被提到就过期 | 【长期记忆】，最多 `l3MaxItems` 条 |
| L4 | 全量存档 | `archive/<YYYY-MM-DD>.jsonl` | 只在说了「之前 / 上次 / 还记得…」时按关键词回溯，最多 `retrieveLimit` 条 |

## 跟原插件的差别

| 原插件（AstrBot） | 这里（DSH） |
| --- | --- |
| `on_llm_request` 改写 `req.system_prompt`，并用 L1 覆盖 `req.contexts` | `systemPrompt.section()` 每轮现算注入一段；**不动宿主历史**（历史归宿主和 compress 管） |
| 判分失败一律给 2 分 | 判分走 `ctx.get('llm').stream()`，模型不可用/超时/吐垃圾时退回本地启发式（能识出「记住 / 生日 / 不吃 / 习惯」这类稳定事实给 4-5 分） |
| 管理指令 `记忆`（admin） | 五个工具：`memory_curve_list / search / add / forget / prune`。群聊默认只读，本地会话和私聊能改 |
| `umo` 当目录名 | `session.id`（本地会话原样，QQ 侧就是 `onebot-private-<qq>` / `onebot-group-<gid>`） |
| 数据目录由插件配置 | 默认 `~/.dsh/memory-curve`，一个会话一个子目录 |

词表、阈值、「一次性任务不进 L3」的白/黑名单都是原样搬的：`ONEOFF_MARKS` / `STABLE_MARKS` / `RECALL_WORDS` / `STOP_WORDS` / `PROMISE_WORDS`。

## 装

在 npm 上：`npm i dsh-memory-curve`（版本跟这里同步，MIT）。装完把包名加进 profile 的 `dsh.profile.bundles`，或者干脆用下面的 link 方式直接挂本地目录——改代码不用重装。

```bash
node scripts/patch-profile.mjs            # 幂等，可先加 --dry 看
node scripts/patch-profile.mjs --profile <profile 目录>
```

它只做两件事：`dependencies` 加一条 `link:`、`dsh.profile.bundles` 加个名字。之后手工建 `node_modules` 链接（Windows 用 junction）：

```powershell
New-Item -ItemType Junction `
  -Path "$HOME\.dsh\profiles\desktop\node_modules\dsh-memory-curve" `
  -Target "C:\Users\<你>\Documents\deepseek-harness\default-workspace\dsh-memory-curve"
```

然后**重启一次** DeepSeek Harness。看 `<dataDir>\.boot.json` 就知道 `apply` 跑没跑（里面还记了 `llm` / `systemPrompt` / `tools` 三个服务当场在不在）。

## 配置

改 profile 的 `cordis.patch.yml` 顶层，同 id 覆盖：

```yaml
- id: dsh-memory-curve
  config:
    l1MaxTurns: 10
    l2ExpireHours: 24
    l2MaxItems: 10
    l3ExpireDays: 30
    l3MaxItems: 20
    retrieveLimit: 3
    archiveDays: 7
    enableJudge: true          # 关掉就纯本地启发式，不花模型调用
    judgeModel: ''             # 'provider/model'，空 = 用当前默认模型
    maxInjectChars: 1800       # 注入块上限
    memoryBias: ''             # 额外备注，拼在记忆块末尾
    toolsEnabled: true
    allowGroupEdit: false      # 群聊允许改记忆？
    dataDir: ''                # 默认 ~/.dsh/memory-curve
```

## 设置页

浏览器那半端在 `client.js`（自注册脚本，`window.__ModuleLoader__.load`），往 `settings.section` 这个 slot 里注册一栏，所以重启之后 **设置 → 记忆曲线** 会多出一页：

- 左边是会话列表（长期 / 短期 / 原文条数、最后更新时间），右边是这个会话攒下的条目：长期在前、短期在后，带序号、分数、类型、时间。
- 能手动塞一条（直接进 L3，标 `manual`，5/4/3 分可选）、按序号删、一键清掉一次性任务；搜索框在「条目」页是本地筛，切到「旧对话」就翻 archive 原文。
- 数据接口在宿主侧 `lib/panel.js`，前缀 `/api/memory-curve`（`/state` `/memory` `/search` `/add` `/forget` `/prune` `/ping`），**只认回环地址**，真外站一律 403；`file://` 外壳或沙箱 iframe 那种 `Origin: null` 的请求会放行——不然页面自己的 fetch 会被自己人挡掉，看起来就是「接口不通」。
- 写入走的是同一套 `MemoryCurve` 方法，所以备份、去重、过期照旧生效——面板只是给你一个能看见的地方，不是旁路。

### 面板说「接口不通」怎么查

宿主侧每个请求都往 `<dataDir>/panel.log` 记一行（方法、路径、判决码、耗时、Host / Origin / sec-fetch-site），另有一份页面半端的启动心跳：

- `~/.dsh/memory-curve/.boot-web.json` — `stage` 是 `web-mounted` 说明路由挂上了；`web-failed` 会带 `error`。
- `~/.dsh/memory-curve/panel.log` — 有行说明请求确实到了宿主；一行都没有就是请求没发出去（多半是页面侧地址不对）。
- `curl http://127.0.0.1:<GUI 端口>/api/memory-curve/ping` — 出 JSON 就说明宿主这半边是好的。

页面侧会依次试 `/api/memory-curve` → `http://127.0.0.1:<端口>/api/memory-curve` → `localhost` 三条地址，全不通才报错，并把试过的东西写在红框里。

配置项（`dataDir`、阈值、判分模型）在面板里只读显示，要改还是去 profile 的 `cordis.patch.yml`。

## 自测

```bash
npm test                        # 逻辑 + 宿主仿真 + 设置页接口 + 真 HTTP 端到端
node test/smoke.mjs             # 词表 / 配置钳位 / 落盘 / 四层 / 判分降级
node test/host-sim.mjs          # 假 ctx 把 apply 真跑一遍，喂一轮问答看注入 / 工具 / 路由
node test/panel.mjs             # 假 req/res 打 /api/memory-curve/*，含跨站与坏 JSON
node test/panel-live.mjs        # 起真 http 服务器，用真请求打 Origin: null / 预检 / 外站 403 / 日志
node scripts/verify-wiring.mjs  # 查装配：patch 只 insert 一次、link 能解析、client.js 与清单在位
```

## 已知取舍

- **不改历史**：原插件会用 L1 窗口覆盖上下文，这里不做——DSH 的历史、压缩、摘要都是宿主自己的事，抢了会打架。
- **判分要花一次模型调用**：每轮一次、`maxTokens: 200`、`temperature: 0`。嫌吵就把 `enableJudge` 关掉，启发式不动模型。
- 注入块是**每轮现算**的同步函数，所以只读缓存 + 几个 KB 的 JSON；真要翻 archive 也只读最近 `archiveDays` 个文件。
- 「我答应过：…」是从我的回复里抽的，规则跟原插件一致（4-40 字、含「我」、含承诺词），会漏，会误抽，属于已知精度问题。

MIT。