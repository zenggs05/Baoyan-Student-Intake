// 学员信息采集 · 校验、待确认统计、完成度、JSON 备份解析
// 逻辑与原版 pu / U2 / l0 / ma / pa 逐条对应，错误文案保持一致。
import { SECTIONS, SCHEMA_VERSION, FORM_TYPE, PENDING, NOT_APPLICABLE, UNTAKEN, maxYear } from './schema.js';
import { MAX_RECORDS, MAX_BACKUP_BYTES, createEmptyForm, emptyFields, hasValue, newId, recordHasContent } from './form.js';

/** 不允许的控制字符（保留 \t \n \r） */
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;
/** 视为「待确认」的文字（原版 l0 的规则） */
export const PENDING_PATTERN = /待确认|不确定|未确定|无法判断|待查|未评估/;

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** 单个字段校验，返回错误文案或空字符串（原版 pu） */
export function validateField(field, value) {
  if (!hasValue(value)) return field.required ? '请填写或标记待确认。' : '';
  if (
    (value === PENDING && !['checkbox', 'multiselect'].includes(field.type)) ||
    (field.allowNA && value === NOT_APPLICABLE) ||
    (field.allowUntaken && value === UNTAKEN)
  ) return '';
  if (typeof value === 'string' && value.length > field.maxLength) return `最多填写 ${field.maxLength} 个字符。`;
  if (typeof value === 'string' && CONTROL_CHARS.test(value)) return '请删除不支持的控制字符。';

  if (field.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n) || !/^\d+(\.\d+)?$/.test(String(value))) return '请输入有效数字，或标记待确认。';
    if (field.integer && !Number.isInteger(n)) return '请输入正整数（考试分数允许 0）。';
    if (n < field.min || n > field.max) return `应在 ${field.min}–${field.max} 之间。`;
  }
  if (field.type === 'url') {
    try {
      if (!['http:', 'https:'].includes(new URL(value).protocol)) return '请填写 http 或 https 公开链接。';
    } catch {
      return '请填写完整链接（以 https:// 开头）。';
    }
  }
  if (field.type === 'select' && !field.options.includes(value)) return '请选择列表中的选项或待确认。';
  if (field.type === 'date' || field.type === 'month') {
    const iso = field.type === 'month' ? `${value}-01` : value;
    const shape = field.type === 'month' ? /^\d{4}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/;
    if (!shape.test(value) || !Number.isFinite(Date.parse(iso)) || new Date(iso).toISOString().slice(0, 10) !== iso) {
      return '请填写有效日期。';
    }
    const y = Number(value.slice(0, 4));
    if (y < 1980 || y > maxYear()) return '日期超出合理范围。';
  }
  return '';
}

const CROSS_CHECKS = [
  ['gpa', 'gpaScale', '当前 GPA 不能超过 GPA 满分。'],
  ['academicRank', 'academicTotal', '学业排名不能超过专业总人数。'],
  ['comprehensiveRank', 'comprehensiveTotal', '综合测评排名不能超过综合测评总人数。'],
];

/**
 * 整表校验（原版 U2）。
 * @returns {{section:string, field:string, label:string, step:number, recordId?:string, message:string}[]}
 */
export function validateForm(form) {
  const errors = [];
  const add = (section, field, message, recordId) =>
    errors.push({ section: section.key, field: field.id, label: field.label, step: section.step, recordId, message });

  for (const section of SECTIONS) {
    const records = section.repeat ? form[section.key].filter((r) => recordHasContent(section, r)) : [form[section.key]];
    for (const record of records) {
      for (const field of section.fields) {
        const msg = validateField(field, record[field.id]);
        if (msg) add(section, field, msg, record.id);
      }
    }
  }
  const academics = SECTIONS.find((s) => s.key === 'academics');
  for (const [a, b, message] of CROSS_CHECKS) {
    const va = form.academics[a];
    const vb = form.academics[b];
    if (hasValue(va) && hasValue(vb) && Number.isFinite(Number(va)) && Number.isFinite(Number(vb)) && Number(va) > Number(vb)) {
      add(academics, academics.fields.find((f) => f.id === a), message);
    }
  }
  return errors;
}

/** 待确认信息列表（原版 l0），每项形如「科研经历 2 · 研究方向」 */
export function collectPending(form) {
  const list = [];
  for (const section of SECTIONS) {
    const records = section.repeat ? form[section.key] : [form[section.key]];
    records.forEach((record, i) => {
      for (const field of section.fields) {
        const v = record[field.id];
        if (typeof v === 'string' && PENDING_PATTERN.test(v)) {
          list.push(`${section.title}${section.repeat ? ` ${i + 1}` : ''} · ${field.label}`);
        }
      }
    });
    if (section.repeat && form.experienceStatus[section.key] === 'unsure') list.push(`${section.title} · 待确认`);
  }
  return list;
}

/** 必填项完成度（原版 ma）。step 省略时统计全表。 */
export function completion(form, step) {
  const sections = SECTIONS.filter((s) => step === undefined || s.step === step);
  const errors = validateForm(form);
  let total = 0;
  let completed = 0;
  for (const section of sections) {
    const records = section.repeat ? form[section.key].filter((r) => recordHasContent(section, r)) : [form[section.key]];
    for (const record of records) {
      for (const field of section.fields.filter((f) => f.required)) {
        total++;
        const hasError = errors.some((e) => e.section === section.key && e.field === field.id && e.recordId === record.id);
        if (hasValue(record[field.id]) && !hasError) completed++;
      }
    }
  }
  return { total, completed, percent: total ? Math.round((completed / total) * 100) : 100 };
}

/**
 * 解析 JSON 备份或本地草稿（原版 pa），校验失败抛出带中文说明的 Error。
 * 返回一份规范化后的新表单：未知字段被丢弃、缺失字段补空、非法条目 id 重新生成。
 */
export function parseBackup(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_BACKUP_BYTES) {
    throw new Error('备份文件超过 32 MB 上限。');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('文件不是有效的 JSON。');
  }
  if (!isPlainObject(data) || data.schemaVersion !== SCHEMA_VERSION || data.formType !== FORM_TYPE) {
    throw new Error('备份类型或版本不兼容，请选择本系统 1.0.0 版本导出的 JSON。');
  }
  const form = createEmptyForm();
  for (const k of ['createdAt', 'updatedAt']) {
    if (typeof data[k] !== 'string' || !Number.isFinite(Date.parse(data[k]))) throw new Error('备份中的时间格式无效。');
    form[k] = data[k];
  }

  function readFields(section, src) {
    if (!isPlainObject(src)) throw new Error(`${section.title}的数据格式不正确。`);
    const out = emptyFields(section);
    for (const f of section.fields) {
      const v = src[f.id];
      if (v === undefined) continue;
      if (f.type === 'checkbox') {
        if (typeof v !== 'boolean') throw new Error(`${f.label}应为确认状态。`);
      } else if (f.type === 'multiselect') {
        if (!Array.isArray(v) || v.length > f.options.length || v.some((o) => !f.options.includes(o)) || new Set(v).size !== v.length) {
          throw new Error(`${f.label}的选项无效。`);
        }
      } else {
        if (!(typeof v === 'string' || (f.type === 'number' && typeof v === 'number' && Number.isFinite(v)))) {
          throw new Error(`${f.label}的数据类型无效。`);
        }
        if (String(v).length > f.maxLength) throw new Error(`${f.label}内容过长。`);
        if (CONTROL_CHARS.test(String(v))) throw new Error(`${f.label}包含不支持的控制字符。`);
      }
      out[f.id] = v;
    }
    return out;
  }

  for (const section of SECTIONS) {
    if (section.repeat) {
      const list = data[section.key];
      if (!Array.isArray(list) || list.length > MAX_RECORDS) throw new Error(`${section.title}应为不超过 ${MAX_RECORDS} 条的列表。`);
      const seen = new Set();
      form[section.key] = list.map((item) => {
        const fields = readFields(section, item);
        const id = typeof item.id === 'string' && /^[\w-]{1,80}$/.test(item.id) && !seen.has(item.id) ? item.id : newId();
        seen.add(id);
        return { id, ...fields };
      });
      const status = data.experienceStatus?.[section.key];
      if (status !== undefined && !['none', 'unsure', ''].includes(status)) throw new Error('经历状态格式不正确。');
      form.experienceStatus[section.key] = status || '';
      if (status === 'none' && form[section.key].some((r) => recordHasContent(section, r))) {
        throw new Error(`${section.title}同时标记暂无并含有记录，请检查备份。`);
      }
    } else {
      if (!isPlainObject(data[section.key])) throw new Error(`备份缺少${section.title}模块。`);
      form[section.key] = readFields(section, data[section.key]);
    }
  }
  return form;
}
