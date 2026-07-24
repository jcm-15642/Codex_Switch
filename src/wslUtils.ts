export interface WslDistribution {
  name: string;
  isDefault: boolean;
}

/** Decode WSL's UTF-16 console output as well as ordinary UTF-8 output. */
export function decodeWslOutput(output: Buffer): string {
  if (output.includes(0)) {
    return output.toString('utf16le').replace(/^\uFEFF/, '');
  }
  return output.toString('utf8').replace(/^\uFEFF/, '');
}

/** Parse `wsl.exe --list --verbose` without depending on localized column headings. */
export function parseWslDistributions(output: string): WslDistribution[] {
  const distributions: WslDistribution[] = [];
  for (const rawLine of output.replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    if (!line || !/\s{2,}/.test(line)) {
      continue;
    }
    const columns = line.split(/\s{2,}/);
    if (columns.length < 3 || !/^\d+$/.test(columns.at(-1) ?? '')) {
      continue;
    }
    const firstColumn = columns[0].trim();
    const isDefault = firstColumn.startsWith('*');
    const name = firstColumn.replace(/^\*\s*/, '').trim();
    if (name) {
      distributions.push({ name, isDefault });
    }
  }
  return distributions;
}
