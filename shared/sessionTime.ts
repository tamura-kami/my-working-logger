export const DAY_MS = 86400000;
const JST = 9 * 3600000;
export const sessionDate = (time: number) => new Date(time + JST).toISOString().slice(0, 10);
export const dateStart = (date: string) => Date.parse(`${date}T00:00:00+09:00`);
export const shiftDate = (date: string, days: number) => sessionDate(dateStart(date) + days * DAY_MS);
export const editTime = (time: number) => new Date(time + JST).toISOString().slice(0, 23);
export const parseTime = (value: string) => Date.parse(`${value}+09:00`);
export const validSession = (start: number, end: number, paused: number) =>
  [start, end, paused].every(Number.isSafeInteger) && start >= 0 && end <= 8640000000000000 && paused >= 0 && end - start - paused >= 1000;
