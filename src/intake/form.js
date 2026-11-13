// 学员信息采集 · 表单数据的基础操作（与原版 c0 / Ma / VF / we / xt / ZF 等价）
import { SECTIONS, SCHEMA_VERSION, FORM_TYPE } from './schema.js';

/** 每类可重复经历最多条数（原版 I0） */
export const MAX_RECORDS = 50;
/** JSON 备份大小上限（原版 La） */
export const MAX_BACKUP_BYTES = 32 * 1024 * 1024;

/** 条目 id（原版 yF） */
export const newId = () =>
  globalThis.crypto?.randomUUID?.() || `r${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

/** 本地日期 YYYY-MM-DD（原版 Mu） */
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 某模块的空字段对象（原版 Ma） */
export function emptyFields(section) {
  return Object.fromEntries(
    section.fields.map((f) => [f.id, f.type === 'multiselect' ? [] : f.type === 'checkbox' ? false : '']),
  );
}

/** 新建空白表单（原版 c0） */
export function createEmptyForm() {
  const now = new Date().toISOString();
  const form = { schemaVersion: SCHEMA_VERSION, formType: FORM_TYPE, createdAt: now, updatedAt: now, experienceStatus: {} };
  for (const s of SECTIONS) {
    form[s.key] = s.repeat ? [] : emptyFields(s);
    if (s.repeat) form.experienceStatus[s.key] = '';
  }
  form.student.formDate = today();
  return form;
}

/** 新建一条可重复经历（原版 VF） */
export const createRecord = (section) => ({ id: newId(), ...emptyFields(section) });

/** 是否已填写（原版 we） */
export function hasValue(v) {
  return Array.isArray(v) ? v.length > 0 : v === true || typeof v === 'number' || (typeof v === 'string' && v.trim() !== '');
}

/** 条目是否有任一字段已填写（原版 xt） */
export const recordHasContent = (section, record) => section.fields.some((f) => hasValue(record[f.id]));

/** 更新修改时间（原版 ZF） */
export function touch(form) {
  form.updatedAt = new Date().toISOString();
}

/** 深拷贝（数据是纯 JSON；老浏览器没有 structuredClone 时退回 JSON 拷贝） */
export const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

/** 有内容的条目（导出、校验只看这些） */
export const filledRecords = (form, section) => form[section.key].filter((r) => recordHasContent(section, r));
