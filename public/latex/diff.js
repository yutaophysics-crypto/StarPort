// The new text's lines that are not in the old one: common lines at both ends are skipped and the
// middle is compared line by line, so an edit at the top and one at the bottom light only those.
export function changedLines(before, after) {
  const a = before.split('\n'), b = after.split('\n');
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const A = a.slice(start, endA), B = b.slice(start, endB), n = A.length, m = B.length;
  if (!m) return start < b.length ? [start + 1] : [b.length];
  if (n * m > 250000) return B.map((_, j) => start + j + 1);
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i][j] = A[i] === B[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const out = [];
  for (let i = 0, j = 0; j < m;) {
    if (i < n && A[i] === B[j]) { i++; j++; }
    else if (i < n && table[i + 1][j] >= table[i][j + 1]) i++;
    else out.push(start + ++j);
  }
  return out;
}
