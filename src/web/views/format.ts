export function formatTimestamp(value: number | null): string {
  if (value === null) return "-";
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value * 1000));
}

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(cents / 100);
}
