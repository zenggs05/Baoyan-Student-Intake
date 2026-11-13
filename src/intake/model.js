// 学员信息采集 · 文档模型
// buildDocument() 与原版 Wt() 输出结构一致（用于页面内预览）；
// buildReport() 是在其基础上扩展的「学员档案」模型，Word 导出与打印报告共用，保证两者版式一致。
import { SECTIONS, SECTION_BY_KEY, PENDING } from './schema.js';
import { hasValue, filledRecords } from './form.js';
import { validateForm, collectPending, completion } from './validate.js';

export const DOCUMENT_TITLE = '保研全程陪跑｜学员基本信息档案';
export const REPORT_HEADER = '保研全程陪跑 · 学员档案';
export const EMPTY_TEXT = '未填写';

/** 字段值转展示文字（原版 Pn） */
export function formatValue(value, type) {
  if (type === 'checkbox') return value ? '已确认' : '未确认';
  if (Array.isArray(value)) return value.length ? value.join('、') : EMPTY_TEXT;
  return hasValue(value) ? String(value) : EMPTY_TEXT;
}

/** 时间戳转本地时间（原版 Tn） */
export const formatTime = (iso) => new Date(iso).toLocaleString('zh-CN', { hour12: false });

/** 原版文档模型（原版 Wt） */
export function buildDocument(form) {
  const s = form.student;
  return {
    title: DOCUMENT_TITLE,
    metadata: `学员：${formatValue(s.displayName)}　学校：${formatValue(s.university)}\n填表日期：${formatValue(s.formDate)}　最后更新：${formatTime(form.updatedAt)}`,
    notice: `本档案由学员自行填写；院校定位分析不代表录取保证。待确认信息 ${collectPending(form).length} 项，未完成或需修正 ${validateForm(form).length} 项。`,
    sections: SECTIONS.map((section) => {
      const rows = (record) => section.fields.map((f) => ({ label: f.label, value: formatValue(record[f.id], f.type) }));
      const records = section.repeat ? filledRecords(form, section) : null;
      const status = form.experienceStatus[section.key];
      return {
        key: section.key,
        title: section.title,
        step: section.step,
        groups: section.repeat
          ? records.map((r, i) => ({ title: `${section.itemName} ${i + 1}`, rows: rows(r) }))
          : [{ title: '', rows: rows(form[section.key]) }],
        empty:
          section.repeat && records.length === 0
            ? status === 'none' ? `暂无${section.title}` : status === 'unsure' ? '待确认' : '未填写经历记录'
            : '',
      };
    }),
  };
}

/** 导出文件名（原版 Rn）：申请年份_学校_称呼_保研基本信息表.扩展名 */
export function exportFileName(form, ext) {
  const part = (v) =>
    String(v || '未填写')
      .normalize('NFC')
      .replace(/[<>:"/\\|?*\x00-\x1F\x7F]/g, '_')
      .replace(/[. ]+$/g, '')
      .slice(0, 40) || '未填写';
  return [form.student.applicationYear, form.student.university, form.student.displayName, '保研基本信息表'].map(part).join('_') + '.' + ext;
}

/* ------------------------------------------------------------------ */
/* 学员档案模型（Word / 打印报告共用）                                    */
/* ------------------------------------------------------------------ */

/**
 * 单元格状态：empty = 未填写（灰色斜体），pending = 值含「待确认」（琥珀底纹）。
 * 注意：概览里的「待确认信息」数量沿用原版 l0 规则（还包括「不确定」「无法判断」等），
 * 因此另外附上完整的待确认清单，避免读者对不上数。
 */
function cellState(raw, type) {
  if (type === 'checkbox') return raw ? '' : 'empty';
  if (!hasValue(raw)) return 'empty';
  if (typeof raw === 'string' && raw.includes(PENDING)) return 'pending';
  return '';
}

const pair = (a, b) => {
  if (!hasValue(a) && !hasValue(b)) return EMPTY_TEXT;
  return `${hasValue(a) ? a : '—'} / ${hasValue(b) ? b : '—'}`;
};

function countText(form, key, unit) {
  const n = filledRecords(form, SECTION_BY_KEY[key]).length;
  if (n) return `${n} ${unit}`;
  const status = form.experienceStatus[key];
  return status === 'none' ? '暂无' : status === 'unsure' ? '待确认' : EMPTY_TEXT;
}

function targetSchools(form) {
  const names = filledRecords(form, SECTION_BY_KEY.targetPrograms)
    .map((r) => String(r.university || '').trim())
    .filter(Boolean);
  const unique = [...new Set(names)];
  if (!unique.length) return form.experienceStatus.targetPrograms === 'unsure' ? '待确认' : EMPTY_TEXT;
  return unique.length > 4 ? `${unique.slice(0, 4).join('、')} 等 ${unique.length} 所` : unique.join('、');
}

/**
 * @returns {{
 *   title:string, brand:string, heading:string, header:string, notice:string, fileBase:string,
 *   info:{label:string,value:string,state:string}[],
 *   overview:{percent:number, pendingCount:number, pendingItems:string[], errorCount:number, metrics:{label:string,value:string,state:string}[]},
 *   sections:{key:string, no:string, title:string, description:string, empty:string, emptyState:string,
 *             groups:{title:string, rows:{label:string,value:string,state:string,multiline:boolean}[]}[]}[]
 * }}
 */
export function buildReport(form) {
  const s = form.student;
  const pending = collectPending(form);
  const errors = validateForm(form);
  const done = completion(form);
  const cell = (label, raw, type) => ({ label, value: formatValue(raw, type), state: cellState(raw, type) });
  const metric = (label, value) => ({
    label,
    value,
    state: value === EMPTY_TEXT ? 'empty' : value.includes(PENDING) ? 'pending' : '',
  });

  const [brand, heading] = DOCUMENT_TITLE.split('｜');
  return {
    title: DOCUMENT_TITLE,
    brand,
    heading,
    header: REPORT_HEADER,
    notice: '本档案由学员本人填写，仅供辅导老师了解背景使用；院校定位分析不代表录取保证。请妥善保管，勿转发给无关人员。',
    info: [
      cell('称呼', s.displayName),
      cell('学校', s.university),
      cell('学院', s.college),
      cell('专业', s.major),
      cell('年级', s.grade),
      cell('填表日期', s.formDate),
      { label: '最后更新', value: formatTime(form.updatedAt), state: '' },
    ],
    overview: {
      percent: done.percent,
      pendingCount: pending.length,
      pendingItems: pending,
      errorCount: errors.length,
      metrics: [
        metric('GPA', pair(form.academics.gpa, form.academics.gpaScale)),
        metric('学业排名', pair(form.academics.academicRank, form.academics.academicTotal)),
        metric('CET-4 / CET-6', pair(form.english.cet4, form.english.cet6)),
        metric('科研项目', countText(form, 'researchProjects', '项')),
        metric('论文', countText(form, 'publications', '篇')),
        metric('目标院校', targetSchools(form)),
      ],
    },
    sections: SECTIONS.map((section, index) => {
      const rows = (record) =>
        section.fields.map((f) => ({
          ...cell(f.label, record[f.id], f.type),
          multiline: f.type === 'textarea',
        }));
      const base = { key: section.key, no: String(index + 1).padStart(2, '0'), title: section.title, description: section.description };
      if (!section.repeat) return { ...base, empty: '', emptyState: '', groups: [{ title: '', rows: rows(form[section.key]) }] };

      const records = filledRecords(form, section);
      const status = form.experienceStatus[section.key];
      const nameField = section.fields[0];
      return {
        ...base,
        groups: records.map((r, i) => {
          const name = hasValue(r[nameField.id]) ? String(r[nameField.id]).trim() : '';
          return { title: `${section.itemName} ${i + 1}${name ? ` · ${name}` : ''}`, rows: rows(r) };
        }),
        empty: records.length
          ? ''
          : status === 'none'
            ? `学员已确认：暂无${section.title}。`
            : status === 'unsure'
              ? `${section.title}情况待确认，后续补充。`
              : `尚未填写${section.itemName}记录。`,
        emptyState: records.length ? '' : status === 'unsure' ? 'pending' : status === 'none' ? '' : 'empty',
      };
    }),
  };
}
