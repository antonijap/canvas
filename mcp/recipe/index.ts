import fs from 'node:fs';

export const topics = ['taste', 'feed', 'onboarding', 'permission', 'paywall', 'settings', 'profile', 'search', 'checkout', 'website', 'dashboard', 'checks', 'all'] as const;
export type Topic = typeof topics[number];
const rules = fs.readFileSync(new URL('./rules.md', import.meta.url), 'utf8');
const taste = rules.slice(rules.indexOf('## Taste'), rules.indexOf('## 1.'));
const checks = rules.slice(rules.indexOf('## 7.'));
const recipes = rules.slice(rules.indexOf('### 6.1 '), rules.indexOf('## 7.')).split(/(?=^### 6\.)/m);
const lines = rules.split('\n').filter(l => /^- `R-/.test(l));

export function getRecipe(topic: Topic = 'all'): string {
  if (topic === 'all') return rules;
  if (topic === 'taste') return taste;
  if (topic === 'checks') return taste + checks;
  const recipe = recipes[topics.indexOf(topic) - 1];
  if (!recipe) throw new Error('Unknown recipe topic');
  const ids = new Set(recipe.match(/R-\d+-\d+/g));
  for (const m of recipe.matchAll(/R-(\d+)-(\d+) to R-\1-(\d+)/g)) {
    for (let n = Number(m[2]); n <= Number(m[3]); n++) ids.add(`R-${m[1]}-${n}`);
  }
  const selected = lines.filter(l => ids.has(l.match(/R-\d+-\d+/)![0]));
  const checkIds = new Set(selected.flatMap(l => l.match(/R-7-\d+/g) ?? []));
  return [taste, recipe, '## Referenced rules', ...selected.filter(l => !recipe.includes(l)), '## Referenced checks', ...lines.filter(l => checkIds.has(l.match(/R-\d+-\d+/)![0]))].join('\n\n');
}
