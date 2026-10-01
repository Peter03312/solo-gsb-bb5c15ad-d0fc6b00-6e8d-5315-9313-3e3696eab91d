'use strict';

// 端到端业务规则测试（针对运行中的 http://localhost:3000）
const BASE = process.env.BASE || 'http://localhost:3000';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FAIL:', msg); }
}
async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

(async () => {
  console.log('1) 成环检测');
  {
    // 演示数据: 1 film -> 2 music, 3 footage, 4 font ; footage(3) -> 5 photo
    // 尝试给 music(2) 加来源 film(1)：1->2->1 成环
    const r = await call('POST', '/api/materials/2/sources', { sourceMaterialId: 1, relation: 'x' });
    ok(r.status === 409 && r.data.details && r.data.details.cyclePath.join() === '1,2',
      '加边 2->1 被拒且返回成环路径 [1,2]，实际: ' + r.status + ' ' + JSON.stringify(r.data.details));
    // 自环
    const r2 = await call('POST', '/api/materials/1/sources', { sourceMaterialId: 1 });
    ok(r2.status === 400, '自环被拒绝');
    // 合法加边
    const r3 = await call('POST', '/api/materials/5/sources', { sourceMaterialId: 4, relation: '字体' });
    ok(r3.status === 201, '合法边 5->4 添加成功（photo 也用到字体）');
  }

  console.log('2) 不合格包：缺授权节点 + 来源路径列出');
  {
    // 创建含 film(1) 的秋季包：photo(5)/font(4) 只有春季授权，使用期不覆盖
    const r = await call('POST', '/api/packages', {
      name: '测试不合格包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-10-01', useTo: '2026-11-30', materialIds: [1],
    });
    ok(r.status === 201, '包已创建为 draft');
    const pid = r.data.id;
    const v = await call('POST', '/api/verify', { packageId: pid });
    ok(v.status === 200 && v.data.eligible === false, '核验不合格');
    const photo = v.data.failingNodes.find((n) => n.materialId === 5);
    ok(!!photo, '列出不合格节点 photo(5)');
    ok(photo.paths.some((p) => p.map((x) => x.materialId).join() === '1,3,5'),
      '给出不合格来源路径 1->3->5');
    ok(photo.reasonText.join().includes('有效期'), '原因：授权有效期不覆盖（照片仅有春季授权）');
    // 字体在秋季也不覆盖
    const fontNode = v.data.failingNodes.find((n) => n.materialId === 4);
    ok(!!fontNode && fontNode.reasonText.join().includes('有效期'), '字体节点同样因有效期不合格');
    global.pidBad = pid;
  }

  console.log('2b) 完全无授权的独立节点 -> no_auth');
  {
    const m = await call('POST', '/api/materials', { title: '孤立未授权素材', kind: 'image' });
    ok(m.status === 201, '创建无授权素材');
    const p = await call('POST', '/api/packages', {
      name: '无授权包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-10-01', useTo: '2026-11-30', materialIds: [m.data.id],
    });
    const v = await call('POST', '/api/verify', { packageId: p.data.id });
    ok(v.data.eligible === false &&
      v.data.failingNodes[0].reasons.includes('no_auth') &&
      v.data.failingNodes[0].reasonText.join().includes('未登记任何授权'),
      '无授权节点报 no_auth 并列出根路径');
  }

  console.log('3) 日期不合法 / 缺字段 -> 400 或核验 globalErrors，禁止发布');
  {
    const r = await call('POST', '/api/packages', {
      name: '坏日期', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-12-01', useTo: '2026-11-01', materialIds: [1],
    });
    ok(r.status === 400, '起>止日期在保存时被拒（400）');
    const r2 = await call('POST', '/api/packages', {
      name: '坏格式', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-02-30', useTo: '2026-11-01', materialIds: [1],
    });
    ok(r2.status === 400, '非法日历日期 2026-02-30 被拒');
    // 直接核验缺媒介
    const v = await call('POST', '/api/verify', { materialIds: [1], medium: '', region: '中国大陆', useFrom: '2026-10-01', useTo: '2026-11-30' });
    ok(v.data.eligible === false && v.data.globalErrors.some((e) => e.includes('媒介')), '缺媒介导致不可发布');
    // 发布不合格包 -> 422
    const state = await call('GET', '/api/state');
    const pub = await call('POST', `/api/packages/${global.pidBad}/publish`, { basisVersion: state.data.basisVersion });
    ok(pub.status === 422, '发布不合格包被拒 422');
    const after = await call('GET', `/api/packages/${global.pidBad}`);
    ok(after.data.status === 'draft', '包仍为 draft（未被发布）');
    const snaps = after.data.snapshots;
    ok(snaps.length === 1 && snaps[0].kind === 'publish' && snaps[0].eligible === false,
      '失败发布也留下不可变核验记录');
  }

  console.log('4) 合格包发布 + 原子快照 + 清单冻结');
  {
    // 演示数据里的已发布包 1（常设展）；另建一个全新的可发布包：film 链需在 03-01~05-31 全合格
    // font(4) 授权 2026-03-01~2026-05-31 恰好覆盖；步骤1加了 5->4 边但只含 font 自身时不受影响
    const r = await call('POST', '/api/packages', {
      name: '测试合格包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-03-01', useTo: '2026-05-31', materialIds: [4],
    });
    const pid = r.data.id;
    const v = await call('POST', '/api/verify', { packageId: pid });
    ok(v.data.eligible === true, '只含 font(4) 的包核验合格');
    const pub = await call('POST', `/api/packages/${pid}/publish`, { basisVersion: v.data.basisVersion });
    ok(pub.status === 201 && pub.data.package.status === 'published', '发布成功 201');
    ok(pub.data.snapshotId && pub.data.result.eligible, '返回不可变快照 id');
    // 发布后不可改
    const patch = await call('PATCH', `/api/packages/${pid}`, {
      name: 'x', medium: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-05-31', materialIds: [4],
    });
    ok(patch.status === 409, '已发布包参数/清单不可修改');
    // 快照内容核对
    const snap = await call('GET', `/api/snapshots/${pub.data.snapshotId}`);
    ok(snap.data.immutable && snap.data.payload.nodes.length === 1 && snap.data.payload.request.materialIds.join() === '4',
      '快照冻结素材清单与逐节点结果');
    global.pidGood = pid;
    global.goodSnap = pub.data.snapshotId;
  }

  console.log('5) 快照不可变（SQLite 触发器）');
  {
    const Database = require('better-sqlite3');
    const db = new Database(process.env.DB_PATH || '/workspace/data/app.db');
    let blockedUpdate = false, blockedDelete = false;
    try { db.prepare('UPDATE verification_snapshots SET eligible=0 WHERE id=?').run(global.goodSnap); }
    catch { blockedUpdate = true; }
    try { db.prepare('DELETE FROM verification_snapshots WHERE id=?').run(global.goodSnap); }
    catch { blockedDelete = true; }
    ok(blockedUpdate && blockedDelete, '快照 UPDATE/DELETE 均被触发器拒绝');
    db.close();
  }

  console.log('6) 依据过期（核验后授权/来源被改）-> 发布 409 STALE_BASIS');
  {
    // 新待发布合格包
    const r = await call('POST', '/api/packages', {
      name: '并发包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-03-02', useTo: '2026-05-01', materialIds: [4],
    });
    const pid = r.data.id;
    const v1 = await call('POST', '/api/verify', { packageId: pid });
    ok(v1.data.eligible === true, '核验合格，拿到 basisVersion=' + v1.data.basisVersion);
    // 期间他人改了授权（给 font 增加一条无关授权，版本号也会递增）
    const add = await call('POST', '/api/materials/4/authorizations', {
      media: '网络', region: '中国大陆', validFrom: '2030-01-01', validTo: '2030-12-31', licensor: 'x',
    });
    ok(add.status === 201, '并发：新增了一条授权');
    const pub = await call('POST', `/api/packages/${pid}/publish`, { basisVersion: v1.data.basisVersion });
    ok(pub.status === 409 && pub.data.details.code === 'STALE_BASIS', '依据过期发布被拒 409 STALE_BASIS');
    const v2 = await call('POST', '/api/verify', { packageId: pid });
    const pub2 = await call('POST', `/api/packages/${pid}/publish`, { basisVersion: v2.data.basisVersion });
    ok(pub2.status === 201, '重新核验后发布成功');
    global.pidConcurrent = pid;
  }

  console.log('7) 授权撤销 -> 仅“由合格变不合格”的已发布包标 needs_review，原快照保留');
  {
    const before = (await call('GET', `/api/packages/${global.pidGood}`)).data;
    ok(before.status === 'published', '前置：合格包处于 published');
    // font 授权只有一条主授权（id 从数据查）；撤销它
    const mats = (await call('GET', '/api/materials')).data;
    const fontAuth = mats.find((m) => m.id === 4).authorizations.filter((a) => !a.revoked && a.media !== '网络');
    const target = fontAuth.find((a) => a.validFrom === '2026-03-01');
    const rev = await call('POST', `/api/authorizations/${target.id}/revoke`);
    ok(rev.status === 200, '授权已撤销');
    const after = (await call('GET', `/api/packages/${global.pidGood}`)).data;
    ok(after.status === 'needs_review', '原合格包被标记为 needs_review');
    const publishSnapStillThere = after.snapshots.some((s) => s.id === global.goodSnap && s.kind === 'publish' && s.eligible === true);
    ok(publishSnapStillThere, '原发布快照原样保留（合格、未被改写）');
    ok(after.latestSnapshot.kind === 'review' && after.latestSnapshot.eligible === false,
      '自动追加了 review 不合格快照');
    // 演示数据里的已发布“常设展”包（含 film，font 在其链上）也应被标记
    const pkgList = (await call('GET', '/api/packages')).data;
    const demo = pkgList.find((p) => p.name.includes('常设展'));
    ok(demo.status === 'needs_review', '演示已发布包同样被标记需复核');

    // 已经 needs_review 的包，再改一次授权（仍不合格）不应产生重复状态翻转之外问题；
    // 且“合格→仍不合格”规则：review 包不会自动恢复
    global.reviewPid = global.pidGood;
  }

  console.log('8) 人工复核：恢复授权后重新核验 -> 恢复 published，所有历史快照保留');
  {
    // 重新登记一条覆盖授权（不能解撤，模拟补授权）
    const add = await call('POST', '/api/materials/4/authorizations', {
      media: '*', region: '*', validFrom: '2026-01-01', validTo: '2028-12-31', licensor: '补授权',
    });
    ok(add.status === 201, '补登记覆盖授权');
    // needs_review 不会自动恢复
    const still = (await call('GET', `/api/packages/${global.reviewPid}`)).data;
    ok(still.status === 'needs_review', '不会自动恢复发布状态');
    const rc = await call('POST', `/api/packages/${global.reviewPid}/recheck`);
    ok(rc.status === 200 && rc.data.restored === true && rc.data.package.status === 'published',
      '人工复核通过，恢复 published');
    const final = (await call('GET', `/api/packages/${global.reviewPid}`)).data;
    const kinds = final.snapshots.map((s) => s.kind).join(',');
    ok(kinds.includes('publish') && kinds.includes('review') && kinds.includes('recheck'),
      '三类快照按时间顺序全部保留: ' + kinds);
  }

  console.log('9) 媒介/地区通配符与有效期边界');
  {
    // music(2) 授权 * / * 2026-01-01~2027-12-31
    const r = await call('POST', '/api/packages', {
      name: '边界包', medium: '沉浸式投影', region: '中国香港',
      useFrom: '2026-01-01', useTo: '2027-12-31', materialIds: [2],
    });
    const v = await call('POST', '/api/verify', { packageId: r.data.id });
    ok(v.data.eligible === true, '* / * 授权覆盖任意媒介地区，起止日按闭区间边界合格');
    const v2 = await call('POST', '/api/verify', {
      materialIds: [2], medium: '沉浸式投影', region: '中国香港',
      useFrom: '2025-12-31', useTo: '2027-12-31',
    });
    ok(v2.data.eligible === false && v2.data.failingNodes[0].reasonText.join().includes('有效期'),
      '早一天即不覆盖整段使用期');
  }

  console.log('10) 变更影响预演 + 确认提交（先预演后提交，事务内校验）');
  {
    // 自建一套干净数据：root -> src 两节点，各自恰好一份覆盖授权，发布一个合格包
    const m1 = (await call('POST', '/api/materials', { title: '预演-成片', kind: 'video' })).data.id;
    const m2 = (await call('POST', '/api/materials', { title: '预演-来源', kind: 'audio' })).data.id;
    const m3 = (await call('POST', '/api/materials', { title: '预演-无授权素材', kind: 'image' })).data.id;
    await call('POST', `/api/materials/${m1}/sources`, { sourceMaterialId: m2, relation: '配乐' });
    await call('POST', `/api/materials/${m1}/authorizations`, {
      media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', licensor: 'r',
    });
    const aSrc = (await call('POST', `/api/materials/${m2}/authorizations`, {
      media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', licensor: 's',
    })).data.id;
    const pkg = (await call('POST', '/api/packages', {
      name: '预演测试包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-03-01', useTo: '2026-04-30', materialIds: [m1],
    })).data.id;
    const v0 = await call('POST', '/api/verify', { packageId: pkg });
    const pub0 = await call('POST', `/api/packages/${pkg}/publish`, { basisVersion: v0.data.basisVersion });
    ok(pub0.status === 201, '前置：预演测试包已发布');
    const basis0 = pub0.data.result.basisVersion;
    global.previewPkg = pkg; global.previewAuth = aSrc; global.previewRoot = m1;
    global.previewNoAuth = m3; global.previewSrc = m2;

    // 10.1 预演撤销来源授权：列出该已发布包 + 问题节点 m2 + revoked 原因与来源路径
    const pv = await call('POST', '/api/changes/preview', { operation: 'authorization.revoke', authorizationId: aSrc });
    ok(pv.status === 200, '预演返回 200');
    ok(pv.data.mutated === false && pv.data.basisVersion === basis0, '预演返回依据版本且声明未落库');
    const hit = pv.data.impact.find((p) => p.packageId === pkg);
    ok(!!hit, '预演影响清单含该已发布包');
    const badNode = hit && hit.failingNodes.find((n) => n.materialId === m2);
    ok(!!badNode && badNode.reasons.includes('revoked'), '问题节点为来源 m2，原因为授权均已撤销');
    ok(badNode.paths.some((p) => p.map((x) => x.materialId).join() === `${m1},${m2}`),
      '给出问题节点来源路径 root->src');
    ok(typeof pv.data.impactFingerprint === 'string' && pv.data.impactFingerprint.length > 0, '返回影响清单指纹');

    // 10.2 预演不落库：包仍 published、快照仍只有发布快照、授权未撤销、版本不变
    const st1 = await call('GET', `/api/packages/${pkg}`);
    ok(st1.data.status === 'published' && st1.data.snapshots.length === 1, '预演后包仍已发布且无新增快照');
    const mats1 = await call('GET', '/api/materials');
    const stillActive = mats1.data.find((x) => x.id === m2).authorizations.find((a) => a.id === aSrc && !a.revoked);
    ok(!!stillActive, '预演后授权仍未撤销');
    const ver1 = (await call('GET', '/api/state')).data.basisVersion;
    ok(ver1 === basis0, '预演后依据版本不变');

    // 10.3 依据版本不一致 -> 409 STALE_BASIS，无写入
    const stale = await call('POST', '/api/changes/commit', {
      operation: 'authorization.revoke', authorizationId: aSrc, basisVersion: basis0 - 1, impact: pv.data.impact,
    });
    ok(stale.status === 409 && stale.data.details.code === 'STALE_BASIS', '旧依据版本确认被拒 409 STALE_BASIS');
    ok((await call('GET', `/api/packages/${pkg}`)).data.status === 'published', 'STALE 拒绝后无部分写入');

    // 10.4 影响清单不一致（提交空清单）-> 409 IMPACT_MISMATCH，无写入
    const mismatch = await call('POST', '/api/changes/commit', {
      operation: 'authorization.revoke', authorizationId: aSrc, basisVersion: basis0, impact: [],
    });
    ok(mismatch.status === 409 && mismatch.data.details.code === 'IMPACT_MISMATCH', '影响清单不符被拒 409 IMPACT_MISMATCH');
    ok(Array.isArray(mismatch.data.details.impact) && mismatch.data.details.impact.some((p) => p.packageId === pkg),
      '拒绝时返回服务端重算的最新影响清单');
    ok((await call('GET', `/api/packages/${pkg}`)).data.status === 'published', 'MISMATCH 拒绝后无部分写入');

    // 10.5 正确确认：执行变更 + 标需复核 + 追加不可变 review 快照，原发布快照保留
    const commit = await call('POST', '/api/changes/commit', {
      operation: 'authorization.revoke', authorizationId: aSrc, basisVersion: basis0, impact: pv.data.impact,
    });
    ok(commit.status === 200 && commit.data.mutated === true, '携带同一操作与预演结果确认成功');
    ok(commit.data.basisVersion === basis0 + 1, '提交后依据版本 +1');
    const st2 = await call('GET', `/api/packages/${pkg}`);
    ok(st2.data.status === 'needs_review', '受影响包标记为 needs_review');
    ok(st2.data.snapshots.length === 2 &&
       st2.data.snapshots[0].kind === 'publish' && st2.data.snapshots[0].eligible === true &&
       st2.data.snapshots[1].kind === 'review' && st2.data.snapshots[1].eligible === false,
      '原发布快照保留，并追加不合格 review 快照');

    // 10.6 需复核包不自动恢复（即便预演显示已合格），且预演只统计“已发布合格”包
    await call('POST', `/api/materials/${m2}/authorizations`, {
      media: '*', region: '*', validFrom: '2020-01-01', validTo: '2031-12-31', licensor: '补',
    });
    const st3 = await call('GET', `/api/packages/${pkg}`);
    ok(st3.data.status === 'needs_review', '补正授权后需复核包不自动恢复');

    // 10.7 目标失效：预演删不存在授权 404；确认时目标已被删 409 TARGET_GONE
    const pvGonePreview = await call('POST', '/api/changes/preview', { operation: 'authorization.delete', authorizationId: 999999 });
    ok(pvGonePreview.status === 404, '预演不存在的目标返回 404');

    // 10.8 成环拒绝（预演阶段即拒绝，沿用既有成环校验与路径）
    const cyc = await call('POST', '/api/changes/preview', { operation: 'source.create', materialId: m2, sourceMaterialId: m1 });
    ok(cyc.status === 409 && cyc.data.details.code === 'CYCLE' &&
       cyc.data.details.cycle.join() === `${m2},${m1},${m2}`,
      '成环关系在预演时即被拒绝并返回完整闭环');

    // 10.9 输入非法 -> 400（字段/校验沿用既有接口：空媒介、起止倒置）
    const bad1 = await call('POST', '/api/changes/preview', {
      operation: 'authorization.create', materialId: m1, media: '', region: 'CN',
      validFrom: '2026-01-01', validTo: '2026-12-31',
    });
    const bad2 = await call('POST', '/api/changes/preview', {
      operation: 'authorization.update', authorizationId: aSrc, media: '*', region: '*',
      validFrom: '2026-12-31', validTo: '2026-01-01',
    });
    const bad3 = await call('POST', '/api/changes/preview', { operation: 'source.create', materialId: m1, sourceMaterialId: m1 });
    ok(bad1.status === 400 && bad2.status === 400 && bad3.status === 400,
      '空媒介 / 起止倒置 / 自环均按既有校验返回 400');

    // 10.10 来源关系新增：预演 -> 确认，包由合格转不合格（挂入无授权素材）
    // 先人工复核恢复包（补过授权），使其回到 published
    const rc = await call('POST', `/api/packages/${pkg}/recheck`);
    ok(rc.data.restored === true, '前置：人工复核恢复为已发布');
    const basisBeforeLink = (await call('GET', '/api/state')).data.basisVersion;
    const pvLink = await call('POST', '/api/changes/preview', {
      operation: 'source.create', materialId: m1, sourceMaterialId: m3, relation: '引用',
    });
    ok(pvLink.status === 200 && pvLink.data.impact.some((p) =>
      p.packageId === pkg && p.failingNodes.some((n) => n.materialId === m3 && n.reasons.includes('no_auth'))),
      '预演新增到无授权素材的边：包将因 m3 无授权不合格');
    const commitLink = await call('POST', '/api/changes/commit', {
      operation: 'source.create', materialId: m1, sourceMaterialId: m3, relation: '引用',
      basisVersion: basisBeforeLink, impact: pvLink.data.impact,
    });
    ok(commitLink.status === 200, '来源新增确认成功');
    ok((await call('GET', `/api/packages/${pkg}`)).data.status === 'needs_review',
      '挂入无授权来源后包被标记需复核');

    // 10.11 来源关系删除：删除该坏边预演影响为 0（删除来源不会使已发布合格包变坏），确认后恢复原链
    const linkId = (await call('GET', `/api/materials/${m1}`)).data.sources.find((s) => s.sourceMaterialId === m3).id;
    const pvDelLink = await call('POST', '/api/changes/preview', { operation: 'source.delete', linkId });
    ok(pvDelLink.status === 200 && pvDelLink.data.impact.length === 0, '删除坏来源边预演影响为 0');
    const commitDelLink = await call('POST', '/api/changes/commit', {
      operation: 'source.delete', linkId, basisVersion: pvDelLink.data.basisVersion, impact: [],
    });
    ok(commitDelLink.status === 200, '来源删除确认成功（无包转不合格）');
    const sourcesAfter = (await call('GET', `/api/materials/${m1}`)).data.sources;
    ok(!sourcesAfter.some((s) => s.sourceMaterialId === m3), '坏来源边已删除');
    // 10.12 再次预演同操作：目标（边）已失效 -> 404
    const pvGoneLink = await call('POST', '/api/changes/preview', { operation: 'source.delete', linkId });
    ok(pvGoneLink.status === 404, '删除后再预演同一条边返回 404 目标失效');

    // 10.13 既有编辑接口请求/返回保持兼容（直接 PATCH/DELETE 不经预演仍可用）
    const patch = await call('PATCH', `/api/authorizations/${aSrc}`, { region: '中国香港' });
    ok(patch.status === 200 && patch.data.region === '中国香港' && patch.data.id === aSrc,
      '既有 PATCH /api/authorizations/:id 兼容可用');
  }

  console.log('11) 档期规划：可行起始日搜索（展期天数含首尾、整窗覆盖、单份授权不拼接）');
  {
    // 独立链：sRoot -> sSrc，展期固定 7 天（含首尾）
    const m1 = (await call('POST', '/api/materials', { title: '档期-成片', kind: 'video' })).data.id;
    const m2 = (await call('POST', '/api/materials', { title: '档期-来源', kind: 'audio' })).data.id;
    await call('POST', `/api/materials/${m1}/sources`, { sourceMaterialId: m2, relation: '配乐' });
    // root：07-01~08-15 覆盖 -> 起始日可行区间 [07-01, 08-09]
    await call('POST', `/api/materials/${m1}/authorizations`, {
      media: '屏幕放映', region: '中国大陆', validFrom: '2026-07-01', validTo: '2026-08-15', licensor: 'r',
    });
    // source：07-10~08-31 -> [07-10, 08-25]；交集应为 [07-10, 08-09]
    await call('POST', `/api/materials/${m2}/authorizations`, {
      media: '屏幕放映', region: '中国大陆', validFrom: '2026-07-10', validTo: '2026-08-31', licensor: 's',
    });
    // source 另有一份仅 5 天的短授权（09-01~09-05），展期 7 天，不能与任何授权拼接
    await call('POST', `/api/materials/${m2}/authorizations`, {
      media: '屏幕放映', region: '中国大陆', validFrom: '2026-09-01', validTo: '2026-09-05', licensor: 'short',
    });
    const pid = (await call('POST', '/api/packages', {
      name: '档期规划包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-07-10', useTo: '2026-07-16', materialIds: [m1],
    })).data.id;
    global.schedPid = pid; global.schedRoot = m1; global.schedSrc = m2;

    const sr = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-06-01', planTo: '2026-09-30' });
    ok(sr.status === 200 && sr.data.feasible === true, '档期搜索 200 且有结果');
    ok(sr.data.durationDays === 7, '展期天数按当前展期（含首尾）= 7');
    ok(sr.data.ranges.length === 1 &&
       sr.data.ranges[0].startFrom === '2026-07-10' && sr.data.ranges[0].startTo === '2026-08-09',
      '两节点可行起始日取交集并合并为一段 07-10 → 08-09，实际: ' + JSON.stringify(sr.data.ranges));
    ok(sr.data.ranges[0].dayCount === 31, '该段含 31 个连续可行起始日');
    ok(sr.data.ranges[0].earliestExhibitionFrom === '2026-07-10' &&
       sr.data.ranges[0].earliestExhibitionTo === '2026-07-16',
      '列出最早展期 07-10 → 07-16');
    ok(sr.data.restrictedNodes.length === 0, '有结果时不列受限节点');
    ok(sr.data.searchToken && sr.data.searchToken.basisVersion === sr.data.basisVersion &&
       sr.data.searchToken.durationDays === 7,
      '返回含依据版本与天数的搜索令牌');

    // 展期完整落在窗口内：06-01 虽在窗口内但 root 授权 07-01 才开始 -> 不属于可行段
    const sr2 = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-08-01', planTo: '2026-08-07' });
    ok(sr2.data.ranges.length === 1 && sr2.data.ranges[0].startFrom === '2026-08-01' && sr2.data.ranges[0].startTo === '2026-08-01',
      '窗口仅放得下一天起始日（展期止恰好窗口止）时返回单日段');

    // 窗口短于展期
    const short = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-09-01', planTo: '2026-09-03' });
    ok(short.status === 200 && short.data.feasible === false && short.data.windowTooShort === true,
      '窗口不足展期天数：无结果且标记 windowTooShort');

    // 9 月窗口：root 无覆盖；source 虽有短授权但不足 7 天，不能拼接 -> 无结果，列受限节点
    const sept = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-09-01', planTo: '2026-09-30' });
    ok(sept.data.feasible === false, '9 月窗口无可行起始日（短授权不可拼接）');
    const septIds = sept.data.restrictedNodes.map((n) => n.materialId).sort();
    ok(septIds.join() === `${m1},${m2}`, '无结果时列出全部受限节点（root + source）');
    const septSrc = sept.data.restrictedNodes.find((n) => n.materialId === m2);
    ok(septSrc.reason === 'date' && septSrc.ranges.length === 0,
      'source 的 5 天短授权折算为空区间，原因 date（不跨授权拼接）');
    const septRoot = sept.data.restrictedNodes.find((n) => n.materialId === m1);
    ok(septRoot.reason === 'date' && septRoot.ranges.length === 0, 'root 在窗口内无任何覆盖，区间为空');

    // 非法窗口 / 空包 / 已发布包
    const badWin = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-09-10', planTo: '2026-09-01' });
    ok(badWin.status === 400 && badWin.data.details.code === 'INVALID_WINDOW', '非法窗口（起晚于止）报 400 INVALID_WINDOW');
    const badFmt = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-02-30', planTo: '2026-09-01' });
    ok(badFmt.status === 400, '非法日历日期报 400');
    const emptyPkg = (await call('POST', '/api/packages', {
      name: '档期空包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-07-10', useTo: '2026-07-16', materialIds: [],
    })).data.id;
    const emptySr = await call('POST', `/api/packages/${emptyPkg}/schedule/search`, { planFrom: '2026-09-01', planTo: '2026-09-30' });
    ok(emptySr.status === 400 && emptySr.data.details.code === 'EMPTY_PACKAGE', '空包搜索档期报 400 EMPTY_PACKAGE');
    const pubPkg = (await call('GET', '/api/packages')).data.find((p) => p.name.includes('预演测试包'))
      || (await call('GET', '/api/packages')).data.find((p) => p.status === 'published');
    if (pubPkg) {
      const pubSr = await call('POST', `/api/packages/${pubPkg.id}/schedule/search`, { planFrom: '2026-01-01', planTo: '2026-12-31' });
      ok(pubSr.status === 409 && pubSr.data.details.code === 'NOT_DRAFT', '已发布/需复核包不可搜索档期');
    }
  }

  console.log('12) 档期应用：事务内重验（依据/清单参数/状态/档期失效），拒绝不改包');
  {
    const pid = global.schedPid, m1 = global.schedRoot, m2 = global.schedSrc;
    const before = await call('GET', `/api/packages/${pid}`);
    ok(before.data.useFrom === '2026-07-10' && before.data.useTo === '2026-07-16', '前置：包仍为原档期');

    // 正常应用交集边界起始日 08-09（展期 08-09 → 08-15）
    const sr = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-06-01', planTo: '2026-09-30' });
    const token = sr.data.searchToken;
    const ap = await call('POST', `/api/packages/${pid}/schedule/apply`, { useFrom: '2026-08-09', searchToken: token });
    ok(ap.status === 200 && ap.data.useFrom === '2026-08-09' && ap.data.useTo === '2026-08-15' && ap.data.durationDays === 7,
      '选定起始日应用成功，展期天数保持 7 天（含首尾）');
    const after = await call('GET', `/api/packages/${pid}`);
    ok(after.data.status === 'draft', '改期后包仍为待发布（不发布、不写快照）');
    ok(after.data.itemCount === 1 && after.data.items[0].id === m1, '改期不改变素材清单');

    // 同一令牌重复使用：包参数（展期）已变 -> PACKAGE_CHANGED
    const reuse = await call('POST', `/api/packages/${pid}/schedule/apply`, { useFrom: '2026-08-08', searchToken: token });
    ok(reuse.status === 409 && reuse.data.details.code === 'PACKAGE_CHANGED', '令牌一次性：改期后旧令牌被拒 PACKAGE_CHANGED');

    // STALE_BASIS：搜索后授权变更
    const sr2 = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-06-01', planTo: '2026-09-30' });
    await call('POST', `/api/materials/${m1}/authorizations`, {
      media: '网络', region: '中国大陆', validFrom: '2030-01-01', validTo: '2030-12-31', licensor: 'x',
    });
    const stale = await call('POST', `/api/packages/${pid}/schedule/apply`, { useFrom: '2026-08-01', searchToken: sr2.data.searchToken });
    ok(stale.status === 409 && stale.data.details.code === 'STALE_BASIS', '搜索后授权变更 -> 409 STALE_BASIS');
    const unchangedAfterStale = await call('GET', `/api/packages/${pid}`);
    ok(unchangedAfterStale.data.useFrom === '2026-08-09', 'STALE 拒绝后包档期不变');

    // PACKAGE_CHANGED：搜索后改清单
    const sr3 = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-06-01', planTo: '2026-09-30' });
    await call('PATCH', `/api/packages/${pid}`, {
      name: '档期规划包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-08-09', useTo: '2026-08-15', materialIds: [m1, m2],
    });
    const changed = await call('POST', `/api/packages/${pid}/schedule/apply`, { useFrom: '2026-08-01', searchToken: sr3.data.searchToken });
    ok(changed.status === 409 && changed.data.details.code === 'PACKAGE_CHANGED', '搜索后清单变更 -> 409 PACKAGE_CHANGED');

    // 恢复清单
    await call('PATCH', `/api/packages/${pid}`, {
      name: '档期规划包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-08-09', useTo: '2026-08-15', materialIds: [m1],
    });

    // SLOT_INVALID：撤销覆盖授权后选定档期失效（令牌依据版本需要未变 -> 用“不改授权”的另一种方式：
    // 直接构造窗口外起始日 / 展期落出窗口）
    const sr4 = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-06-01', planTo: '2026-07-31' });
    const outOfWin = await call('POST', `/api/packages/${pid}/schedule/apply`, { useFrom: '2026-08-01', searchToken: sr4.data.searchToken });
    ok(outOfWin.status === 409 && outOfWin.data.details.code === 'SLOT_INVALID',
      '选定起始日落在搜索窗口之外 -> 409 SLOT_INVALID');

    // 档期失效：搜索后撤销授权（依据版本也变，按 STALE_BASIS 优先拒绝——因此改用“窗口内但授权不覆盖”的真实档期）
    const sr5 = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-06-01', planTo: '2026-09-30' });
    const invalidSlot = await call('POST', `/api/packages/${pid}/schedule/apply`, { useFrom: '2026-09-01', searchToken: sr5.data.searchToken });
    ok(invalidSlot.status === 409 && invalidSlot.data.details.code === 'SLOT_INVALID' &&
       Array.isArray(invalidSlot.data.details.failingNodes) && invalidSlot.data.details.failingNodes.length > 0,
      '选定无授权覆盖的起始日 -> 409 SLOT_INVALID 并附失效节点');

    // 非法选定日期 / 缺令牌
    const badDate = await call('POST', `/api/packages/${pid}/schedule/apply`, { useFrom: 'not-a-date', searchToken: sr5.data.searchToken });
    ok(badDate.status === 400, '选定日期格式非法报 400');
    const noToken = await call('POST', `/api/packages/${pid}/schedule/apply`, { useFrom: '2026-08-01' });
    ok(noToken.status === 400, '缺少搜索令牌报 400');
    const wrongPkg = await call('POST', `/api/packages/${pid}/schedule/apply`, {
      useFrom: '2026-08-01', searchToken: { ...sr5.data.searchToken, packageId: pid + 9999 },
    });
    ok(wrongPkg.status === 409 && wrongPkg.data.details.code === 'TOKEN_MISMATCH', '令牌与目标包不一致 -> 409 TOKEN_MISMATCH');
  }

  console.log('13) 改期后既有核验/发布链路兼容');
  {
    const pid = global.schedPid;
    // 改到一个全链合格的档期并发布
    const sr = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-06-01', planTo: '2026-09-30' });
    const target = sr.data.ranges[0].startFrom;
    await call('POST', `/api/packages/${pid}/schedule/apply`, { useFrom: target, searchToken: sr.data.searchToken });
    const v = await call('POST', '/api/verify', { packageId: pid });
    ok(v.data.eligible === true && v.data.request.useFrom === target, '改期后按新档期核验合格');
    const pub = await call('POST', `/api/packages/${pid}/publish`, { basisVersion: v.data.basisVersion });
    ok(pub.status === 201 && pub.data.package.status === 'published' &&
       pub.data.package.useFrom === target,
      '改期后的待发布包可正常发布，发布快照记录新档期');
    // 已发布包再改期被拒
    const again = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-01-01', planTo: '2026-12-31' });
    ok(again.status === 409 && again.data.details.code === 'NOT_DRAFT', '发布后再搜索档期被拒');
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
