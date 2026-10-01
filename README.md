# 数字展品使用授权核验应用

供小型展馆在选取数字展品组成展览包时，沿**全部来源链**逐节点核验使用授权（媒介、地区、有效期、撤销状态），并在发布时**原子保存不可变的核验快照与素材清单**。授权随后变更时自动重算资格，仅把“由合格变不合格”的已发布包标记为**需复核**，原快照始终保留。

- 后端：Node.js 20 + Express + better-sqlite3（SQLite，同步事务）
- 前端：原生 HTML/CSS/JS，无构建步骤
- 交付：Dockerfile + docker-compose 一键启动，数据库自动初始化

---

## 一、一键启动（Docker Compose，推荐）

前置：已安装 Docker 与 Docker Compose 插件。

```bash
docker compose up --build -d
```

启动后打开浏览器：

- **Web 地址：http://localhost:3000**

首次启动会自动建表并写入一份演示数据（由 `SEED_DEMO=1` 控制；数据库非空时自动跳过）。
停止 / 查看日志：

```bash
docker compose logs -f
docker compose down            # 停止（数据保留在命名卷 exhibit-data 中）
docker compose down -v         # 停止并删除数据库卷（清空全部数据）
```

## 二、本机直接运行（不用 Docker）

前置：Node.js ≥ 20。better-sqlite3 会优先下载预编译二进制；若本机无编译环境且无法访问 GitHub，可使用 npmmirror 镜像：

```bash
# 安装依赖（两种方式任选）
npm ci || npm install
# 若卡在 better-sqlite3 预编译下载，可指定镜像后重试：
# npm_config_better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3 npm install

# 可选：初始化演示数据
npm run seed

# 启动
npm start
# → http://localhost:3000
```

运行自检（需先启动服务）：

```bash
node test/e2e.js
```

---

## 三、使用流程

界面分两个标签页：

1. **素材与来源**
   - 登记素材（名称、类型、备注）。
   - 维护来源关系：「本素材 使用了 ← 来源素材」。关系按边逐条核验，添加会成环的边将被拒绝并提示完整闭环。
   - 登记授权：媒介、地区、有效期（起止日期）、撤销状态、授权方。媒介或地区填 `*` 表示通配任意值；匹配忽略大小写；有效期按闭区间覆盖整段使用期（`valid_from <= 使用起始` 且 `valid_to >= 使用截止`），已撤销授权一律不计入。
2. **展览包与核验发布**
   - 新建待发布包：填展示媒介、地区、起止日期，勾选入展素材（系统会自动纳入其全部上游来源节点）。
   - 点「核验」：沿每个入展品的**全部**来源路径遍历，逐节点检查是否至少有一份“未撤销 + 媒介命中 + 地区命中 + 覆盖整段使用期”的授权。结果列出：
     - 全局错误（缺媒介/地区、日期不合法、起晚于止等）；
     - 不合格节点及其原因（无授权 / 全部撤销 / 媒介不符 / 地区不符 / 日期不覆盖 / 成环）；
     - 每个不合格节点的全部来源路径（入展品 → … → 问题节点）。
   - 点「按此次核验结果原子发布」：
     - 服务端在事务内**重新读取并重算**，并比对“核验依据版本”。若核验之后授权或来源关系被任何人修改过，返回 `409 STALE_BASIS`，拒绝发布并提示重新核验；
     - 核验不通过（缺授权、日期不合法等）返回 `422`，包保持“待发布”，但本次尝试同样留存为不可变记录；
     - 通过则在**单个 SQLite 事务**内写入不可变核验快照（完整逐节点结果 JSON + 冻结清单 + 依据版本）并置为“已发布”。

### 授权变更后的行为（先预演、再确认）

- 授权的**单笔增/改/撤/删**或来源关系的**单条增/删**，界面默认「先做影响预演，再确认提交」（右上角开关可关闭，关闭后走既有编辑接口直接保存，行为与旧版一致）。
- 预演输入字段沿用对应现有编辑接口与校验（媒介/地区非空、日期合法且起不晚于止、不得自环、新增来源不得成环等）；**预演只读**，在回滚型事务中模拟变更并重算，只返回：
  - 因该变更将**由合格转为不合格的已发布展览包**（需复核包/待发布包不在其列）；
  - 每个包的问题节点、原因（无授权 / 全部撤销 / 媒介不符 / 地区不符 / 日期不覆盖等）及全部来源路径；
  - 预演所依据的 `basisVersion` 与影响清单指纹；预演**不改动**授权、关系、包状态或快照，依据版本也不变。
- 确认时把**同一操作字段连同预演结果**（`basisVersion` + `impact`）一起提交。服务端在**单个事务内**：核对依据版本 → 重新校验输入/目标/成环 → 应用变更并重算影响 → 与预演清单比对 → 全部通过才提交。任一不符整体回滚、**无部分写入**：
  - 依据版本不一致 → `409 STALE_BASIS`；
  - 影响清单与重算结果不一致 → `409 IMPACT_MISMATCH`（响应里附服务端最新影响清单）；
  - 预演后目标（授权/来源边）被删除或素材失效 → `409 TARGET_GONE`；
  - 输入非法 → `400`；成环 → `409 CYCLE`（含 `cyclePath`/`cycle`）。
  - 界面在过期/漂移时给出过期提示并可一键「重新预演」后再确认。
- 成功后按现有规则执行：变更落库、仅把“合格→不合格”的已发布包置为 `needs_review` 并**追加**不可变复核快照；原发布快照一行不改、不会删除。
- 需复核包不会自动恢复。补正授权后，在界面点「重新核验（人工复核）」：合格则恢复为已发布，不合格则保持需复核；两种结果都会再追加一条快照。
- 已有编辑接口（直接增删改）的请求与返回保持兼容；已发布/需复核包的参数与清单仍不可编辑、不可删除，需要调整时点「复制为待发布包」。

### 档期规划（为待发布包选可用起始日）

策展人可为**待发布**包输入规划起止日，系统按包**当前展期天数（含首尾）**，在规划窗口内查找**完整落在窗口内**的可用起始日：

- 对**入展素材及其全部上游来源节点**逐一判定：每个起始日对应的展期，节点必须被**同一份**未撤销、媒介与地区匹配（`*` 通配、忽略大小写）的授权**完整覆盖**（闭区间）。不同节点可以用不同授权；同一节点的**短授权不可拼接**——每份授权按展期天数折算为一段可行起始日区间（`valid_from ≤ 起始日` 且 `valid_to ≥ 起始日 + 天数 − 1`），不足整段的短授权折算为空。
- 结果按日期**升序合并连续可行起始日**，逐段给出范围与该段的**最早展期**；窗口放不下整段展期时明确提示窗口过短。
- **无结果**时，列出各**受限节点在窗口内各自的可用起始日范围**（及无授权/全撤销/媒介不符/地区不符/短授权不可拼接等原因），用以解释各节点范围的交集为何为空；全窗口都可用的节点不构成约束，不列出。
- 空包、包当前展期缺失或非法、规划窗口非法均直接报 `400`；已发布/需复核包搜索档期报 `409 NOT_DRAFT`（请用「复制为待发布包」）。

**选定档期**时把搜索返回的 `searchToken` 与起始日回传，服务端在**单个事务内重验**，下列任一变化都**整体拒绝且不改包**：

| 拒绝码 | 触发条件 |
| --- | --- |
| `409 STALE_BASIS` | 搜索后授权或来源关系被增删改（核验依据版本变化） |
| `409 PACKAGE_CHANGED` | 搜索后包参数（媒介/地区/展期）或素材清单被修改（或被清空） |
| `409 NOT_DRAFT` | 包已不再是待发布状态（已被发布等） |
| `409 SLOT_INVALID` | 选定起始日落出搜索窗口，或其展期在当前授权下已不被完整覆盖（附失效节点） |
| `409 TOKEN_MISMATCH` | 搜索令牌不属于该包或内容损坏 |

改期只更新待发布包的起止日期（展期天数保持不变），不发布、不写核验快照、不动清单；随后仍走既有「核验 → 发布」流程。

---

## 四、核验规则要点

| 规则 | 说明 |
| --- | --- |
| 来源方向 | 边 `素材 → 来源素材`；核验自入展品沿边向上游遍历全部路径 |
| 成环 | 新增边前做可达性预判（若来源已能到达本素材则拒绝）；核验时 DFS 再次检测并把环上节点列为不合格 |
| 授权命中 | 未撤销；媒介相等或授权媒介为 `*`；地区相等或授权地区为 `*`（忽略大小写） |
| 日期覆盖 | `授权.valid_from ≤ 使用起始` 且 `授权.valid_to ≥ 使用截止`（闭区间） |
| 节点合格 | 至少一份授权同时满足上述全部条件（单份授权必须独自覆盖整段使用期，不跨授权拼接） |
| 发布闸门 | 无全局错误、无缺失素材、无环、无不合格节点，且依据版本未过期 |

不可变性由数据库强制：`verification_snapshots` 表上配置了 `BEFORE UPDATE` / `BEFORE DELETE` 触发器，任何修改或删除都会被 SQLite 直接拒绝。

## 五、配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | 本地 `./data/app.db`（容器内 `/data/app.db`） | SQLite 数据库文件路径，所在目录自动创建 |
| `SEED_DEMO` | `0`（compose 中为 `1`） | 启动时若库为空则写入演示数据 |

修改端口（例如改为 8080）：编辑 `docker-compose.yml` 的 `ports: - "8080:3000"`（宿主机端口:容器端口），或直接运行时 `-e PORT=...` 并同步映射。

## 六、数据持久化与备份

- Compose 使用命名卷 `exhibit-data` 挂载到容器 `/data`，数据库（WAL 模式）在 `docker compose down` 后仍然保留。
- 备份：`docker compose exec exhibit-auth node -e "const db=require('better-sqlite3')(process.env.DB_PATH);db.backup('/data/backup.db').then(()=>process.exit(0))"` 后从卷中取 `/data/backup.db`；或停服后直接复制 `app.db`、`app.db-wal`、`app.db-shm`。

## 七、主要 HTTP API

| 方法 路径 | 作用 |
| --- | --- |
| `GET /api/state` | 依据版本与计数 |
| `GET/POST /api/materials` · `PATCH/DELETE /api/materials/:id` | 素材 CRUD |
| `POST /api/materials/:id/sources` · `DELETE /api/source-links/:id` | 来源关系（成环返回 409 + `cyclePath`/`cycle`） |
| `POST /api/materials/:id/authorizations` · `PATCH /api/authorizations/:id` · `POST /api/authorizations/:id/revoke` · `DELETE` | 授权登记/修改/撤销/删除 |
| `GET/POST /api/packages` · `PATCH/DELETE /api/packages/:id` · `POST /api/packages/:id/copy` | 展览包 |
| `POST /api/verify` | 试核验（body 可传 `packageId` 或完整字段） |
| `POST /api/packages/:id/schedule/search` | **档期搜索**（只读）：按包当前展期天数（含首尾）在规划窗口内查全部来源链节点均被同一份匹配授权完整覆盖的可用起始日，升序合并连续日 |
| `POST /api/packages/:id/schedule/apply` | **选定档期改期**：body 携搜索返回的 `searchToken` 与 `useFrom`，事务内重验依据版本/包参数清单/状态/档期失效，任一不符拒绝且不改包 |
| `POST /api/packages/:id/publish` | 发布，body 需含核验时的 `basisVersion`；过期 409、不合格 422 |
| `POST /api/packages/:id/recheck` | 对需复核包人工重新核验 |
| `POST /api/changes/preview` | **变更影响预演**（只读）：单笔授权增改撤删 / 单条来源增删，返回将由合格转不合格的已发布包、问题节点、原因与依据版本 |
| `POST /api/changes/commit` | **确认提交同一操作 + 预演结果**：事务内核版本、重算并比对影响清单；过期/不一致/目标失效/非法均整体拒绝 |
| `GET /api/snapshots/:id` | 读取不可变快照完整内容 |

### 影响预演 / 确认 API 调用示例

请求体里的 `operation` 标识操作类型，其余字段与对应既有编辑接口完全一致。

| operation | 对应既有接口 | 关键入参 |
| --- | --- | --- |
| `authorization.create` | `POST /api/materials/:id/authorizations` | `materialId, media, region, validFrom, validTo, revoked?, licensor?, note?` |
| `authorization.update` | `PATCH /api/authorizations/:id` | `authorizationId` + 需修改字段（缺省沿用现值，含 `revoked`） |
| `authorization.revoke` | `POST /api/authorizations/:id/revoke` | `authorizationId` |
| `authorization.delete` | `DELETE /api/authorizations/:id` | `authorizationId` |
| `source.create` | `POST /api/materials/:id/sources` | `materialId, sourceMaterialId, relation?` |
| `source.delete` | `DELETE /api/source-links/:id` | `linkId` |

第 1 步——预演（不落库）：

```bash
curl -s -X POST http://localhost:3000/api/changes/preview \
  -H 'Content-Type: application/json' \
  -d '{"operation":"authorization.revoke","authorizationId":3}'
# → { "ok": true, "basisVersion": 10,
#     "impact": [ { "packageId": 1, "packageName": "常设展…",
#                   "failingNodes": [ { "materialId": 3, "title": "城市航拍素材",
#                                       "reasons": ["revoked"],
#                                       "reasonText": ["该节点的授权均已撤销"],
#                                       "paths": [ [ {"materialId":1,…}, {"materialId":3,…} ] ] } ] } ],
#     "impactFingerprint": "…", "mutated": false }
```

第 2 步——把**同一操作字段**连同预演给出的 `basisVersion` 与 `impact` 原样回传确认：

```bash
curl -s -X POST http://localhost:3000/api/changes/commit \
  -H 'Content-Type: application/json' \
  -d '{"operation":"authorization.revoke","authorizationId":3,
       "basisVersion":10,"impact":[ /* 原样粘贴 preview 返回的 impact */ ]}'
# → { "ok": true, "mutated": true, "basisVersion": 11, "impact": [ …同清单… ],
#     "message": "变更已执行：1 个已发布包被标记为需复核并已追加不可变复核快照；需复核包不会自动恢复。" }
```

新增来源边的预演（成环在预演阶段即被拒绝）：

```bash
curl -s -X POST http://localhost:3000/api/changes/preview \
  -H 'Content-Type: application/json' \
  -d '{"operation":"source.create","materialId":1,"sourceMaterialId":6,"relation":"引用"}'
```

可能的拒绝（均为 4xx，且不产生任何写入）：

```text
400  输入非法（空媒介/地区、日期非法或倒置、自环、缺少 id、未知 operation）
409  CYCLE           新增来源将成环（details.cyclePath / details.cycle）
409  STALE_BASIS     预演后授权/来源被他人改过（details.clientBasis/currentBasis）
409  IMPACT_MISMATCH 影响清单与当前重算不符（details.impact 为最新清单，请重新预演）
409  TARGET_GONE     预演后目标授权/来源边已被删除
404  预演时目标不存在
```

### 档期规划 API 调用示例

第 1 步——为待发布包搜索可用起始日（只读）：

```bash
curl -s -X POST http://localhost:3000/api/packages/12/schedule/search \
  -H 'Content-Type: application/json' \
  -d '{"planFrom":"2026-06-01","planTo":"2026-09-30"}'
# → { "ok": true, "durationDays": 7, "feasible": true,
#     "ranges": [
#       { "startFrom": "2026-07-10", "startTo": "2026-08-09", "dayCount": 31,
#         "earliestExhibitionFrom": "2026-07-10", "earliestExhibitionTo": "2026-07-16" }
#     ],
#     "restrictedNodes": [],
#     "basisVersion": 22,
#     "searchToken": { "packageId": 12, "basisVersion": 22, "fingerprint": "…",
#                      "planFrom": "2026-06-01", "planTo": "2026-09-30", "durationDays": 7 } }
```

无结果时 `feasible:false`，`restrictedNodes` 给出每个受限节点在窗口内的可用起始日范围以解释交集；窗口过短时 `windowTooShort:true`。

第 2 步——选定某段范围内的起始日应用（在事务内重验）：

```bash
curl -s -X POST http://localhost:3000/api/packages/12/schedule/apply \
  -H 'Content-Type: application/json' \
  -d '{"useFrom":"2026-08-09","searchToken":{ /* 原样粘贴 search 返回的 searchToken */ }}'
# → { "ok": true, "useFrom": "2026-08-09", "useTo": "2026-08-15",
#     "durationDays": 7, "package": { …更新后的待发布包… } }
```

拒绝均为 4xx 且不改动包，例如搜索后授权被修改：

```text
400  EMPTY_PACKAGE / INVALID_WINDOW / INVALID_DATE / 缺令牌（空包、非法窗口/日期、缺 searchToken）
409  STALE_BASIS     搜索后授权或来源关系发生变化（details.clientBasis/currentBasis）
409  PACKAGE_CHANGED 搜索后包参数或素材清单发生变化
409  NOT_DRAFT       包已发布或处于需复核
409  SLOT_INVALID    选定起始日落出窗口或档期已失效（details.failingNodes 为失效节点）
409  TOKEN_MISMATCH  搜索令牌与目标包不一致或已损坏
```

> 注意：应用成功后 `searchToken` 即作废（包展期已变），需要再次改期请重新搜索。

## 八、目录结构

```
.
├── Dockerfile              # 依赖安装 + 数据库初始化的多阶段镜像
├── docker-compose.yml      # 一键启动（端口 3000，命名卷持久化）
├── docker-entrypoint.sh    # 可选演示数据初始化后启动
├── package.json
├── src
│   ├── db.js               # SQLite 连接、建表、版本号/快照不可变触发器
│   ├── verify.js           # 来源链遍历、成环检测、逐节点授权核验、发布后重算
│   ├── schedule.js         # 档期规划：起始日可行区间折算/取交集/合并连续日、事务内重验改期
│   ├── changes.js          # 单笔变更影响预演（回滚型事务模拟）与确认提交（事务内核版本/比对影响）
│   ├── server.js           # Express API（发布事务、依据过期拒绝、/api/changes/preview|commit）
│   └── seed.js             # 演示数据
├── public                  # 浏览器前端（无构建）
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── test/e2e.js             # 端到端业务规则自检（104 项）
```
