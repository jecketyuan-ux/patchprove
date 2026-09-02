const enabled =
  Boolean(process.stdout.isTTY) &&
  process.env.NO_COLOR !== "1" &&
  process.env.TERM !== "dumb";

function wrap(code: string, s: string): string {
  return enabled ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export const color = {
  bold: (s: string) => wrap("1", s),
  dim: (s: string) => wrap("2", s),
  red: (s: string) => wrap("31", s),
  green: (s: string) => wrap("32", s),
  yellow: (s: string) => wrap("33", s),
  blue: (s: string) => wrap("34", s),
  magenta: (s: string) => wrap("35", s),
  cyan: (s: string) => wrap("36", s),
};
