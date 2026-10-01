'use strict';

// 档期搜索与应用
//
// 策展人为“待发布”展览包给定规划窗口 [windowFrom, windowTo]，按包当前展期天数
// （含首尾）查找完整落在窗口内的可用起始日。某起始日可用，当且仅当入展素材及其
// 全部上游来源节点，各自至少存在一份“未撤销 + 媒介命中 + 地区命中 + 独自完整覆盖
// 整段展期”的授权；不同节点可用不同授权，同一节点的短授权不可拼接。
//
// searchSchedules：只读，返回合并连续起始日后的可行范围；无结果时逐节点给出其在
//   窗口内的可用起始日范围，用于解释交集为何为空。同时返回 basisVersion 与
//   packageFingerprint，供应用时在事务内重验。
// applySchedule：在单个事务内核版本、核包参数/清单指纹、核状态，并重算选定档期；
//   任一不符整体拒绝且不改包。

const crypto = require('crypto');
const {
  isValidDate,
  scopeMatches,
  loadGraph,
  collectChains,
  verifyPackage,
  basisVersion,
  MAX_PATH_INSTANCES,
  MAX_CHAIN_DEPTH,
} = require('./verify');
const { nowIso } = require('./db');

class ScheduleError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDate(s) {
  return new Date(s + 'T00:00:00Z');
}

function addDays(s, n) {
  const d = parseDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function diffDays(from, to) {
  return Math.round((parseDate(to) - parseDate(from)) / DAY_MS);
}

// 闭区间合并：首尾相接（相邻）也合并为一段
function mergeRanges(ranges) {
  const sorted = ranges
    .filter((r) => r && r[0] <= r[1])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= addDays(last[1], 1)) {
      if (b > last[1]) last[1] = b;
    } else {
      out.push([a, b]);
    }
  }
  return out;
}

// 两组闭区间的交集
function intersectRanges(aRanges, bRanges) {
  const out = [];
  for (const [a, b] of aRanges) {
    for (const [c, d] of bRanges) {
      const lo = a < c ? c : a;
      const hi = b < d ? b : d;
      if (lo <= hi) out.push([lo, hi]);
    }
  }
  return mergeRanges(out);
}

function toRangeDTO(ranges) {
  return ranges.map(([from, to]) => ({ from, to, days: diffDays(from, to) + 1 }));
}

const str = (v) => (v === null || v === undefined ? '' : String(v));

// 包参数 + 清单指纹：搜索后若包被 PATCH（改名、改媒介/地区/起止、增减素材），
// 应用时指纹不一致即拒绝。状态单独显式比对。
function computeFingerprint(pkg, items) {
  const canon = {
    name: pkg.name,
    medium: pkg.medium,
    region: pkg.region,
    useFrom: pkg.use_from,
    useTo: pkg.use_to,
    items: [...items].map(Number).sort((a, b) => a - b),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canon), 'utf8').digest('hex');
}

function loadDraftPackage(db, packageId, phase) {
  const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(packageId);
  if (!pkg) throw new ScheduleError(404, '展览包不存在');
  if (pkg.status !== 'draft') {
    const code = phase === 'apply' ? 'STATUS_CHANGED' : 'NOT_DRAFT';
    throw new ScheduleError(
      409,
      `已发布/需复核包（状态 ${pkg.status}）不可搜索或改期；如需调整请复制为新的待发布包`,
      { code, status: pkg.status }
    );
  }
  const items = db
    .prepare('SELECT material_id FROM package_items WHERE package_id=? ORDER BY position, material_id')
    .all(packageId)
    .map((r) => r.material_id);
  if (items.length === 0) {
    throw new ScheduleError(400, '展览包为空包：未选取任何入展素材，无法搜索档期', { code: 'EMPTY_PACKAGE' });
  }
  const medium = (pkg.medium || '').trim();
  const region = (pkg.region || '').trim();
  if (!medium || !region) {
    throw new ScheduleError(400, '展览包缺少展示媒介或地区，无法按媒介/地区匹配授权档期', {
      code: 'INVALID_PACKAGE',
      medium: medium || null,
      region: region || null,
    });
  }
  if (!isValidDate(pkg.use_from) || !isValidDate(pkg.use_to) || pkg.use_from > pkg.use_to) {
    throw new ScheduleError(
      400,
      `包当前展期无效（${pkg.use_from || '（空）'} → ${pkg.use_to || '（空）'}），无法据其天数搜索档期；请先修正起止日期`,
      { code: 'INVALID_DURATION', useFrom: pkg.use_from || null, useTo: pkg.use_to || null }
    );
  }
  return { pkg, items, medium, region };
}

function parseWindow(body, { required = true } = {}) {
  const rawFrom = str(body.windowFrom).trim();
  const rawTo = str(body.windowTo).trim();
  const hasFrom = rawFrom !== '';
  const hasTo = rawTo !== '';
  if (!required && !hasFrom && !hasTo) return null;
  if (!hasFrom || !hasTo) {
    throw new ScheduleError(400, '规划起止日必须同时提供 windowFrom 与 windowTo（YYYY-MM-DD）', {
      code: 'INVALID_WINDOW',
      windowFrom: rawFrom || null,
      windowTo: str(body.windowTo).trim() || null,
    });
  }
  if (!isValidDate(rawFrom) || !isValidDate(rawTo)) {
    throw new ScheduleError(400, `规划窗口日期不合法：${rawFrom || '（空）'} → ${rawTo || '（空）'}（需为 YYYY-MM-DD 且为真实日期）`, {
      code: 'INVALID_WINDOW',
      windowFrom: rawFrom,
      windowTo: rawTo,
    });
  }
  if (rawFrom > rawTo) {
    throw new ScheduleError(400, `规划窗口不合法：起始 ${rawFrom} 晚于截止 ${rawTo}`, {
      code: 'INVALID_WINDOW',
      windowFrom: rawFrom,
      windowTo: rawTo,
    });
  }
  return { windowFrom: rawFrom, windowTo: rawTo };
}

// 遍历入展品的全部上游节点（复用核验引擎同一套 DFS），并做结构性防护
function collectNodeSet(db, roots) {
  const matRows = db.prepare('SELECT id, title, kind FROM materials').all();
  const matById = new Map(matRows.map((m) => [m.id, m]));
  const missing = roots.filter((id) => !matById.has(id));
  if (missing.length) {
    throw new ScheduleError(422, `包清单含已不存在的素材：#${missing.join('、#')}，无法搜索档期`, {
      code: 'UNVERIFIABLE',
      missing,
    });
  }
  const adj = loadGraph(db);
  const nodeIds = new Set();
  let cyclic = false;
  let truncated = false;
  let tooDeep = false;
  for (const root of roots) {
    const { nodePaths, cyclicNodes, truncated: t, tooDeep: td } = collectChains(adj, root);
    truncated = truncated || t;
    tooDeep = tooDeep || td;
    for (const id of cyclicNodes) cyclic = true;
    for (const id of nodePaths.keys()) nodeIds.add(id);
  }
  if (cyclic || truncated || tooDeep) {
    throw new ScheduleError(
      422,
      '来源结构无法完成档期核验（成环 / 路径超上限 / 链路过深），请先简化来源结构后重试',
      { code: 'UNVERIFIABLE', cyclic, pathCountTruncated: truncated, tooDeep, maxDepth: MAX_CHAIN_DEPTH, maxPathInstances: MAX_PATH_INSTANCES }
    );
  }
  return { nodeIds: [...nodeIds].sort((a, b) => a - b), matById };
}

// 单节点在候选起始日域 [domainFrom, domainTo] 内、由“单份授权独自覆盖”支撑的
// 可行起始日范围（短授权不拼接：每份授权各自贡献区间，再取并集）。
function feasibleStartsForNode(db, materialId, { medium, region, durationDays, domainFrom, domainTo }) {
  const rows = db
    .prepare('SELECT * FROM authorizations WHERE material_id=? AND revoked=0 ORDER BY id')
    .all(materialId);
  const ranges = [];
  for (const a of rows) {
    if (!scopeMatches(a.media, medium) || !scopeMatches(a.region, region)) continue;
    if (!isValidDate(a.valid_from) || !isValidDate(a.valid_to) || a.valid_from > a.valid_to) continue;
    // s 需满足：domainFrom ≤ s ≤ domainTo、valid_from ≤ s、s+(D-1) ≤ valid_to
    const lo = domainFrom < a.valid_from ? a.valid_from : domainFrom;
    const authStartHi = addDays(a.valid_to, -(durationDays - 1));
    const hi = domainTo < authStartHi ? domainTo : authStartHi;
    if (lo <= hi) ranges.push([lo, hi]);
  }
  return mergeRanges(ranges);
}

function buildSchedule(db, { pkg, items, medium, region, windowFrom, windowTo }) {
  const durationDays = diffDays(pkg.use_from, pkg.use_to) + 1; // 展期含首尾
  const windowDays = diffDays(windowFrom, windowTo) + 1;
  // 展期完整落在窗口内 ⇔ 起始日 s ∈ [windowFrom, windowTo-(D-1)]
  const candidateFrom = windowFrom;
  const candidateTo = addDays(windowTo, -(durationDays - 1));
  const windowTooShort = candidateFrom > candidateTo;

  const { nodeIds, matById } = collectNodeSet(db, items);
  const rootSet = new Set(items);

  const domainFrom = windowTooShort ? null : candidateFrom;
  const domainTo = windowTooShort ? null : candidateTo;

  let combined = windowTooShort
    ? []
    : [[candidateFrom, candidateTo]];
  const nodes = [];
  for (const id of nodeIds) {
    const ranges = windowTooShort
      ? []
      : feasibleStartsForNode(db, id, {
          medium,
          region,
          durationDays,
          domainFrom,
          domainTo,
        });
    combined = intersectRanges(combined, ranges);
    const m = matById.get(id);
    nodes.push({
      materialId: id,
      title: m ? m.title : `#${id}（已删除）`,
      kind: m ? m.kind : null,
      isRoot: rootSet.has(id),
      blocking: !windowTooShort && ranges.length === 0,
      ranges: toRangeDTO(ranges),
    });
  }

  const feasible = combined.length > 0;
  return {
    packageId: pkg.id,
    packageName: pkg.name,
    medium,
    region,
    currentUseFrom: pkg.use_from,
    currentUseTo: pkg.use_to,
    durationDays,
    windowFrom,
    windowTo,
    windowDays,
    candidateFrom: windowTooShort ? null : candidateFrom,
    candidateTo: windowTooShort ? null : candidateTo,
    windowTooShort,
    feasible,
    basisVersion: basisVersion(db),
    packageFingerprint: computeFingerprint(pkg, items),
    ranges: feasible
      ? combined.map(([from, to]) => ({
          startFrom: from,
          startTo: to,
          days: diffDays(from, to) + 1,
          earliestUseFrom: from,
          earliestUseTo: addDays(from, durationDays - 1),
        }))
      : [],
    blockedBy: feasible
      ? []
      : nodes.filter((n) => n.blocking).map((n) => n.materialId),
    nodes,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 档期搜索（只读）。
 * body: { packageId, windowFrom, windowTo }
 */
function searchSchedules(db, rawBody) {
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
  const packageId = Number(body.packageId);
  if (!Number.isInteger(packageId) || packageId <= 0) {
    throw new ScheduleError(400, '缺少合法的 packageId', { code: 'INVALID_PACKAGE' });
  }
  const win = parseWindow(body, { required: true });

  const run = db.transaction(() => {
    const ctx = loadDraftPackage(db, packageId, 'search');
    return buildSchedule(db, { ...ctx, windowFrom: win.windowFrom, windowTo: win.windowTo });
  });
  return run();
}

/**
 * 应用选定档期到待发布包（事务内重验，任何不符均拒绝且不改包）。
 * body: { packageId, start, basisVersion, packageFingerprint, windowFrom?, windowTo? }
 */
function applySchedule(db, rawBody) {
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
  const packageId = Number(body.packageId);
  if (!Number.isInteger(packageId) || packageId <= 0) {
    throw new ScheduleError(400, '缺少合法的 packageId', { code: 'INVALID_PACKAGE' });
  }
  const start = str(body.start).trim();
  if (!isValidDate(start)) {
    throw new ScheduleError(400, `选定起始日不合法：${start || '（空）'}（需为 YYYY-MM-DD）`, {
      code: 'INVALID_START',
      start: start || null,
    });
  }
  if (body.basisVersion === undefined || body.basisVersion === null) {
    throw new ScheduleError(400, '缺少搜索依据版本 basisVersion，请先搜索档期', { code: 'MISSING_BASIS' });
  }
  const clientBasis = Number(body.basisVersion);
  if (!Number.isInteger(clientBasis)) {
    throw new ScheduleError(400, 'basisVersion 必须为整数', { code: 'MISSING_BASIS' });
  }
  const clientFingerprint = str(body.packageFingerprint).trim();
  if (!clientFingerprint) {
    throw new ScheduleError(400, '缺少包参数/清单指纹 packageFingerprint，请先搜索档期', {
      code: 'MISSING_FINGERPRINT',
    });
  }
  // 规划窗口可选回传：回传则重验选定档期仍完整落在原窗口内
  const win = parseWindow(body, { required: false });

  const run = db.transaction(() => {
    // 1) 状态：仅待发布包可改期（已发布 / 需复核一律拒绝）
    const ctx = loadDraftPackage(db, packageId, 'apply');
    const { pkg, items, medium, region } = ctx;

    // 2) 授权或来源关系是否在搜索后发生变化
    const currentBasis = basisVersion(db);
    if (clientBasis !== currentBasis) {
      throw new ScheduleError(
        409,
        `搜索依据已过期：搜索时版本 ${clientBasis}，当前版本 ${currentBasis}，授权或来源关系在此期间被修改。请重新搜索档期后再应用。`,
        { code: 'STALE_BASIS', clientBasis, currentBasis }
      );
    }

    // 3) 包参数或清单是否在搜索后被修改
    const currentFingerprint = computeFingerprint(pkg, items);
    if (clientFingerprint !== currentFingerprint) {
      throw new ScheduleError(
        409,
        '搜索后展览包参数或素材清单已变化，拒绝应用旧档期（包未改动）。请重新搜索档期后再应用。',
        {
          code: 'PACKAGE_CHANGED',
          clientFingerprint,
          currentFingerprint,
        }
      );
    }

    // 4) 按当前数据重算选定档期
    const durationDays = diffDays(pkg.use_from, pkg.use_to) + 1;
    const useFrom = start;
    const useTo = addDays(start, durationDays - 1);

    if (win) {
      const candidateTo = addDays(win.windowTo, -(durationDays - 1));
      if (start < win.windowFrom || start > candidateTo) {
        throw new ScheduleError(
          409,
          `选定起始日 ${start} 的展期（${useFrom} → ${useTo}）未完整落在规划窗口 ${win.windowFrom} → ${win.windowTo} 内，档期已失效；请重新搜索。`,
          {
            code: 'SLOT_INVALID',
            reason: 'out_of_window',
            start,
            useFrom,
            useTo,
            windowFrom: win.windowFrom,
            windowTo: win.windowTo,
            candidateFrom: win.windowFrom,
            candidateTo,
          }
        );
      }
    }

    // 结构性问题（成环/截断/超深）在重算时同样拦截
    collectNodeSet(db, items);

    const result = verifyPackage(db, {
      materialIds: items,
      medium,
      region,
      useFrom,
      useTo,
    });
    if (!result.eligible) {
      throw new ScheduleError(
        409,
        `选定起始日 ${start}（展期 ${useFrom} → ${useTo}）当前已不满足全部节点的授权覆盖要求，档期失效；包未改动。请重新搜索档期。`,
        {
          code: 'SLOT_INVALID',
          reason: 'not_eligible',
          start,
          useFrom,
          useTo,
          failingNodes: result.failingNodes,
          globalErrors: result.globalErrors,
        }
      );
    }

    // 5) 全部通过：仅更新待发布包起止日（不触碰授权/来源，依据版本不变）
    db.prepare('UPDATE packages SET use_from=?, use_to=?, updated_at=? WHERE id=?')
      .run(useFrom, useTo, nowIso(), packageId);
    const updated = db.prepare('SELECT * FROM packages WHERE id=?').get(packageId);

    return {
      packageId,
      applied: { useFrom, useTo, durationDays },
      basisVersion: currentBasis,
      packageFingerprint: computeFingerprint(updated, items),
      pkg: updated,
      result,
    };
  });

  return run();
}

module.exports = {
  ScheduleError,
  searchSchedules,
  applySchedule,
  // 导出供测试
  computeFingerprint,
  mergeRanges,
  intersectRanges,
  addDays,
  diffDays,
};
