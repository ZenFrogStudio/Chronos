import { ERROR_MAX_CHARS } from './types';

export function nowUtc(): string {
  return new Date().toISOString();
}

export function toUtc(date: Date): string {
  return date.toISOString();
}

export function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

export function truncateError(text: string): string {
  return truncate(text, ERROR_MAX_CHARS);
}
