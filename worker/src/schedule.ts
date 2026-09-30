// The school clock. Study needs to know which block is running right now so it
// can show "Study Hall - A Block 8:25-9:30" and decide when a student's name
// should appear as available.
//
// The day type and the bell times are not invented here. They come from the
// same published files the Hilltoppers extension reads:
//   https://hilltoppers.pages.dev/day_type.json      (Green / White / No School)
//   https://hilltoppers.pages.dev/special_days.json  (holidays, custom days)
// The bell times themselves are copied from the extension's own schedule files
// (chrome-extension/public/schedule/*.json in daniezl/Hilltoppers). If the
// school changes a bell time, this copy has to change with it.

const SOURCE = 'https://hilltoppers.pages.dev';
const TIME_ZONE = 'America/New_York';

export interface Block {
  letter: string;
  name: string;
  start: string;
  end: string;
}

export interface DaySchedule {
  dateKey: string;
  dayType: string;
  blocks: Block[];
}

// Bell times, copied verbatim from the extension's schedule files. Only the
// lettered blocks and CP matter here; Chapel, Advisory and lunch are not study
// halls.
const MON_THU: Block[] = [
  { letter: 'A', name: 'A Block', start: '08:25', end: '09:30' },
  { letter: 'B', name: 'B Block', start: '09:35', end: '10:40' },
  { letter: 'C', name: 'C Block', start: '10:45', end: '12:20' },
  { letter: 'D', name: 'D Block', start: '12:25', end: '13:30' },
  { letter: 'E', name: 'E Block', start: '13:35', end: '14:40' },
  { letter: 'CP', name: 'CP', start: '14:45', end: '15:05' }
];

const WED: Block[] = [
  { letter: 'A', name: 'A Block', start: '08:25', end: '09:30' },
  { letter: 'B', name: 'B Block', start: '09:35', end: '10:40' },
  { letter: 'C', name: 'C Block', start: '10:45', end: '12:20' },
  { letter: 'D', name: 'D Block', start: '12:25', end: '13:30' },
  { letter: 'E', name: 'E Block', start: '13:35', end: '14:40' },
  { letter: 'CP', name: 'CP', start: '14:45', end: '15:05' }
];

const FRI: Block[] = [
  { letter: 'A', name: 'A Block', start: '08:20', end: '09:20' },
  { letter: 'B', name: 'B Block', start: '09:25', end: '10:25' },
  { letter: 'C', name: 'C Block', start: '11:05', end: '12:40' },
  { letter: 'D', name: 'D Block', start: '12:45', end: '13:45' },
  { letter: 'E', name: 'E Block', start: '13:50', end: '14:50' },
  { letter: 'CP', name: 'CP', start: '14:55', end: '15:15' }
];

const ABDEC: Block[] = [
  { letter: 'A', name: 'A Block', start: '08:00', end: '08:45' },
  { letter: 'B', name: 'B Block', start: '08:50', end: '09:35' },
  { letter: 'D', name: 'D Block', start: '09:40', end: '10:25' },
  { letter: 'E', name: 'E Block', start: '10:30', end: '11:15' },
  { letter: 'C', name: 'C Block', start: '11:20', end: '12:50' }
];

const LATE_START: Block[] = [
  { letter: 'A', name: 'A Block', start: '10:00', end: '10:40' },
  { letter: 'B', name: 'B Block', start: '10:45', end: '11:25' },
  { letter: 'C', name: 'C Block', start: '11:30', end: '13:05' },
  { letter: 'D', name: 'D Block', start: '13:10', end: '13:50' },
  { letter: 'E', name: 'E Block', start: '13:55', end: '14:35' },
  { letter: 'CP', name: 'CP', start: '14:40', end: '15:00' }
];

// Everything a student may mark as a study hall.
export const STUDY_BLOCK_LETTERS = ['A', 'B', 'C', 'D', 'E', 'CP'];

function letterOf(name: string): string {
  const match = /^([A-E]) Block$/.exec(name.trim());
  if (match) return match[1];
  if (/^CP$/i.test(name.trim())) return 'CP';
  return '';
}

function toBlocks(schedule: Array<{ name?: unknown; start?: unknown; end?: unknown }>): Block[] {
  const blocks: Block[] = [];
  for (const entry of schedule) {
    const name = typeof entry?.name === 'string' ? entry.name : '';
    const start = typeof entry?.start === 'string' ? entry.start : '';
    const end = typeof entry?.end === 'string' ? entry.end : '';
    if (!name || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) continue;
    blocks.push({ letter: letterOf(name), name, start, end });
  }
  return blocks;
}

function zonedParts(now: Date): { dateKey: string; weekday: string; minutes: number } {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts: Record<string, string> = {};
  for (const part of format.formatToParts(now)) parts[part.type] = part.value;
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    minutes: Number(hour) * 60 + Number(parts.minute)
  };
}

function minutesOf(time: string): number {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

async function getJson(path: string): Promise<unknown> {
  try {
    const response = await fetch(`${SOURCE}/${path}`, { signal: AbortSignal.timeout(6000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function byWeekday(weekday: string): Block[] {
  if (weekday === 'Wed') return WED;
  if (weekday === 'Fri') return FRI;
  return MON_THU;
}

export async function loadDaySchedule(now: Date): Promise<DaySchedule> {
  const { dateKey, weekday } = zonedParts(now);
  if (weekday === 'Sat' || weekday === 'Sun') return { dateKey, dayType: 'No School', blocks: [] };

  const [specialDays, dayType] = await Promise.all([
    getJson('special_days.json'),
    getJson('day_type.json')
  ]);

  const special = (specialDays as Record<string, { type?: string; schedule?: unknown }> | null)?.[dateKey];
  if (special?.type === 'no_school') return { dateKey, dayType: 'No School', blocks: [] };
  if (special?.type === 'custom' && Array.isArray(special.schedule)) {
    return { dateKey, dayType: 'Special schedule', blocks: toBlocks(special.schedule as never[]) };
  }

  const days = (dayType as { days?: Record<string, string> } | null)?.days;
  const label = days?.[dateKey];
  if (label === 'No School') return { dateKey, dayType: 'No School', blocks: [] };

  return { dateKey, dayType: label ?? 'School Day', blocks: byWeekday(weekday) };
}

// The block containing `now`, or null between blocks and after the last one.
export function blockAt(schedule: DaySchedule, now: Date): Block | null {
  const { minutes } = zonedParts(now);
  for (const block of schedule.blocks) {
    if (minutes >= minutesOf(block.start) && minutes < minutesOf(block.end)) return block;
  }
  return null;
}

export type Availability = 'study-hall' | 'in-class' | 'after-school' | 'no-school';

export function availability(schedule: DaySchedule, studyBlocks: string[], now: Date): Availability {
  if (schedule.blocks.length === 0) return 'no-school';
  const current = blockAt(schedule, now);
  if (!current) return 'after-school';
  return current.letter && studyBlocks.includes(current.letter) ? 'study-hall' : 'in-class';
}
