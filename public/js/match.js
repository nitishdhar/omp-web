"use strict";
// The app's one fuzzy matcher, shared by the command palette and sidebar
// search so a query finds the same things in both. Pure: no state, no DOM.

// Subsequence match, not substring: "owm" finds "Omp Web Main" the way a
// terminal user expects, and the score prefers earlier, tighter runs.
export function score(haystack, needle) {
  if (!needle) return 0;
  const hay = haystack.toLowerCase();
  const term = needle.toLowerCase();
  let index = 0;
  let first = -1;
  let gaps = 0;
  let last = -1;
  for (const ch of term) {
    index = hay.indexOf(ch, index);
    if (index === -1) return null;
    if (first === -1) first = index;
    if (last !== -1 && index > last + 1) gaps += index - last - 1;
    last = index;
    index += 1;
  }
  return first + gaps;
}
