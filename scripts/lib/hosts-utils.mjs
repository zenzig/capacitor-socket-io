function normaliseContent(value) {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value !== 'string') {
    return String(value);
  }

  return value;
}

export function extractHostIps(originalContent, host) {
  const content = normaliseContent(originalContent);
  if (!host) {
    return [];
  }

  const lines = content.split(/\r?\n/);
  const ips = new Set();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const tokens = line.split(/\s+/);
    if (tokens.includes(host) && tokens[0]) {
      ips.add(tokens[0]);
    }
  }

  return [...ips];
}

export function computeHostsUpdate({ originalContent, host, ip }) {
  if (!host) {
    throw new Error('Host is required');
  }

  if (!ip) {
    throw new Error('IP address is required');
  }

  const content = normaliseContent(originalContent);
  const newline = '\n';
  const lines = content.split(/\r?\n/);
  const preserved = [];
  const previousIps = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      preserved.push(line);
      continue;
    }

    if (trimmed.startsWith('#')) {
      preserved.push(line);
      continue;
    }

    const tokens = trimmed.split(/\s+/);
    if (tokens.includes(host)) {
      if (tokens[0]) {
        previousIps.push(tokens[0]);
      }
      continue;
    }

    preserved.push(line);
  }

  const cleaned = dropTrailingBlankLines(preserved);
  cleaned.push(`${ip} ${host}`);

  let updatedContent = cleaned.join(newline);
  if (!updatedContent.endsWith(newline)) {
    updatedContent += newline;
  }

  const normalisedOriginal = ensureTrailingNewline(normaliseLineEndings(content), newline);
  const changed = normalisedOriginal !== updatedContent;

  return {
    content: updatedContent,
    changed,
    previousIps: [...new Set(previousIps.filter(Boolean))],
  };
}

function dropTrailingBlankLines(lines) {
  const result = [...lines];
  while (result.length > 0 && result[result.length - 1].trim() === '') {
    result.pop();
  }
  return result;
}

function normaliseLineEndings(value) {
  return value.replace(/\r?\n/g, '\n');
}

function ensureTrailingNewline(value, newline) {
  if (!value.endsWith('\n')) {
    return `${value}${newline}`;
  }
  return value.replace(/\n$/, newline);
}
