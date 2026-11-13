// 学员信息采集 · 本地草稿（localStorage）
// 存储键与数据结构与原版完全一致（原版 Ka / Na / va / xF / WF），老草稿可直接读取。
import { parseBackup } from './validate.js';
import { createEmptyForm, clone } from './form.js';

export const STORAGE_KEY = 'baoyan-student-intake:v1';

/** 读取已保存的草稿；没有草稿返回 null，草稿损坏时抛出 Error */
export function loadDraft(store = localStorage) {
  const raw = store.getItem(STORAGE_KEY);
  return raw ? parseBackup(raw) : null;
}

/** 保存整份草稿 */
export function saveDraft(form, store = localStorage) {
  store.setItem(STORAGE_KEY, JSON.stringify(form));
}

/**
 * 只把某一条经历写入已保存的草稿（原版「保存本条到本地草稿」）。
 * 其他条目保持草稿中的旧值；当前页面已删除的条目也会从草稿中移除。
 */
export function saveRecord(form, section, recordId, store = localStorage) {
  const draft = loadDraft(store) || createEmptyForm();
  const saved = new Map(draft[section.key].map((r) => [r.id, r]));
  draft[section.key] = form[section.key].flatMap((r) =>
    r.id === recordId ? [clone(r)] : saved.has(r.id) ? [saved.get(r.id)] : [],
  );
  draft.experienceStatus[section.key] = form.experienceStatus[section.key] || '';
  draft.createdAt = form.createdAt;
  draft.updatedAt = form.updatedAt;
  saveDraft(draft, store);
}

/** 删除草稿 */
export function clearDraft(store = localStorage) {
  store.removeItem(STORAGE_KEY);
}
