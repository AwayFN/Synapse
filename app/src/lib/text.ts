/** Lowercase + strip accents, for search & matching */
export function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

export function wordCount(s: string): number {
  const m = s.trim().match(/\S+/g);
  return m ? m.length : 0;
}

export function excerpt(s: string, n = 120): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export function normalizeTag(t: string): string {
  return norm(t.replace(/^#+/, '')).replace(/[^a-z0-9_\-/]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Simple fuzzy score: 0 = no match; higher = better */
export function matchScore(query: string, text: string): number {
  const q = norm(query);
  const t = norm(text);
  if (!q) return 1;
  if (!t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const words = t.split(/[\s\-_/:·]+/);
  if (words.some((w) => w.startsWith(q))) return 60;
  if (t.includes(q)) return 40;
  // subsequence
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i++;
    if (i === q.length) return 10;
  }
  return 0;
}
