export type Theme = "light" | "dark";

export function resolveTheme(value: string | undefined): Theme {
  return value === "dark" ? "dark" : "light";
}
