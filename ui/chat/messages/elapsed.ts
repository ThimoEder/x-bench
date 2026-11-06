export function formatElapsed(ms: unknown): string {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return minutes ? `${hours}h${minutes}m` : `${hours}h`;
  if (minutes) return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}
