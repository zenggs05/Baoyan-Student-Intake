// 学员信息采集 · 界面
// 按原版界面逻辑重写（legacy_app_ui.min.js：sX/GX/IX/cX/PF/lX/JX/uX/Pe 等），布局、文案和交互保持一致。
// 所有数据只在本机处理：页面 CSP 为 connect-src 'none'，不发起任何网络请求。
import { h, toast as showToast, isWeChat } from '../shared/ui.js';
import { STEPS, SECTIONS, PENDING, NOT_APPLICABLE, UNTAKEN } from './schema.js';
import { MAX_RECORDS, MAX_BACKUP_BYTES, createEmptyForm, createRecord, touch, clone } from './form.js';
import { validateForm, collectPending, completion, parseBackup } from './validate.js';
import { loadDraft, saveDraft, saveRecord, clearDraft } from './storage.js';
import { buildDocument, buildReport, exportFileName, formatTime } from './model.js';
import { renderReport } from './report.js';

/* ------------------------------------------------------------------ */
/* 状态                                                                 */
/* ------------------------------------------------------------------ */
let form = createEmptyForm();
let step = 0;
let reviewing = false; // 是否处于「信息确认与导出」页
let dirty = false; // 有未保存的更改
let savedAt = ''; // 最近一次保存草稿的时间
let storedDraft = null; // 本机已保存、尚未恢复的草稿
let exporting = false;
const inWeChat = isWeChat();

try {
  storedDraft = loadDraft();
  savedAt = storedDraft?.updatedAt || '';
} catch {
  setTimeout(() => toast('本地草稿无法读取。可导入 JSON 备份，或清除损坏的草稿。', true), 50);
}

const app = document.querySelector('#app');
const toast = (msg, isError = false) => showToast(msg, isError, 9000);
const fieldDomId = (sectionKey, fieldId, recordId) => `field-${sectionKey}-${recordId || 'single'}-${fieldId}`;

/* ------------------------------------------------------------------ */
/* 小工具                                                               */
/* ------------------------------------------------------------------ */
const ICONS = {
  book: 'M4 4h6l2 3 2-3h6v15h-6l-2 2-2-2H4z M12 7v14',
  shield: 'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6',
  save: 'M5 3h12l4 4v14H3V3z M7 3v6h10V3 M7 21v-8h10v8',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  back: 'M19 12H5 M11 6l-6 6 6 6',
  check: 'M5 12l4 4L19 6',
  file: 'M14 2H5v20h14V7z M14 2v6h5 M8 12h8 M8 16h8',
  word: 'M14 2H5v20h14V7z M14 2v6h5 M8 11l1.5 6 2.5-5 2.5 5 1.5-6',
  print: 'M7 9V3h10v6 M7 18H4v-8h16v8h-3 M7 14h10v7H7z',
  lock: 'M6 10h12v11H6z M8 10V7a4 4 0 018 0v3 M12 14v3',
};
function icon(name, size = 20) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  const attrs = { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ICONS[name] || ICONS.file);
  svg.append(path);
  return svg;
}

const button = (label, onclick, cls = 'button secondary', attrs = {}) => h('button', { type: 'button', class: cls, onclick, ...attrs }, label);

/** 触发浏览器下载（原版 Ja） */
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename }, '下载文件');
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ------------------------------------------------------------------ */
/* 状态更新                                                             */
/* ------------------------------------------------------------------ */
function markDirty() {
  touch(form);
  dirty = true;
  refreshStatus();
}

/** 刷新进度、步骤完成情况和保存状态（原版 fa），不重绘整个页面 */
function refreshStatus() {
  const all = completion(form);
  document.querySelectorAll('[data-progress-text]').forEach((el) => (el.textContent = `${all.percent}%`));
  document.querySelectorAll('[data-progress-bar]').forEach((el) => (el.style.width = `${all.percent}%`));
  document.querySelectorAll('[data-step-status]').forEach((el) => {
    const c = completion(form, Number(el.dataset.stepStatus));
    el.textContent = `${c.completed}/${c.total} 项必填`;
    el.closest('.step')?.classList.toggle('done', c.total > 0 && c.completed === c.total);
  });
  const status = document.querySelector('#save-status');
  if (status) status.textContent = dirty ? '有未保存的更改' : savedAt ? `草稿保存于 ${formatTime(savedAt)}` : '仅保存在当前页面';
}

function saveAll() {
  try {
    saveDraft(form);
    savedAt = form.updatedAt;
    storedDraft = null;
    dirty = false;
    refreshStatus();
    document.querySelector('.draft-banner')?.remove();
    toast('草稿已保存到此浏览器。共享电脑使用完毕后请清除本地数据。');
  } catch {
    toast('本地存储不可用或空间不足，请导出 JSON 备份。', true);
  }
}

function goTo(nextStep, review = false, focusId) {
  step = nextStep;
  reviewing = review;
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
  requestAnimationFrame(() => (focusId ? document.getElementById(focusId) : document.querySelector('#page-title'))?.focus());
}

function clearAll() {
  if (!confirm('清除当前填写内容和此浏览器保存的草稿？此操作不可撤销，建议先导出 JSON 备份。')) return;
  try {
    clearDraft();
  } catch {
    toast('浏览器拒绝清除草稿，请在浏览器设置中删除本站数据。', true);
    return;
  }
  form = createEmptyForm();
  dirty = false;
  savedAt = '';
  storedDraft = null;
  goTo(0);
  toast('当前填写内容与本地草稿已清除。已下载的文件需自行删除。');
}

/* ------------------------------------------------------------------ */
/* JSON 备份                                                            */
/* ------------------------------------------------------------------ */
async function restoreFromText(text) {
  try {
    const parsed = parseBackup(text);
    if (!confirm('恢复备份将替换当前页面中的填写内容，本地已保存的草稿保持不变。是否继续？')) return false;
    form = parsed;
    dirty = true;
    storedDraft = null;
    goTo(0);
    toast('备份已恢复到当前页面；如需保留，请点击保存本地草稿。');
    return true;
  } catch (err) {
    toast(err.message || '备份读取失败。', true);
    return false;
  }
}

function importJsonFile() {
  const input = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': '选择 JSON 备份' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > MAX_BACKUP_BYTES) {
      toast('备份文件超过 32 MB 上限。', true);
      return;
    }
    try {
      await restoreFromText(await file.text());
    } catch {
      toast('文件读取失败，请重新选择。', true);
    }
  });
  input.click();
}

function exportJson() {
  download(new Blob([JSON.stringify(form, null, 2)], { type: 'application/json' }), exportFileName(form, 'json'));
  toast('已生成 JSON 备份，请确认文件已保存到设备。');
}

/** 备份文本 / 粘贴恢复（跨浏览器转移，原版 su） */
function openTransferDialog() {
  const textarea = h('textarea', { class: 'transfer-text', 'aria-label': 'JSON 备份文本', spellcheck: 'false' });
  const dialog = h('dialog', { class: 'transfer-dialog', 'aria-labelledby': 'transfer-title' },
    h('h2', { id: 'transfer-title' }, '备份文本与跨浏览器恢复'),
    h('p', {}, '不同浏览器之间不会共享草稿。可复制备份文本，私下转移到另一浏览器后粘贴恢复；其中包含你的个人信息，请妥善保管。'),
    textarea,
  );
  const close = () => (typeof dialog.close === 'function' && dialog.open ? dialog.close() : dialog.remove());
  dialog.append(
    h('div', { class: 'button-row' },
      button('生成备份文本', () => {
        textarea.value = JSON.stringify(form, null, 2);
        textarea.select();
      }),
      button('复制文本', async () => {
        try {
          await navigator.clipboard.writeText(textarea.value);
          toast('已复制备份文本。');
        } catch {
          textarea.select();
          toast('请长按或按 Ctrl+C 手动复制所选文本。');
        }
      }),
      button('从文本恢复', async () => {
        if (await restoreFromText(textarea.value)) close();
      }),
      button('关闭', close),
    ),
  );
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', ''); // 老浏览器：退化为普通浮层
}

/* ------------------------------------------------------------------ */
/* 页面骨架                                                             */
/* ------------------------------------------------------------------ */
function siteHeader() {
  return h('header', { class: 'site-header' },
    h('div', { class: 'header-inner' },
      h('div', { class: 'brand' },
        h('span', { class: 'brand-icon' }, icon('book', 25)),
        h('div', {}, h('strong', {}, '保研全程陪跑'), h('span', {}, '学员信息采集系统')),
      ),
      h('div', { class: 'header-actions' },
        h('span', { class: 'local-badge' }, icon('shield', 16), '数据仅在本机处理'),
        button([icon('save', 17), '保存本地草稿'], saveAll, 'button primary compact'),
      ),
    ),
  );
}

function hero() {
  return h('section', { class: 'hero' },
    h('div', {},
      h('div', { class: 'eyebrow' }, 'YOUR NEXT CHAPTER'),
      h('h1', {}, '个人档案建立', h('span', {}, '从了解你开始。')),
      h('p', {}, '把经历梳理清楚，让每一步准备都有方向。'),
    ),
    h('div', { class: 'hero-note' },
      h('span', { class: 'note-number' }, '01—06'),
      h('span', {}, '六个步骤 · 随时回看'),
      h('small', {}, '不确定的信息，可以先标记「待确认」'),
    ),
  );
}

function stepsNav() {
  return h('nav', { class: 'steps', 'aria-label': '填写步骤' },
    STEPS.map((s, i) => {
      const active = i === step && !reviewing;
      return button(
        [
          h('span', { class: 'step-number' }, h('span', { class: 'step-index' }, String(i + 1).padStart(2, '0')), icon('check', 14)),
          h('span', { class: 'step-content' }, h('strong', {}, s.title), h('small', { 'data-step-status': i }, '')),
        ],
        () => goTo(i),
        `step${active ? ' active' : ''}`,
        { 'aria-current': active ? 'step' : undefined },
      );
    }),
  );
}

function sidePanel() {
  return h('aside', { class: 'side-panel' },
    h('section', { class: 'progress-card' },
      h('div', { class: 'eyebrow' }, 'MY APPLICATION PROFILE'),
      h('h3', {}, '一点点，拼出完整的你'),
      h('div', { class: 'progress-numbers' }, h('strong', { 'data-progress-text': true }, ''), h('span', {}, '必填项填写进度')),
      h('div', { class: 'progress-track' }, h('div', { 'data-progress-bar': true })),
      h('p', { id: 'save-status' }, ''),
      button('查看完整预览', () => goTo(5, true), 'button full'),
    ),
    h('section', { class: 'guide-card' },
      h('div', { class: 'guide-title' }, icon('book'), h('h3', {}, '填写小提示')),
      h('ol', {},
        h('li', {}, h('strong', {}, '真实，比“完美”更重要'), h('p', {}, '没有的经历可以留空；尚不了解的信息可标记待确认。')),
        h('li', {}, h('strong', {}, '把你的贡献说清楚'), h('p', {}, '比起项目名称，我们更想了解你做了什么、学到了什么。')),
        h('li', {}, h('strong', {}, '准备好后，导出并私发'), h('p', {}, '填写内容不会自动发给辅导老师。请导出文件后主动私发。')),
      ),
    ),
    h('section', { class: 'privacy-note' },
      icon('lock', 18),
      h('div', {}, h('strong', {}, '你的信息，由你掌握'), h('p', {}, '仅主动保存时才写入此浏览器。共用设备用完后，请清除本地数据。')),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* 字段（原版 PF）                                                       */
/* ------------------------------------------------------------------ */
function renderField(section, field, record) {
  const id = fieldDomId(section.key, field.id, record.id);
  const value = record[field.id];
  const markers = [PENDING, ...(field.allowNA ? [NOT_APPLICABLE] : []), ...(field.allowUntaken ? [UNTAKEN] : [])];
  const marked = markers.includes(value);
  const wrap = h('div', { class: `field${['textarea', 'multiselect', 'checkbox'].includes(field.type) ? ' wide' : ''}${marked ? ' marked' : ''}` });
  const label = h('label', { for: id }, field.label,
    field.required ? h('span', { class: 'required', 'aria-label': '必填' }, ' *') : h('span', { class: 'optional' }, '选填'));
  const hint = h('p', { class: 'field-hint', id: `${id}-hint` }, field.hint);
  const error = h('p', { class: 'field-error', id: `${id}-error`, 'aria-live': 'polite' });
  const common = { id, 'aria-describedby': `${id}-hint ${id}-error`, 'aria-required': field.required ? 'true' : undefined };
  let control;

  const showError = () => {
    const err = validateForm(form).find((e) => e.section === section.key && e.field === field.id && e.recordId === record.id);
    error.textContent = err?.message || '';
    control?.setAttribute('aria-invalid', err ? 'true' : 'false');
  };
  const setValue = (v) => {
    record[field.id] = v;
    markDirty();
  };

  if (field.type === 'multiselect') {
    control = h('div', { ...common, class: 'checkbox-grid', role: 'group', 'aria-label': field.label },
      field.options.map((opt) =>
        h('label', { class: 'choice' },
          h('input', {
            type: 'checkbox',
            checked: value.includes(opt),
            onchange: (e) => {
              setValue(e.target.checked ? [...record[field.id], opt] : record[field.id].filter((o) => o !== opt));
              showError();
            },
          }),
          opt,
        ),
      ),
    );
  } else if (field.type === 'checkbox') {
    control = h('input', { ...common, name: `${section.key}.${field.id}`, type: 'checkbox', checked: value, onchange: (e) => { setValue(e.target.checked); showError(); } });
    wrap.append(h('label', { class: 'confirmation-choice', for: id }, control, field.label, h('span', { class: 'required' }, ' *')), hint, error);
    return wrap;
  } else if (field.type === 'select') {
    control = h('select', { ...common, name: `${section.key}.${field.id}`, onchange: (e) => { setValue(e.target.value); showError(); } },
      h('option', { value: '' }, '请选择'),
      [...field.options, PENDING].map((opt) => h('option', { value: opt }, opt)),
    );
    control.value = value;
  } else {
    const isNumber = field.type === 'number';
    const placeholder = marked ? value
      : isNumber ? '填写数值'
        : field.type === 'url' ? 'https://'
          : field.type === 'month' ? '例如 2025-06'
            : '在这里填写';
    control = h(field.type === 'textarea' ? 'textarea' : 'input', {
      ...common,
      name: `${section.key}.${field.id}`,
      type: field.type === 'textarea' ? undefined : isNumber || marked ? 'text' : field.type,
      inputmode: isNumber && !marked ? 'decimal' : undefined,
      rows: field.type === 'textarea' ? 4 : undefined,
      maxlength: field.maxLength,
      placeholder,
      disabled: marked,
    });
    control.value = value;
    control.addEventListener('input', (e) => {
      const v = e.target.value;
      setValue(isNumber && /^\d+(\.\d+)?$/.test(v) ? Number(v) : v);
      if (error.textContent) showError();
    });
    control.addEventListener('blur', showError);
  }

  wrap.append(label, control, hint);
  if (!['select', 'multiselect', 'checkbox'].includes(field.type)) {
    wrap.append(
      h('div', { class: 'uncertain-options' },
        markers.map((m) =>
          button(value === m ? `${m} · 改为填写` : m, () => {
            setValue(value === m ? '' : m);
            wrap.replaceWith(renderField(section, field, record));
          }, value === m ? 'text-button selected' : 'text-button'),
        ),
      ),
    );
  }
  wrap.append(error);
  return wrap;
}

/* ------------------------------------------------------------------ */
/* 模块（原版 lX）                                                       */
/* ------------------------------------------------------------------ */
function moveRecord(section, index, delta) {
  const list = form[section.key];
  [list[index], list[index + delta]] = [list[index + delta], list[index]];
  markDirty();
  render();
}

function renderSection(section) {
  const el = h('section', { class: 'form-section', id: `section-${section.key}` },
    h('div', { class: 'section-title' }, h('h3', {}, section.title), h('p', {}, section.description)),
  );
  if (!section.repeat) {
    el.append(h('div', { class: 'fields-grid' }, section.fields.map((f) => renderField(section, f, form[section.key]))));
    return el;
  }

  const records = form[section.key];
  const status = form.experienceStatus[section.key] || '';
  el.append(
    h('div', { class: 'record-actions' },
      button(`＋ 添加${section.itemName}`, () => {
        if (records.length >= MAX_RECORDS) {
          toast(`每类最多 ${MAX_RECORDS} 条记录。`, true);
          return;
        }
        form.experienceStatus[section.key] = '';
        records.push(createRecord(section));
        markDirty();
        render();
        document.getElementById(`record-${records[records.length - 1].id}`)?.scrollIntoView({ block: 'center' });
      }, 'button secondary'),
      button(status === 'none' ? '已标记暂无 · 取消' : `暂无${section.title}`, () => {
        if (records.length && !confirm('标记暂无会清除本模块的所有当前记录，确认继续？已保存的草稿只有再次保存后才会更新。')) return;
        form[section.key] = [];
        form.experienceStatus[section.key] = status === 'none' ? '' : 'none';
        markDirty();
        render();
      }, status === 'none' ? 'text-button selected' : 'text-button'),
      !records.length &&
        button(status === 'unsure' ? '待确认 · 取消' : '待确认', () => {
          form.experienceStatus[section.key] = status === 'unsure' ? '' : 'unsure';
          markDirty();
          render();
        }, status === 'unsure' ? 'text-button selected' : 'text-button'),
    ),
  );

  if (!records.length) {
    el.append(
      h('div', { class: `empty-records${status ? ` status-${status}` : ''}` },
        icon(status === 'none' ? 'check' : 'file', 30),
        h('strong', {}, status === 'none' ? `已记录：暂无${section.title}` : status === 'unsure' ? '已标记待确认' : `还没有添加${section.itemName}`),
        h('p', {}, '空白记录不会出现在导出档案中。'),
      ),
    );
  }

  records.forEach((record, i) => {
    const name = `${section.itemName} ${i + 1}`;
    const card = h('article', { class: 'record-card', id: `record-${record.id}` },
      h('div', { class: 'record-heading' },
        h('h4', {}, name),
        h('div', { class: 'record-controls' },
          button('上移', () => moveRecord(section, i, -1), 'text-button', { disabled: i === 0, 'aria-label': `${name} 上移` }),
          button('下移', () => moveRecord(section, i, 1), 'text-button', { disabled: i === records.length - 1, 'aria-label': `${name} 下移` }),
          button('删除', () => {
            if (!confirm(`删除${name}？此操作会清除本条当前填写内容。`)) return;
            records.splice(i, 1);
            markDirty();
            render();
          }, 'text-button danger', { 'aria-label': `删除${name}` }),
        ),
      ),
      h('div', { class: 'fields-grid' }, section.fields.map((f) => renderField(section, f, record))),
    );
    card.append(
      button([icon('save', 15), '保存本条到本地草稿'], () => {
        try {
          saveRecord(form, section, record.id);
          savedAt = form.updatedAt;
          storedDraft = null;
          refreshStatus();
          toast('本条记录已保存到此浏览器；其他未保存的修改仍需点击保存本地草稿。');
        } catch {
          toast('保存失败，请使用 JSON 备份。', true);
        }
      }, 'button small'),
    );
    el.append(card);
  });
  return el;
}

/* ------------------------------------------------------------------ */
/* 填写页（原版 JX）                                                     */
/* ------------------------------------------------------------------ */
function formPage() {
  const last = step === STEPS.length - 1;
  return h('div', { class: 'form-paper' },
    h('div', { class: 'page-heading' },
      h('span', { class: 'step-tag' }, `STEP ${String(step + 1).padStart(2, '0')} / 06`),
      h('h2', { id: 'page-title', tabindex: '-1' }, STEPS[step].title),
      h('p', {}, STEPS[step].description),
      h('div', { class: 'required-note' }, h('span', { class: 'required' }, '* '), '为必填项；可先跳过，预览时统一检查。'),
    ),
    SECTIONS.filter((s) => s.step === step).map(renderSection),
    h('div', { class: 'page-navigation' },
      button('← 上一步', () => goTo(step - 1), 'button', { disabled: step === 0 }),
      h('span', {}, `${step + 1} / 6`),
      button([last ? '确认与导出' : '下一步', icon('arrow', 17)], () => goTo(last ? 5 : step + 1, last), 'button primary'),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* 导出                                                                 */
/* ------------------------------------------------------------------ */
function setExportBusy(busy) {
  exporting = busy;
  document.querySelectorAll('[data-export]').forEach((b) => (b.disabled = busy));
}

/** 导出前检查（与原版一致）：有必填 / 格式问题时不导出；有待确认项时再次确认 */
function readyToExport() {
  if (exporting) return false;
  const errors = validateForm(form);
  if (errors.length) {
    toast(`还有 ${errors.length} 项必填或格式问题，请先处理预览中的提示；未知内容可标记待确认。`, true);
    document.getElementById('validation-summary')?.scrollIntoView({ block: 'start' });
    return false;
  }
  const pending = collectPending(form);
  return !(pending.length && !confirm(`有 ${pending.length} 项待确认信息，将按当前状态写入档案。是否继续导出？`));
}

async function exportWord() {
  if (!readyToExport()) return;
  setExportBusy(true);
  toast('正在本机生成 Word，请稍候…');
  let mod;
  try {
    mod = await import('./export-docx.js');
  } catch {
    setExportBusy(false);
    toast('Word 导出组件加载失败。请检查网络后刷新页面重试（刷新前建议先导出 JSON 备份），也可以改用“导出 PDF”。', true);
    return;
  }
  try {
    const snapshot = clone(form);
    const blob = await mod.exportDocx(snapshot);
    download(blob, exportFileName(snapshot, 'docx'));
    toast(inWeChat
      ? '文件已生成。如果微信没有弹出下载，请点右上角「…」选择「在浏览器中打开」后再导出。'
      : '文件已生成，请确认下载完成后私发给辅导老师。网页不会自动提交资料。');
  } catch {
    toast('导出失败，填写内容仍保留。请先导出 JSON 备份，也可以改用“导出 PDF”。', true);
  } finally {
    setExportBusy(false);
  }
}

function exportPdf() {
  if (!readyToExport()) return;
  openReport({ autoPrint: true });
}

/* ---------- 打印报告（PDF） ---------- */
function printNow() {
  if (typeof window.print !== 'function') {
    toast('当前浏览器不支持打印。请换用 Chrome、Edge 或 Safari 打开本页后再导出 PDF。', true);
    return;
  }
  window.print();
}

function closeReport() {
  document.querySelector('.report-overlay')?.remove();
  document.body.classList.remove('report-open');
}

function openReport({ autoPrint = false } = {}) {
  closeReport();
  const back = button([icon('back', 17), '返回'], closeReport, 'button');
  const overlay = h('div', { class: 'report-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': '档案打印预览' },
    h('div', { class: 'report-toolbar' },
      h('div', { class: 'report-toolbar-inner' },
        back,
        h('div', { class: 'report-toolbar-text' },
          h('strong', {}, '导出 PDF · 打印预览'),
          h('span', {}, inWeChat
            ? '微信内无法打印或保存 PDF。请点右上角「…」选择「在浏览器中打开」，再导出 PDF。'
            : '在打印窗口中把目标打印机选为「另存为 PDF」，纸张 A4、纵向；如出现网址等多余页眉，请在「更多设置」里取消「页眉和页脚」。'),
        ),
        inWeChat ? null : button([icon('print', 17), '打印 / 另存为 PDF'], printNow, 'button primary', { 'data-print': true }),
      ),
    ),
    h('div', { class: 'report-stage' }, renderReport(buildReport(form))),
  );
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeReport();
  });
  document.body.classList.add('report-open');
  document.body.append(overlay);
  back.focus();
  if (inWeChat) toast('微信内无法直接导出 PDF。请点右上角「…」选择「在浏览器中打开」，或先导出 Word / JSON 备份。', true);
  else if (autoPrint) setTimeout(printNow, 400);
}

// 无论从哪个页面按 Ctrl+P / 浏览器菜单打印，都输出同一份档案报告
window.addEventListener('beforeprint', () => {
  if (document.querySelector('.report-overlay')) return;
  document.body.append(h('div', { class: 'report-overlay print-only' }, renderReport(buildReport(form))));
  document.body.classList.add('report-open');
});
window.addEventListener('afterprint', () => {
  const tmp = document.querySelector('.report-overlay.print-only');
  if (!tmp) return;
  tmp.remove();
  document.body.classList.remove('report-open');
});

/* ------------------------------------------------------------------ */
/* 确认与导出页（原版 uX）                                               */
/* ------------------------------------------------------------------ */
function reviewPage() {
  const errors = validateForm(form);
  const pending = collectPending(form);
  const doc = buildDocument(form);
  const paper = h('div', { class: 'form-paper preview-paper' },
    h('div', { class: 'page-heading' },
      h('span', { class: 'step-tag' }, 'REVIEW & EXPORT'),
      h('h2', { id: 'page-title', tabindex: '-1' }, '信息确认与导出'),
      h('p', {}, '再检查一次。导出后，请将文件主动私发给辅导老师。'),
    ),
  );
  const summary = h('div', { id: 'validation-summary', class: `validation-summary${errors.length ? ' has-errors' : ''}` },
    h('strong', {}, errors.length ? `${errors.length} 项信息需要补充或修正` : '必填信息已完成，可以导出'),
    h('p', {}, pending.length ? `另有 ${pending.length} 项待确认信息，导出前会再次提醒。` : '请核对真实贡献、发表状态和申请年份。'),
  );
  if (errors.length) {
    summary.append(
      h('ul', {},
        errors.map((e) => h('li', {}, button(`${e.label}：${e.message}`, () => goTo(e.step, false, fieldDomId(e.section, e.field, e.recordId)), 'text-button'))),
      ),
    );
  }
  if (pending.length) summary.append(h('details', {}, h('summary', {}, '查看待确认信息'), h('ul', {}, pending.map((p) => h('li', {}, p)))));

  paper.append(
    summary,
    h('div', { class: 'export-actions' },
      button([icon('word'), '导出 Word'], exportWord, 'button primary', { 'data-export': true }),
      button([icon('file'), '导出 PDF'], exportPdf, 'button secondary', { 'data-export': true }),
      h('p', { class: 'export-hint' }, 'Word 适合继续编辑；PDF 通过浏览器「打印 → 另存为 PDF」生成，排版与 Word 一致。'),
    ),
    h('div', { class: 'document-title' }, h('h2', {}, doc.title), h('p', {}, doc.metadata), h('small', {}, doc.notice)),
  );

  for (const s of doc.sections) {
    const n = errors.filter((e) => e.section === s.key).length;
    const block = h('section', { class: 'preview-section' },
      h('div', { class: 'preview-heading' },
        h('h3', {}, s.title),
        h('div', {},
          h('span', { class: n ? 'status-badge warning' : 'status-badge' }, n ? `${n} 项待完善` : s.empty ? '已检查 · 无记录' : '必填已完成'),
          button('返回编辑', () => {
            goTo(s.step);
            document.getElementById(`section-${s.key}`)?.scrollIntoView();
          }, 'text-button'),
        ),
      ),
    );
    if (s.empty) block.append(h('p', { class: 'empty-preview' }, s.empty));
    for (const g of s.groups) {
      block.append(
        g.title ? h('h4', {}, g.title) : null,
        h('dl', { class: 'preview-rows' },
          g.rows.map((r) => h('div', { class: r.value === '未填写' ? 'is-empty' : null }, h('dt', {}, r.label), h('dd', {}, r.value))),
        ),
      );
    }
    paper.append(block);
  }
  paper.append(
    h('div', { class: 'page-navigation' },
      button('← 返回填写', () => goTo(5), 'button'),
      button('保存本地草稿', saveAll, 'button primary'),
    ),
  );
  return paper;
}

/* ------------------------------------------------------------------ */
/* 整页渲染（原版 Pe）                                                   */
/* ------------------------------------------------------------------ */
function draftBanner() {
  return h('div', { class: 'draft-banner' },
    h('div', {},
      h('strong', {}, '此浏览器有一份已保存的草稿'),
      h('p', {}, `保存于 ${formatTime(storedDraft.updatedAt)}。恢复前不会自动载入个人资料。`),
    ),
    button('恢复本地草稿', () => {
      if (dirty && !confirm('恢复草稿会替换当前未保存的内容，是否继续？')) return;
      form = clone(storedDraft);
      storedDraft = null;
      dirty = false;
      render();
      toast('本地草稿已恢复。');
    }, 'button secondary'),
    button('暂不恢复', () => {
      storedDraft = null;
      render();
    }, 'text-button'),
  );
}

function wechatNotice() {
  return h('div', { class: 'wechat-notice' },
    h('strong', {}, '微信可能限制文件下载'),
    h('p', {}, '建议先通过下方“备份文本 / 粘贴恢复”复制内容，再用右上角菜单选择“在浏览器中打开”。微信与外部浏览器的本地草稿不互通；切换前请保留备份。'),
    button('备份文本 / 粘贴恢复', openTransferDialog, 'button small'),
  );
}

function render() {
  app.replaceChildren(siteHeader());
  const main = h('main', { class: 'main-container' }, hero(), stepsNav());
  if (storedDraft) main.append(draftBanner());
  if (inWeChat) main.append(wechatNotice());
  main.append(
    h('div', { class: 'workspace' }, reviewing ? reviewPage() : formPage(), sidePanel()),
    h('section', { class: 'data-tools', 'aria-label': '本地数据管理' },
      h('div', {}, icon('shield', 18), h('strong', {}, '本地数据管理')),
      h('div', { class: 'button-row' },
        button('导出 JSON 备份', exportJson, 'text-button'),
        button('导入 JSON 恢复', importJsonFile, 'text-button'),
        button('备份文本 / 粘贴恢复', openTransferDialog, 'text-button'),
        button('清除本地数据', clearAll, 'text-button danger'),
      ),
    ),
  );
  app.append(main,
    h('footer', { class: 'site-footer' },
      h('span', {}, '保研全程陪跑 · 为下一阶段，认真准备'),
      h('span', {}, '本地处理 · 无需登录 · 无自动提交'),
    ),
  );
  refreshStatus();
}

window.addEventListener('beforeunload', (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

render();
importMigratedDraft();

/* ------------------------------------------------------------------ */
/* 从旧网址（GitHub Pages）迁移草稿                                      */
/* 旧地址的跳转页把本机草稿编码进 URL 的 # 片段带过来。# 片段不会发送给      */
/* 任何服务器；读取后立即从地址栏和浏览历史中清除。                          */
/* ------------------------------------------------------------------ */
function importMigratedDraft() {
  const PREFIX = '#transfer=';
  if (!location.hash.startsWith(PREFIX)) return;
  const encoded = location.hash.slice(PREFIX.length);
  history.replaceState(null, '', location.pathname + location.search); // 立即清除，避免草稿留在历史记录里
  let parsed;
  try {
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
    if (bytes.length > MAX_BACKUP_BYTES) throw new Error('too large');
    parsed = parseBackup(new TextDecoder().decode(bytes));
  } catch {
    toast('从旧网址带过来的草稿无法读取。请回到旧网址导出 JSON 备份，再在这里「导入 JSON 恢复」。', true);
    return;
  }
  const when = parsed.updatedAt ? `（最后更新于 ${formatTime(parsed.updatedAt)}）` : '';
  const existing = storedDraft || null;
  const msg = existing
    ? `检测到你在旧网址填写的草稿${when}。\n此浏览器里本站已经有一份草稿，恢复旧网址的草稿会替换它。是否继续？`
    : `检测到你在旧网址填写的草稿${when}，是否恢复到新网站继续填写？`;
  if (!confirm(msg)) {
    toast('已忽略旧网址的草稿。需要时可回到旧网址导出 JSON 备份。');
    return;
  }
  form = parsed;
  try {
    saveDraft(form);
    savedAt = form.updatedAt;
    dirty = false;
  } catch {
    dirty = true;
  }
  storedDraft = null;
  goTo(0);
  toast(dirty ? '草稿已恢复到当前页面，但未能保存到本机，请导出 JSON 备份。' : '旧网址的草稿已迁移，并保存到此浏览器。');
}
