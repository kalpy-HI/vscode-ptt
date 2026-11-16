import type { SearchCondition } from './types';

export type SearchType = SearchCondition['type'];

export const SEARCH_TYPES: { type: SearchType; label: string; detail: string; prompt: string; placeHolder: string }[] = [
  {
    type: 'title',
    label: '$(search) 標題關鍵字',
    detail: '找標題含有關鍵字的文章，例如：閒聊、[問卦]、心得',
    prompt: '輸入標題關鍵字',
    placeHolder: '例如：閒聊'
  },
  {
    type: 'author',
    label: '$(person) 作者',
    detail: '找某個帳號發的文章',
    prompt: '輸入作者 ID',
    placeHolder: '例如：kalpy'
  },
  {
    type: 'push',
    label: '$(flame) 推文數',
    detail: '找推文數達到門檻的文章（0 ~ 100，100 代表「爆」）',
    prompt: '輸入推文數下限',
    placeHolder: '0 ~ 100'
  }
];

/** Returns an error message for invalid input, or null when it is acceptable. */
export function validateSearchInput(type: SearchType, raw: string): string | null {
  const value = raw.trim();
  if (!value) {
    return '請輸入內容';
  }
  switch (type) {
    case 'title':
      return value.length > 40 ? '關鍵字太長（最多 40 個字）' : null;
    case 'author':
      return /^[A-Za-z0-9]{2,12}$/.test(value) ? null : 'PTT 帳號只能是 2~12 個英數字';
    case 'push': {
      const n = Number(value);
      return Number.isInteger(n) && n >= 0 ? null : '請輸入 0 以上的整數';
    }
  }
}

/** Normalises user input into a condition (push is clamped to 100, PTT's 爆). */
export function toSearchCondition(type: SearchType, raw: string): SearchCondition {
  const value = raw.trim();
  if (type === 'push') {
    return { type, criteria: String(Math.min(100, Math.max(0, Math.floor(Number(value))))) };
  }
  return { type, criteria: value };
}

export function describeCondition(condition: SearchCondition): string {
  switch (condition.type) {
    case 'title':
      return `標題「${condition.criteria}」`;
    case 'author':
      return `作者 ${condition.criteria}`;
    case 'push':
      return condition.criteria === '100' ? '推文 爆' : `推文 ≥ ${condition.criteria}`;
  }
}

export function describeSearch(conditions: SearchCondition[]): string {
  return conditions.map(describeCondition).join('、');
}

/** Adds a condition, replacing an earlier one of the same type (PTT ANDs them otherwise). */
export function addCondition(existing: SearchCondition[], next: SearchCondition): SearchCondition[] {
  return [...existing.filter(c => c.type !== next.type), next];
}
