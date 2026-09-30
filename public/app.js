'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = { materials: [], packages: [], basisVersion: 0 };

async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败 ${res.status}`);
    err.status = res.status;
    err.details = data && data.details;
    err.data = data;
    throw err;
  }
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

function errText(e) {
  return e.message + (e.details && e.details.code === 'STALE_BASIS' ? '' : '');
}

// ---------------- 数据加载 ----------------
async function loadState() {
  const [s, mats, pkgs] = await Promise.all([
    api('GET', '/api/state'),
    api('GET', '/api/materials'),
    api('GET', '/api/packages'),
  ]);
  state.materials = mats;
  state.packages = pkgs;
  state.basisVersion = s.basisVersion;
  $('#basisVersion').textContent = s.basisVersion;
  const rb = $('#reviewBadge');
  if (s.reviewCount > 0) { rb.textContent = `需复核：${s.reviewCount}`; rb.classList.remove('hidden'); }
  else rb.classList.add('hidden');
  renderMaterials();
  renderMaterialPick();
  renderPackages();
}

// ---------------- Tabs ----------------
$$('.tab').forEach((btn) => btn.addEventListener('click', () => {
  $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
  $$('.tabpanel').forEach((p) => p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`));
  $$('.tabpanel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${btn.dataset.tab}`));
}));

// ---------------- 素材页 ----------------
function renderMaterials() {
  const box = $('#materialsList');
  if (!state.materials.length) {
    box.innerHTML = '<div class="small-muted">还没有素材，先在上方登记一个。</div>';
    return;
  }
  box.innerHTML = state.materials.map((m) => `
    <div class="card" data-id="${m.id}">
      <h3>${esc(m.title)} <span class="small-muted">#${m.id}</span></h3>
      <div class="meta">${esc(m.kind || '未分类')}${m.note ? ' · ' + esc(m.note) : ''}</div>

      <div class="section-title">来源（本素材使用了下列素材，逐层向上核验）</div>
      <div>${m.sources.map((s) => `
        <span class="chip">← ${esc(s.sourceTitle)}
          <span class="small-muted">(${esc(s.relation)})</span>
          <button title="删除来源关系" data-act="del-link" data-id="${s.id}">×</button>
        </span>`).join('') || '<span class="small-muted">无</span>'}
      </div>
      <form class="mini" data-act="add-link">
        <input type="hidden" name="materialId" value="${m.id}" />
        <select name="sourceMaterialId" required>
          <option value="">选择来源素材…</option>
          ${state.materials.filter((x) => x.id !== m.id && !m.sources.some((s) => s.sourceMaterialId === x.id))
            .map((x) => `<option value="${x.id}">${esc(x.title)}</option>`).join('')}
        </select>
        <input name="relation" placeholder="关系（如 配乐）" style="width:110px" />
        <button class="btn btn-small" type="submit" data-go="save">＋ 来源</button>
        <button class="btn btn-small btn-primary" type="submit" data-go="preview">预演影响</button>
      </form>

      <div class="section-title">授权</div>
      ${m.authorizations.length ? `
        <table class="auth">
          <tr><th>媒介</th><th>地区</th><th>有效期</th><th>状态</th><th>授权方</th><th></th></tr>
          ${m.authorizations.map((a) => `
            <tr class="${a.revoked ? 'revoked' : ''}">
              <td>${esc(a.media)}</td><td>${esc(a.region)}</td>
              <td>${a.validFrom} → ${a.validTo}</td>
              <td>${a.revoked ? '<span class="pill pill-bad">已撤销</span>' : '<span class="pill pill-ok">有效</span>'}</td>
              <td>${esc(a.licensor || '')}</td>
              <td class="pkg-actions">
                <button class="btn btn-small" data-act="edit-auth" data-id="${a.id}">改</button>
                ${a.revoked ? '' : `<button class="btn btn-small" data-act="revoke" data-id="${a.id}">撤销</button>`}
                <button class="btn btn-small btn-danger" data-act="del-auth" data-id="${a.id}">删除</button>
              </td>
            </tr>`).join('')}
        </table>` : '<span class="small-muted">无授权登记</span>'}
      <form class="mini" data-act="add-auth">
        <input type="hidden" name="materialId" value="${m.id}" />
        <input type="hidden" name="authorizationId" value="" />
        <input name="media" placeholder="媒介（* 任意）" style="width:100px" required />
        <input name="region" placeholder="地区（* 任意）" style="width:100px" required />
        <input name="validFrom" type="date" required />
        <input name="validTo" type="date" required />
        <input name="licensor" placeholder="授权方" style="width:100px" />
        <label class="revoked-edit hidden" title="修改时可直接把授权置为已撤销"><input type="checkbox" name="revoked" /> 已撤销</label>
        <button class="btn btn-small" type="submit" data-go="save">＋ 授权</button>
        <button class="btn btn-small btn-primary" type="submit" data-go="preview">预演影响</button>
        <button class="btn btn-small hidden" type="button" data-act="cancel-edit-auth">取消修改</button>
      </form>

      <div class="section-title">被用于</div>
      <div>${m.usedBy.map((u) => `<span class="chip">${esc(u.materialTitle)} <span class="small-muted">(${esc(u.relation)})</span></span>`).join('') || '<span class="small-muted">无</span>'}</div>
    </div>`).join('');
}

$('#addMaterialForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('POST', '/api/materials', { title: f.title.value, kind: f.kind.value });
    f.reset();
    await loadState();
    toast('素材已登记');
  } catch (err) { toast(errText(err), true); }
});

// 依据表单构造变更操作载荷（字段沿用既有编辑接口）
function authFormChange(form) {
  const authorizationId = Number(form.authorizationId.value || 0);
  if (authorizationId) {
    return {
      operation: 'authorization.update',
      authorizationId,
      media: form.media.value, region: form.region.value,
      validFrom: form.validFrom.value, validTo: form.validTo.value,
      licensor: form.licensor.value,
      revoked: form.revoked.checked,
    };
  }
  return {
    operation: 'authorization.create',
    materialId: Number(form.materialId.value),
    media: form.media.value, region: form.region.value,
    validFrom: form.validFrom.value, validTo: form.validTo.value,
    licensor: form.licensor.value,
  };
}

function resetAuthForm(form) {
  form.reset();
  form.authorizationId.value = '';
  form.querySelector('[data-go="save"]').textContent = '＋ 授权';
  form.querySelector('.revoked-edit').classList.add('hidden');
  form.querySelector('[data-act="cancel-edit-auth"]').classList.add('hidden');
}

function fillAuthFormForEdit(form, auth) {
  form.authorizationId.value = auth.id;
  form.media.value = auth.media;
  form.region.value = auth.region;
  form.validFrom.value = auth.validFrom;
  form.validTo.value = auth.validTo;
  form.licensor.value = auth.licensor || '';
  form.revoked.checked = !!auth.revoked;
  form.querySelector('[data-go="save"]').textContent = '保存修改';
  form.querySelector('.revoked-edit').classList.remove('hidden');
  form.querySelector('[data-act="cancel-edit-auth"]').classList.remove('hidden');
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

$('#materialsList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const card = btn.closest('.card');
  try {
    if (btn.dataset.act === 'edit-auth') {
      const matId = Number(card.dataset.id);
      const mat = state.materials.find((x) => x.id === matId);
      const auth = mat.authorizations.find((a) => a.id === Number(btn.dataset.id));
      const form = card.querySelector('form[data-act="add-auth"]');
      fillAuthFormForEdit(form, auth);
      return;
    }
    if (btn.dataset.act === 'cancel-edit-auth') {
      resetAuthForm(btn.closest('form'));
      return;
    }

    let change = null;
    let confirmMsg = '';
    if (btn.dataset.act === 'del-link') {
      change = { operation: 'source.delete', linkId: Number(btn.dataset.id) };
      confirmMsg = '删除该来源关系？（可能影响已发布包资格）';
    } else if (btn.dataset.act === 'revoke') {
      change = { operation: 'authorization.revoke', authorizationId: Number(btn.dataset.id) };
      confirmMsg = '撤销该授权？依赖它的已发布包将被标记为需复核。';
    } else if (btn.dataset.act === 'del-auth') {
      change = { operation: 'authorization.delete', authorizationId: Number(btn.dataset.id) };
      confirmMsg = '删除该授权？此变更不可从快照中追溯恢复。';
    }
    if (!change) return;

    if ($('#previewMode').checked) {
      await openChangePreview(change);
      return;
    }
    if (!confirm(confirmMsg)) return;
    if (change.operation === 'source.delete') {
      await api('DELETE', `/api/source-links/${change.linkId}`);
      toast('来源关系已删除，已重新计算已发布包资格');
    } else if (change.operation === 'authorization.revoke') {
      await api('POST', `/api/authorizations/${change.authorizationId}/revoke`);
      toast('授权已撤销，已重新计算已发布包资格');
    } else {
      await api('DELETE', `/api/authorizations/${change.authorizationId}`);
      toast('授权已删除，已重新计算已发布包资格');
    }
    await loadState();
  } catch (err) { toast(errText(err), true); }
});

$('#materialsList').addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-act]');
  if (!form) return;
  e.preventDefault();
  const go = e.submitter && e.submitter.dataset.go === 'preview' ? 'preview' : 'save';
  try {
    if (form.dataset.act === 'add-link') {
      const change = {
        operation: 'source.create',
        materialId: Number(form.materialId.value),
        sourceMaterialId: Number(form.sourceMaterialId.value),
        relation: form.relation.value,
      };
      if (go === 'preview' || $('#previewMode').checked) {
        await openChangePreview(change, undefined, form);
        return;
      }
      await api('POST', `/api/materials/${change.materialId}/sources`, {
        sourceMaterialId: change.sourceMaterialId,
        relation: change.relation,
      });
      toast('来源关系已登记');
    } else if (form.dataset.act === 'add-auth') {
      const change = authFormChange(form);
      if (go === 'preview' || $('#previewMode').checked) {
        await openChangePreview(change, undefined, form);
        return;
      }
      // 关闭预演模式时沿用既有接口直接保存
      if (change.operation === 'authorization.update') {
        await api('PATCH', `/api/authorizations/${change.authorizationId}`, change);
        toast('授权已修改');
      } else {
        await api('POST', `/api/materials/${change.materialId}/authorizations`, change);
        toast('授权已登记');
      }
      resetAuthForm(form);
    }
    await loadState();
  } catch (err) {
    if (err.status === 409 && err.details && err.details.cyclePath) {
      const cycle = err.details.cycle || err.details.cyclePath;
      const names = cycle.map((id) => {
        const m = state.materials.find((x) => x.id === id);
        return m ? m.title : `#${id}`;
      });
      toast(`${err.message} 闭环路径：${names.join(' → ')}`, true);
    } else toast(errText(err), true);
  }
});

// ---------------- 展览包页 ----------------
function renderMaterialPick() {
  const pick = $('#materialPick');
  const selected = new Set($$('#materialPick input:checked').map((i) => i.value));
  if (!state.materials.length) { pick.innerHTML = '<span class="small-muted">请先到「素材与来源」页登记素材</span>'; return; }
  pick.innerHTML = state.materials.map((m) => `
    <label><input type="checkbox" name="materialIds" value="${m.id}" ${selected.has(String(m.id)) ? 'checked' : ''} />
      ${esc(m.title)} <span class="small-muted">#${m.id}</span></label>`).join('');
}

function readPkgForm() {
  const f = $('#packageForm');
  return {
    packageId: f.packageId.value ? Number(f.packageId.value) : null,
    name: f.name.value.trim(),
    medium: f.medium.value.trim(),
    region: f.region.value.trim(),
    useFrom: f.useFrom.value,
    useTo: f.useTo.value,
    materialIds: $$('#materialPick input:checked').map((i) => Number(i.value)),
  };
}

function fillPkgForm(pkg) {
  const f = $('#packageForm');
  f.packageId.value = pkg.id || '';
  f.name.value = pkg.name || '';
  f.medium.value = pkg.medium || '';
  f.region.value = pkg.region || '';
  f.useFrom.value = pkg.useFrom || '';
  f.useTo.value = pkg.useTo || '';
  renderMaterialPick();
  const ids = new Set((pkg.items || pkg.materialIds || []).map((x) => typeof x === 'object' ? x.id : x));
  $$('#materialPick input').forEach((i) => { i.checked = ids.has(Number(i.value)); });
  $('#pkgFormTitle').textContent = pkg.id ? `编辑待发布包 #${pkg.id}` : '新建待发布展览包';
  $('#savePkgBtn').textContent = pkg.id ? '保存修改' : '保存待发布包';
  $('#verifyPanel').classList.add('hidden');
}

$('#newPkgBtn').addEventListener('click', () => fillPkgForm({}));

$('#packageForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const b = readPkgForm();
  try {
    let pkg;
    if (b.packageId) {
      pkg = await api('PATCH', `/api/packages/${b.packageId}`, b);
      toast('待发布包已更新');
    } else {
      pkg = await api('POST', '/api/packages', b);
      toast('待发布包已保存');
    }
    await loadState();
    fillPkgForm(pkg);
  } catch (err) { toast(errText(err), true); }
});

// ---- 核验 ----
$('#verifyPkgBtn').addEventListener('click', async () => {
  const b = readPkgForm();
  try {
    const body = b.packageId
      ? { packageId: b.packageId }
      : { materialIds: b.materialIds, medium: b.medium, region: b.region, useFrom: b.useFrom, useTo: b.useTo };
    const result = await api('POST', '/api/verify', body);
    renderVerify(result, b);
  } catch (err) { toast(errText(err), true); }
});

function pathHtml(pathArr) {
  return '<div class="path">' + pathArr.map((n, i) =>
    (i ? ' → ' : '') + `<span>${esc(n.title)}</span>`).join('') + '</div>';
}

function renderVerify(result, formData, mode = 'publish') {
  // mode: 'publish'（待发布包，可发布）| 'recheck'（已发布/需复核包，只能人工复核）
  const panel = $('#verifyPanel');
  panel.classList.remove('hidden');
  const globalErrs = (result.globalErrors || []).map((m) => `<div class="errorline">${esc(m)}</div>`).join('');
  const itemErrs = (result.itemErrors || []).map((x) => `<div class="errorline">${esc(x.message)}</div>`).join('');
  const fail = (result.failingNodes || []).map((n) => `
    <div class="card" style="margin-bottom:8px">
      <h3><span class="fail-node">${esc(n.title)}</span> <span class="small-muted">#${n.materialId}${n.isRoot ? '（入展品）' : ''}</span></h3>
      <div>${n.reasonText.map((t) => `<span class="pill pill-bad">${esc(t)}</span>`).join(' ')}</div>
      <div class="section-title">不合格来源路径（共 ${n.paths.length} 条${result.stats.pathCountTruncated ? '，过多已截断' : ''}）</div>
      ${n.paths.map((p) => '<div class="path">' + p.map((x, i) =>
        (i ? ' → ' : '') + `<span class="${x.materialId === n.materialId ? 'fail-node' : ''}">${esc(x.title)}</span>`).join('') + '</div>').join('')}
    </div>`).join('');

  const verdictText = mode === 'recheck'
    ? (result.eligible ? '✓ 复核通过：当前全部来源链节点均合格，可恢复为已发布。'
                      : '✗ 复核不通过：仍存在不合格节点，包保持需复核状态。')
    : (result.eligible ? '✓ 核验通过：来源链上每个节点都有未撤销且覆盖整段使用的授权，可以发布。'
                      : '✗ 核验不通过：存在不合格节点或输入错误，禁止发布。');

  const actionArea = mode === 'publish' && result.eligible && formData.packageId ? `
      <div class="pkg-actions">
        <button class="btn btn-primary" id="publishBtn">按此次核验结果原子发布</button>
        <span class="small-muted">发布将再次按当前数据重算并校验依据版本；若期间授权被修改会被拒绝。</span>
      </div>`
    : (mode === 'publish' && result.eligible ? '<div class="small-muted">请先「保存待发布包」，再执行发布。</div>' : '');

  panel.innerHTML = `
    <div class="verdict ${result.eligible ? 'pass' : 'fail'}">
      ${verdictText}
      <span class="sub">入展品 ${result.stats.rootCount} 个 · 来源链节点 ${result.stats.nodeCount} 个 · 不合格 ${result.stats.failingCount} 个 · 核验依据版本 ${result.basisVersion}</span>
    </div>
    ${globalErrs}${itemErrs}
    ${result.eligible ? '' : (fail || '<div class="small-muted">所有节点均满足授权要求（但可能存在上方全局错误）。</div>')}
    ${actionArea}`;

  if (mode === 'publish' && result.eligible) {
    $('#publishBtn').addEventListener('click', () => doPublish(formData, result.basisVersion));
  }
}

async function doPublish(formData, basisVersion) {
  if (!formData.packageId) { toast('请先「保存待发布包」，再发布', true); return; }
  try {
    const r = await api('POST', `/api/packages/${formData.packageId}/publish`, { basisVersion });
    toast(`发布成功，不可变快照 #${r.snapshotId} 已保存`);
    await loadState();
    fillPkgForm({});
    openSnapshot(r.snapshotId);
  } catch (err) {
    if (err.status === 409 && err.details && err.details.code === 'STALE_BASIS') {
      toast(`依据过期被拒绝：${err.message} 请点「核验」后重试发布。`, true);
      await loadState();
    } else if (err.status === 422 && err.data && err.data.details && err.data.details.result) {
      toast('核验未通过，已拒绝发布（本次核验记录已留存为快照）', true);
      await loadState();
      renderVerify(err.data.details.result, formData);
    } else toast(errText(err), true);
  }
}

// ---- 包列表 ----
const STATUS_TEXT = { draft: '待发布', published: '已发布', needs_review: '需复核' };

function renderPackages() {
  const box = $('#packagesList');
  if (!state.packages.length) { box.innerHTML = '<div class="small-muted">还没有展览包。</div>'; return; }
  box.innerHTML = state.packages.map((p) => `
    <div class="panel" data-id="${p.id}">
      <div class="pkg-head">
        <h3>${esc(p.name)} <span class="small-muted">#${p.id}</span>
          <span class="pill ${p.status === 'published' ? 'pill-ok' : p.status === 'needs_review' ? 'pill-bad' : 'pill-neutral'}">${STATUS_TEXT[p.status]}</span>
        </h3>
        <div class="pkg-actions">
          ${p.status === 'draft' ? `<button class="btn btn-small" data-act="edit">编辑</button>` : ''}
          ${p.status === 'draft' ? `<button class="btn btn-small btn-primary" data-act="to-verify">去核验</button>` : ''}
          ${p.status === 'needs_review' ? `<button class="btn btn-small btn-primary" data-act="recheck">重新核验（人工复核）</button>` : ''}
          <button class="btn btn-small" data-act="snapshot">查看最新快照</button>
          <button class="btn btn-small" data-act="copy">复制为待发布包</button>
          ${p.status === 'draft' ? `<button class="btn btn-small btn-danger" data-act="del">删除</button>` : ''}
        </div>
      </div>
      <div class="pkg-meta">
        媒介：${esc(p.medium)} ｜ 地区：${esc(p.region)} ｜ 使用期：${p.useFrom} → ${p.useTo}
        ｜ 素材 ${p.itemCount} 项
        ${p.publishedAt ? `｜ 发布于 ${p.publishedAt.slice(0, 19).replace('T', ' ')}` : ''}
      </div>
      <div class="pkg-meta" style="margin-top:4px">
        素材：${p.items.map((i) => esc(i.title)).join('、')}
      </div>
      ${p.latestSnapshot ? `<div class="small-muted" style="margin-top:4px">
        最新快照 #${p.latestSnapshot.id}（${{ publish: '发布', review: '自动复核', recheck: '人工复核' }[p.latestSnapshot.kind]}，
        依据版本 ${p.latestSnapshot.basisVersion}，${p.latestSnapshot.eligible ? '当时合格' : '当时不合格'}，
        ${p.latestSnapshot.createdAt.slice(0, 19).replace('T', ' ')}）— 发布快照 ${p.publishSnapshotId ? `#${p.publishSnapshotId}` : '无'} 始终保留
      </div>` : ''}
    </div>`).join('');
}

$('#packagesList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.closest('.panel').dataset.id);
  const pkg = state.packages.find((x) => x.id === id);
  try {
    if (btn.dataset.act === 'edit' || btn.dataset.act === 'to-verify') {
      const full = await api('GET', `/api/packages/${id}`);
      fillPkgForm(full);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (btn.dataset.act === 'to-verify') {
        const result = await api('POST', '/api/verify', { packageId: id });
        renderVerify(result, readPkgForm());
      }
    } else if (btn.dataset.act === 'snapshot') {
      await openSnapshot(pkg.latestSnapshot.id);
    } else if (btn.dataset.act === 'copy') {
      const copy = await api('POST', `/api/packages/${id}/copy`);
      await loadState();
      fillPkgForm(copy);
      toast('已复制为新的待发布包');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (btn.dataset.act === 'recheck') {
      const r = await api('POST', `/api/packages/${id}/recheck`);
      await loadState();
      renderVerify(r.result, { packageId: id }, 'recheck');
      toast(r.message, !r.restored);
    } else if (btn.dataset.act === 'del') {
      if (!confirm('删除该待发布包？')) return;
      await api('DELETE', `/api/packages/${id}`);
      await loadState();
      toast('已删除');
    }
  } catch (err) { toast(errText(err), true); }
});

// ---- 快照弹层 ----
async function openSnapshot(snapshotId) {
  try {
    const s = await api('GET', `/api/snapshots/${snapshotId}`);
    $('#modalTitle').textContent =
      `核验快照 #${s.id}（${{ publish: '发布', review: '自动复核', recheck: '人工复核' }[s.kind]}）— 不可变`;
    $('#modalFoot').classList.add('hidden');
    $('#modalFoot').innerHTML = '';
    const p = s.payload;
    $('#modalBody').innerHTML = `
      <div class="verdict ${s.eligible ? 'pass' : 'fail'}">
        ${s.eligible ? '该快照记录的核验结果：合格' : '该快照记录的核验结果：不合格'}
        <span class="sub">生成于 ${s.createdAt} ｜ 依据版本 ${s.basisVersion} ｜ 媒介 ${esc(p.request.medium)} ｜ 地区 ${esc(p.request.region)} ｜ 使用期 ${p.request.useFrom} → ${p.request.useTo}</span>
      </div>
      <div class="section-title">冻结素材清单（入展品 ID：${p.request.materialIds.join(', ') || '空'}）</div>
      <table class="auth">
        <tr><th>节点</th><th>结论</th><th>命中授权</th><th>路径数</th></tr>
        ${p.nodes.map((n) => `
          <tr>
            <td>${esc(n.title)}${n.isRoot ? ' <span class="small-muted">（入展品）</span>' : ''}</td>
            <td>${n.eligible ? '<span class="pill pill-ok">合格</span>' : n.reasonText.map((t) => `<span class="pill pill-bad">${esc(t)}</span>`).join(' ')}</td>
            <td>${n.matchedAuthorization ? `#${n.matchedAuthorization.id}（${esc(n.matchedAuthorization.media)}/${esc(n.matchedAuthorization.region)}，${n.matchedAuthorization.validFrom}→${n.matchedAuthorization.validTo}）` : '<span class="small-muted">—</span>'}</td>
            <td>${n.paths.length}</td>
          </tr>`).join('')}
      </table>
      <div class="section-title">快照原始 JSON</div>
      <pre class="json">${esc(JSON.stringify(p, null, 2))}</pre>`;
    $('#modalBackdrop').classList.remove('hidden');
  } catch (err) { toast(errText(err), true); }
}
$('#modalClose').addEventListener('click', () => $('#modalBackdrop').classList.add('hidden'));
$('#modalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'modalBackdrop') $('#modalBackdrop').classList.add('hidden'); });

// ---- 变更影响预演 + 确认提交 ----
const OP_LABEL = {
  'authorization.create': '新增授权',
  'authorization.update': '修改授权',
  'authorization.revoke': '撤销授权',
  'authorization.delete': '删除授权',
  'source.create': '新增来源关系',
  'source.delete': '删除来源关系',
};

function impactNodesHtml(n) {
  return `
    <div class="impact-node">
      <b>${esc(n.title)}</b> <span class="small-muted">#${n.materialId}${n.isRoot ? '（入展品）' : ''}</span>
      <div>${n.reasonText.map((t) => `<span class="pill pill-bad">${esc(t)}</span>`).join(' ')}</div>
      <div class="section-title">不合格来源路径（共 ${n.paths.length} 条）</div>
      ${n.paths.map((p) => '<div class="path">' + p.map((x, i) =>
        (i ? ' → ' : '') + `<span class="${x.materialId === n.materialId ? 'fail-node' : ''}">${esc(x.title)}</span>`).join('') + '</div>').join('')}
    </div>`;
}

function impactListHtml(impact) {
  if (!impact.length) {
    return '<div class="verdict pass" style="margin-top:8px">✓ 该变更不会使任何已发布展览包由合格转为不合格。</div>';
  }
  return `<div class="verdict fail" style="margin-top:8px">
      ✗ 以下 ${impact.length} 个已发布展览包将由合格转为不合格（确认后标记为需复核并追加不可变复核快照，不自动恢复）
    </div>` + impact.map((p) => `
    <div class="impact-pkg">
      <h4>${esc(p.packageName)} <span class="small-muted">#${p.packageId}</span>
        <span class="pill pill-ok">当前：已发布</span> → <span class="pill pill-bad">确认后：需复核</span></h4>
      <div class="small-muted">媒介：${esc(p.medium)} ｜ 地区：${esc(p.region)} ｜ 使用期：${p.useFrom} → ${p.useTo}</div>
      <div class="section-title">问题节点（${p.failingNodes.length} 个）及原因</div>
      ${p.failingNodes.map(impactNodesHtml).join('')}
    </div>`).join('');
}

// 发起预演并打开弹层（sourceForm 为发起预演的表单，成功提交后用于复位）
async function openChangePreview(change, staleNote, sourceForm) {
  let preview;
  try {
    preview = await api('POST', '/api/changes/preview', change);
  } catch (err) {
    if (err.status === 409 && err.details && err.details.cyclePath) {
      const cycle = err.details.cycle || err.details.cyclePath;
      const names = cycle.map((id) => {
        const m = state.materials.find((x) => x.id === id);
        return m ? m.title : `#${id}`;
      });
      toast(`${err.message} 闭环路径：${names.join(' → ')}`, true);
    } else {
      toast('预演被拒绝：' + errText(err), true);
    }
    return;
  }

  $('#modalTitle').textContent = `影响预演：${OP_LABEL[preview.operation] || preview.operation}（依据版本 ${preview.basisVersion}）`;
  $('#modalBody').innerHTML = `
    ${staleNote ? `<div class="stale-banner">${esc(staleNote)}</div>` : ''}
    <div class="edit-banner">
      <span><b>拟执行操作：</b>${esc(preview.summary)}</span>
      <span class="small-muted">依据版本：<b>${preview.basisVersion}</b></span>
    </div>
    <div class="small-muted">预演只读取当前数据，未改动授权、来源关系、包状态或任何快照；请在确认前不要由他人修改授权或来源关系。</div>
    ${impactListHtml(preview.impact)}`;

  const foot = $('#modalFoot');
  foot.classList.remove('hidden');
  foot.innerHTML = `
    <button class="btn" id="previewCancel">取消（不做任何改动）</button>
    <button class="btn" id="previewReplay">重新预演</button>
    <button class="btn btn-primary" id="previewConfirm">确认提交同一操作及预演结果</button>`;
  $('#previewCancel').addEventListener('click', () => $('#modalBackdrop').classList.add('hidden'));
  $('#previewReplay').addEventListener('click', () => openChangePreview(change, undefined, sourceForm));
  $('#previewConfirm').addEventListener('click', () => commitPreviewedChange(change, preview, sourceForm));
  $('#modalBackdrop').classList.remove('hidden');
}

// 确认提交同一操作 + 预演结果
async function commitPreviewedChange(change, preview, sourceForm) {
  const btn = $('#previewConfirm');
  btn.disabled = true;
  try {
    const r = await api('POST', '/api/changes/commit', {
      ...change,
      basisVersion: preview.basisVersion,
      impact: preview.impact,
    });
    $('#modalBackdrop').classList.add('hidden');
    await loadState();
    toast(`变更已执行（依据版本 ${r.basisVersion}）：${r.impact.length ? `${r.impact.length} 个已发布包标记为需复核` : '无已发布包受影响'}`);
    // 若预演由授权表单发起，提交成功后复位该表单
    if (sourceForm && sourceForm.matches('form[data-act="add-auth"]')) resetAuthForm(sourceForm);
  } catch (err) {
    btn.disabled = false;
    if (err.status === 409 && err.details && (err.details.code === 'STALE_BASIS' || err.details.code === 'IMPACT_MISMATCH')) {
      // 依据过期或影响清单漂移：关闭旧弹层，按当前数据重新预演并展示过期提示
      let note = err.message;
      if (err.details.code === 'IMPACT_MISMATCH') {
        note += ' 已按当前数据重新预演，下方为最新影响清单。';
      }
      await loadState();
      openChangePreview(change, note, sourceForm);
    } else {
      toast('提交被拒绝：' + errText(err), true);
    }
  }
}

loadState().catch((e) => toast('初始化失败：' + e.message, true));
