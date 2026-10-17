import { OTHER_OUTLETS } from './podcastScript.js';

export const REQUIRED_SECTIONS = [
  '本紙の性格',
  '関心トピックの重み',
  '情報源の信頼度ティア',
  '新規性の要件',
  '良い選定の例',
  '悪い選定の例',
] as const;

export const CONSTITUTION_SECTIONS = [
  '本紙の性格',
  '関心トピックの重み',
  '情報源の信頼度ティア',
] as const;

export const MIN_LENGTH_RATIO = 0.6;

export function splitSections(profile: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current !== null) sections.set(current, buffer.join('\n').trim());
  };
  for (const line of profile.split('\n')) {
    if (/^[^\s#\-].*[:：]\s*$/.test(line)) {
      flush();
      current = line.replace(/[:：]\s*$/, '').trim();
      buffer = [];
    } else if (current !== null) {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

function matches(sectionName: string, wanted: string): boolean {
  return sectionName.startsWith(wanted);
}

export function validateProfile(next: string, current: string): string[] {
  const problems: string[] = [];
  const sections = [...splitSections(next).keys()];

  for (const required of REQUIRED_SECTIONS) {
    if (!sections.some((s) => matches(s, required))) {
      problems.push(
        `必須の項目が消えています（${required}）。`
        + 'この項目は記事の採点と執筆の土台なので、欠けると紙面の質が静かに落ちます',
      );
    }
  }

  if (current.trim().length > 0 && next.trim().length < current.trim().length * MIN_LENGTH_RATIO) {
    const pct = Math.round((next.trim().length / current.trim().length) * 100);
    problems.push(
      `元の編集方針の${pct}%まで短くなっています。`
      + '「直したつもりが要約になっていた」可能性があります',
    );
  }

  const outlets = OTHER_OUTLETS.filter((n) => next.includes(n));
  if (outlets.length > 0) {
    problems.push(
      `実在の媒体名が含まれています（${outlets.join('・')}）。`
      + '編集方針は記事の執筆や音声台本を書くモデルにもそのまま渡るため、'
      + '書いた媒体名が紙面や番組に現れることがあります。'
      + '媒体は「専門業界紙」「海外の地域メディア」のように性質で書いてください',
    );
  }
  return problems;
}

export function touchedConstitution(next: string, current: string): string[] {
  const a = splitSections(current);
  const b = splitSections(next);
  const touched: string[] = [];
  for (const wanted of CONSTITUTION_SECTIONS) {
    const nameA = [...a.keys()].find((s) => matches(s, wanted));
    const nameB = [...b.keys()].find((s) => matches(s, wanted));
    const before = nameA ? a.get(nameA) : undefined;
    const after = nameB ? b.get(nameB) : undefined;
    if (before !== after) touched.push(wanted);
  }
  return touched;
}

export function constitutionDiff(
  next: string,
  current: string,
): Array<{ section: string; before: string; after: string }> {
  const a = splitSections(current);
  const b = splitSections(next);
  return touchedConstitution(next, current).map((wanted) => {
    const nameA = [...a.keys()].find((s) => matches(s, wanted));
    const nameB = [...b.keys()].find((s) => matches(s, wanted));
    return {
      section: wanted,
      before: (nameA ? a.get(nameA) : '') ?? '',
      after: (nameB ? b.get(nameB) : '') ?? '',
    };
  });
}

export interface ProfileSection {
  name: string;
  body: string;
  isConstitution: boolean;
}

export function describeProfile(content: string): { chars: number; sections: ProfileSection[] } {
  const sections = [...splitSections(content)].map(([name, body]) => ({
    name,
    body,
    isConstitution: CONSTITUTION_SECTIONS.some((c) => matches(name, c)),
  }));
  return { chars: content.length, sections };
}
