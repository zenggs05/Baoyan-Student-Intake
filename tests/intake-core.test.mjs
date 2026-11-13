// 采集页核心逻辑测试：schema / 校验 / 待确认 / 完成度 / 文档模型 / 文件名 / JSON 备份 / 本地草稿。
// 若存在 reference/legacy_app_core.min.js（原版代码，已 gitignore），会把原版函数与重写版逐项对比，
// 确保数据格式和行为完全兼容；该文件不存在时只跑重写版自身的用例。
// 运行：node --test tests/intake-core.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECTIONS, STEPS, PENDING, SCHEMA_VERSION, FORM_TYPE } from '../src/intake/schema.js';
import { MAX_RECORDS, MAX_BACKUP_BYTES, createEmptyForm, createRecord, hasValue } from '../src/intake/form.js';
import { validateField, validateForm, collectPending, completion, parseBackup } from '../src/intake/validate.js';
import { STORAGE_KEY, loadDraft, saveDraft, saveRecord, clearDraft } from '../src/intake/storage.js';
import { buildDocument, buildReport, exportFileName, formatValue } from '../src/intake/model.js';
import { sampleForm, sampleJson } from './intake-fixtures.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY_PATH = join(ROOT, 'reference', 'legacy_app_core.min.js');
const legacy = existsSync(LEGACY_PATH)
  ? new Function(`${readFileSync(LEGACY_PATH, 'utf8')}\nreturn {O6,On,G0,Ka,I0,La,ha,c0,VF,we,xt,pa,Na,va,xF,WF,pu,U2,l0,ma,Wt,Rn,Pn};`)()
  : null;
const withLegacy = legacy ? test : test.skip;

class MemoryStore {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

/** 构造一批「有各种问题」的表单，用于对比校验结果 */
function variants() {
  const list = [];
  const push = (name, mutate) => {
    const f = sampleForm();
    mutate(f);
    list.push([name, f]);
  };
  push('示例数据', () => {});
  push('空白表单', (f) => Object.assign(f, JSON.parse(JSON.stringify(createEmptyForm())), { createdAt: f.createdAt, updatedAt: f.updatedAt }));
  push('GPA 超过满分', (f) => { f.academics.gpa = 4.5; });
  push('排名超过总人数', (f) => { f.academics.academicRank = 300; f.academics.comprehensiveRank = 9; f.academics.comprehensiveTotal = 5; });
  push('数字格式', (f) => { f.academics.gpaScale = '4.'; f.academics.academicTotal = '1e3'; f.english.cet4 = 712; f.english.cet6 = '-1'; f.availability.weeklyHours = '待确认'; });
  push('整数要求', (f) => { f.academics.academicRank = 6.5; f.student.enrollmentYear = '2023.5'; });
  push('年份范围', (f) => { f.student.applicationYear = 1979; f.student.graduateEnrollmentYear = 2200; });
  push('链接', (f) => { f.recommendationEligibility.policyUrl = 'ftp://x.cn'; f.targetPrograms[0].website = 'example.edu.cn'; });
  push('选项', (f) => { f.student.grade = '研一'; f.academics.rankSource = PENDING; f.careerGoals.degree = '不适用'; });
  push('日期', (f) => { f.student.formDate = '2026-02-30'; f.english.cet4Date = '2023-13'; f.english.cet6Date = '1970-01'; });
  push('控制字符与长度', (f) => { f.student.notes = 'a\u0001b'; f.student.displayName = 'x'.repeat(81); f.experience.topStrengths = '换行\n制表\t可以'; });
  push('不适用 / 未考', (f) => { f.english.cet4 = '不适用'; f.academics.gpa = '未考'; f.academics.comprehensiveRank = '未考'; });
  push('勾选与多选为空', (f) => { f.confirmation.truthful = false; f.supportNeeds.priorities = []; });
  push('经历状态', (f) => { f.publications = []; f.experienceStatus.publications = 'none'; f.competitions = []; f.experienceStatus.competitions = 'unsure'; f.targetPrograms = []; });
  push('条目缺必填', (f) => { f.researchProjects[1].name = ''; f.publications[0].status = ''; });
  push('待确认多样', (f) => { f.academics.trend = '不确定'; f.english.selfIntroduction = '未评估'; f.careerGoals.futureGoal = '未确定'; f.recommendationEligibility.likelihood = '无法判断'; });
  return list;
}

/* ---------------- 与原版逐项对比 ---------------- */
withLegacy('schema、步骤、常量与原版完全一致', () => {
  assert.deepEqual(SECTIONS, legacy.O6);
  assert.deepEqual(STEPS, legacy.On);
  assert.equal(PENDING, legacy.G0);
  assert.equal(STORAGE_KEY, legacy.Ka);
  assert.equal(MAX_RECORDS, legacy.I0);
  assert.equal(MAX_BACKUP_BYTES, legacy.La);
  assert.equal(SCHEMA_VERSION, legacy.ha);
});

withLegacy('空白表单结构与原版一致', () => {
  const a = createEmptyForm();
  const b = legacy.c0();
  for (const k of ['createdAt', 'updatedAt']) { delete a[k]; delete b[k]; }
  assert.deepEqual(a, b);
  const r = createRecord(SECTIONS[4]);
  const lr = legacy.VF(legacy.O6[4]);
  assert.deepEqual(Object.keys(r), Object.keys(lr));
});

withLegacy('校验、待确认、完成度、文档模型、文件名与原版一致', () => {
  for (const [name, f] of variants()) {
    assert.deepEqual(validateForm(f), legacy.U2(f), `校验结果不同：${name}`);
    assert.deepEqual(collectPending(f), legacy.l0(f), `待确认列表不同：${name}`);
    assert.deepEqual(completion(f), legacy.ma(f), `完成度不同：${name}`);
    for (let s = 0; s < 6; s++) assert.deepEqual(completion(f, s), legacy.ma(f, s), `第 ${s + 1} 步完成度不同：${name}`);
    assert.deepEqual(buildDocument(f), legacy.Wt(f), `文档模型不同：${name}`);
    assert.equal(exportFileName(f, 'docx'), legacy.Rn(f, 'docx'), `文件名不同：${name}`);
  }
  const odd = sampleForm();
  odd.student.university = '  A/B:C*大学. ';
  odd.student.displayName = '';
  odd.student.applicationYear = 'x'.repeat(60);
  assert.equal(exportFileName(odd, 'json'), legacy.Rn(odd, 'json'));
});

withLegacy('单字段校验与原版一致（逐字段 × 多种取值）', () => {
  const values = ['', ' ', PENDING, '不适用', '未考', '0', '1', '3.5', '3.', '-2', '1e3', 0, 12, 4.3, 100001, '2026-11-10', '2026-11', '2026-02-30',
    'https://a.cn', 'ftp://a.cn', 'abc', '是', '大三', '已发表', true, false, [], ['资格诊断'], 'a\u0007b', 'y'.repeat(301)];
  for (const s of SECTIONS) {
    for (const f of s.fields) {
      for (const v of values) assert.equal(validateField(f, v), legacy.pu(f, v), `${s.key}.${f.id} = ${JSON.stringify(v)}`);
    }
  }
});

withLegacy('JSON 备份解析：合法数据结果一致，非法数据报错文案一致', () => {
  assert.deepEqual(parseBackup(sampleJson()), legacy.pa(sampleJson()));
  const bad = [];
  const add = (mutate) => { const f = sampleForm(); mutate(f); bad.push(JSON.stringify(f)); };
  bad.push('not json', '[]', '{}', JSON.stringify({ ...sampleForm(), schemaVersion: '2.0.0' }));
  add((f) => { f.updatedAt = 'yesterday'; });
  add((f) => { delete f.student; });
  add((f) => { f.academics = []; });
  add((f) => { f.confirmation.truthful = 'yes'; });
  add((f) => { f.supportNeeds.priorities = ['资格诊断', '资格诊断']; });
  add((f) => { f.supportNeeds.priorities = ['不存在的选项']; });
  add((f) => { f.academics.gpa = { v: 1 }; });
  add((f) => { f.student.displayName = 'x'.repeat(81); });
  add((f) => { f.student.notes = 'a\u0002'; });
  add((f) => { f.researchProjects = {}; });
  add((f) => { f.researchProjects = Array.from({ length: 51 }, (_, i) => ({ id: `r${i}` })); });
  add((f) => { f.researchProjects[0] = 'x'; });
  add((f) => { f.experienceStatus.publications = 'maybe'; });
  add((f) => { f.experienceStatus.publications = 'none'; });
  add((f) => { f.student.gpa = 'ignored-unknown-field'; f.extra = 1; });
  add((f) => { f.academics.gpa = Infinity; });
  for (const text of bad) {
    let mine; let theirs;
    try { mine = parseBackup(text); } catch (e) { mine = `ERR:${e.message}`; }
    try { theirs = legacy.pa(text); } catch (e) { theirs = `ERR:${e.message}`; }
    assert.deepEqual(mine, theirs, text.slice(0, 80));
  }
  // 非法 / 重复的条目 id 会被重新生成（两边都是随机 id，只比较是否被替换）
  const f = sampleForm();
  f.researchProjects[1].id = f.researchProjects[0].id;
  f.researchProjects[2].id = 'bad id!';
  const p = parseBackup(JSON.stringify(f));
  assert.equal(p.researchProjects[0].id, 'proj-dft-2025');
  assert.notEqual(p.researchProjects[1].id, 'proj-dft-2025');
  assert.notEqual(p.researchProjects[2].id, 'bad id!');
});

withLegacy('本地草稿：原版保存的草稿能被新版读取，反之亦然；单条保存行为一致', () => {
  const store = new MemoryStore();
  legacy.va(legacy.pa(sampleJson()), store);
  assert.deepEqual(loadDraft(store), legacy.Na(store));

  const store2 = new MemoryStore();
  saveDraft(parseBackup(sampleJson()), store2);
  assert.deepEqual(legacy.Na(store2), loadDraft(store2));

  // saveRecord（原版 xF）：只更新某一条，其余保持草稿旧值
  const s1 = new MemoryStore();
  const s2 = new MemoryStore();
  const saved = parseBackup(sampleJson());
  saveDraft(saved, s1);
  saveDraft(saved, s2);
  const current = parseBackup(sampleJson());
  const sec = SECTIONS.find((s) => s.key === 'researchProjects');
  current.researchProjects[0].name = '改过的名称';
  current.researchProjects[1].name = '这条不应写入';
  current.researchProjects.splice(2, 1);
  current.updatedAt = '2026-11-12T00:00:00.000Z';
  saveRecord(current, sec, current.researchProjects[0].id, s1);
  legacy.xF(current, legacy.O6.find((s) => s.key === 'researchProjects'), current.researchProjects[0].id, s2);
  assert.equal(s1.getItem(STORAGE_KEY), s2.getItem(STORAGE_KEY));
  const after = loadDraft(s1);
  assert.equal(after.researchProjects[0].name, '改过的名称');
  assert.equal(after.researchProjects[1].name, '柔性透明导电薄膜的制备与表征');
  assert.equal(after.researchProjects.length, 2);

  clearDraft(s1);
  assert.equal(loadDraft(s1), null);
});

/* ---------------- 重写版自身的用例（不依赖原版文件） ---------------- */
test('基本常量与空白表单', () => {
  assert.equal(STORAGE_KEY, 'baoyan-student-intake:v1');
  assert.equal(FORM_TYPE, 'baoyan-student-intake');
  const f = createEmptyForm();
  assert.equal(f.schemaVersion, '1.0.0');
  assert.match(f.student.formDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(f.supportNeeds.priorities, []);
  assert.equal(f.confirmation.truthful, false);
  assert.deepEqual(f.researchProjects, []);
  assert.equal(f.experienceStatus.researchProjects, '');
});

test('示例数据通过校验，待确认项与文档模型正确', () => {
  const f = parseBackup(sampleJson());
  assert.deepEqual(validateForm(f), []);
  assert.deepEqual(completion(f), { total: completion(f).total, completed: completion(f).total, percent: 100 });
  const pending = collectPending(f);
  assert.ok(pending.includes('推免资格 · 学院往年推免名额'));
  assert.ok(pending.includes('目标院校与导师 1 · 感兴趣的导师'));
  const doc = buildDocument(f);
  const research = doc.sections.find((s) => s.key === 'researchProjects');
  assert.equal(research.groups.length, 2, '空白条目不导出');
  assert.equal(research.groups[0].title, '科研项目 1');
});

test('档案模型：信息卡、概览指标、条目标题、单元格状态', () => {
  const r = buildReport(parseBackup(sampleJson()));
  assert.deepEqual(r.info.map((i) => i.label), ['称呼', '学校', '学院', '专业', '年级', '填表日期', '最后更新']);
  const m = Object.fromEntries(r.overview.metrics.map((x) => [x.label, x.value]));
  assert.deepEqual(m, { GPA: '3.82 / 4', 学业排名: '6 / 128', 'CET-4 / CET-6': '612 / 未考', 科研项目: '2 项', 论文: '1 篇', 目标院校: '示例大学、某某科技大学' });
  assert.equal(r.overview.percent, 100);
  assert.equal(r.overview.errorCount, 0);
  const research = r.sections.find((s) => s.key === 'researchProjects');
  assert.equal(research.groups[0].title, '科研项目 1 · 钙钛矿氧化物表面氧空位的第一性原理研究');
  const rows = Object.fromEntries(r.sections.find((s) => s.key === 'recommendationEligibility').groups[0].rows.map((x) => [x.label, x]));
  assert.equal(rows['学院往年推免名额'].state, 'pending');
  assert.equal(rows['特殊推免条件'].state, 'empty');
  assert.equal(rows['特殊推免条件'].value, '未填写');
  assert.equal(rows['已知推免评定规则'].state, '');

  const empty = createEmptyForm();
  empty.experienceStatus.publications = 'none';
  empty.experienceStatus.targetPrograms = 'unsure';
  const re = buildReport(empty);
  const sec = (k) => re.sections.find((s) => s.key === k);
  assert.equal(sec('researchProjects').empty, '尚未填写科研项目记录。');
  assert.equal(sec('publications').empty, '学员已确认：暂无论文。');
  assert.equal(sec('targetPrograms').emptyState, 'pending');
  const em = Object.fromEntries(re.overview.metrics.map((x) => [x.label, x]));
  assert.equal(em['论文'].value, '暂无');
  assert.equal(em['GPA'].state, 'empty');
  assert.equal(em['目标院校'].value, '待确认');
});

test('formatValue 与 hasValue', () => {
  assert.equal(formatValue(true, 'checkbox'), '已确认');
  assert.equal(formatValue(false, 'checkbox'), '未确认');
  assert.equal(formatValue(['a', 'b']), 'a、b');
  assert.equal(formatValue([]), '未填写');
  assert.equal(formatValue('  '), '未填写');
  assert.equal(formatValue(0), '0');
  assert.equal(hasValue(0), true);
  assert.equal(hasValue(false), false);
});

test('parseBackup 拒绝不兼容的备份并给出可操作的提示', () => {
  assert.throws(() => parseBackup('{'), /文件不是有效的 JSON/);
  assert.throws(() => parseBackup(JSON.stringify({ schemaVersion: '1.0.0', formType: 'other' })), /本系统 1\.0\.0 版本导出的 JSON/);
  const f = sampleForm();
  f.experienceStatus.researchProjects = 'none';
  assert.throws(() => parseBackup(JSON.stringify(f)), /科研经历同时标记暂无并含有记录/);
});
