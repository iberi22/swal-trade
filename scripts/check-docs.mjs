import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Normalizes and extracts valid repository references from Markdown content.
 * @param {string} markdown - The markdown content.
 * @param {string} mdFilePath - Path of the markdown file relative to the repo root.
 * @returns {string[]} List of normalized references relative to the repo root.
 */
export function extractRefs(markdown, mdFilePath = '') {
  const refs = new Set();
  const mdDir = mdFilePath ? path.dirname(mdFilePath) : '';

  // Function to add a ref, normalizing it relative to repo root
  const addRef = (ref, isBacktick) => {
    if (ref.startsWith('http://') || ref.startsWith('https://') || ref.startsWith('#') || ref.includes('*') || ref.includes('<')) {
      return;
    }

    let normalizedRef = ref;
    if (!isBacktick) {
        // Link references are often relative to the markdown file
        // Unless they start with / which means relative to repo root
        if (ref.startsWith('/')) {
            normalizedRef = ref.slice(1);
        } else {
            if (mdDir && mdDir !== '.') {
                 normalizedRef = path.join(mdDir, ref);
            } else {
                 normalizedRef = ref;
            }
        }
    }

    // Handle backticked paths according to the prompt
    // "backticked repo paths that start with one of apps/ packages/ workers/ scripts/ docs/ radar/ crates/ e2e/"
    if (isBacktick) {
        const validPrefixes = ['apps/', 'packages/', 'workers/', 'scripts/', 'docs/', 'radar/', 'crates/', 'e2e/'];
        if (!validPrefixes.some(prefix => normalizedRef.startsWith(prefix))) {
            return;
        }
    }

    refs.add(normalizedRef);
  };

  // Strip fenced code blocks to avoid extracting from them
  // The prompt said "skip inline code fenced blocks" possibly meaning "skip fenced code blocks".
  const noFenced = markdown.replace(/```[\s\S]*?```/g, '');

  // Extract Markdown links [text](path)
  const linkRegex = /\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = linkRegex.exec(noFenced)) !== null) {
      addRef(match[1], false);
  }

  // Extract backticked repo paths `path`
  const backtickRegex = /`([^`]+)`/g;
  while ((match = backtickRegex.exec(noFenced)) !== null) {
      addRef(match[1], true);
  }

  return Array.from(refs);
}

/**
 * Checks if a reference is valid against tracked files.
 * @param {string} ref - The reference path relative to repo root.
 * @param {Set<string>|string[]} trackedFiles - List of git ls-files.
 * @returns {boolean} True if the reference is valid.
 */
export function isValidRef(ref, trackedFiles) {
  const files = trackedFiles instanceof Set ? trackedFiles : new Set(trackedFiles);
  if (files.has(ref)) return true;

  // A directory path is valid when any tracked file starts with it
  let dirPrefix = ref;
  if (!dirPrefix.endsWith('/')) {
      dirPrefix += '/';
  }
  for (const file of files) {
      if (file.startsWith(dirPrefix)) {
          return true;
      }
  }
  return false;
}

function getTrackedFiles() {
    try {
        const output = execFileSync('git', ['ls-files'], { encoding: 'utf-8' });
        return output.split('\n').filter(Boolean);
    } catch (e) {
        console.error("Failed to run git ls-files", e);
        process.exit(1);
    }
}

function getTrackedMarkdownFiles() {
    try {
        const output = execFileSync('git', ['ls-files', '*.md'], { encoding: 'utf-8' });
        return output.split('\n').filter(Boolean);
    } catch (e) {
        console.error("Failed to run git ls-files '*.md'", e);
        process.exit(1);
    }
}

// Ensure the module doesn't execute as main when running tests
// `process.argv[1]` can vary, checking if it ends with check-docs.mjs
const isMain = process.argv[1] && process.argv[1].endsWith('check-docs.mjs');

if (isMain) {
    const isUpdateBaseline = process.argv.includes('--update-baseline');
    const baselineFile = path.resolve('scripts/check-docs.baseline.json');

    let baseline = [];
    if (fs.existsSync(baselineFile)) {
        baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
    }

    const trackedFiles = getTrackedFiles();
    const mdFiles = getTrackedMarkdownFiles();

    const currentBroken = [];

    for (const mdFile of mdFiles) {
        const content = fs.readFileSync(mdFile, 'utf8');
        const refs = extractRefs(content, mdFile);
        for (const ref of refs) {
            if (!isValidRef(ref, trackedFiles)) {
                currentBroken.push({ file: mdFile, ref });
            }
        }
    }

    // Ratchet logic
    // We want to compare currentBroken with baseline
    // The checker fails only for references NOT in the baseline (new breaks)
    // AND fails when a baseline entry no longer breaks (so the file shrinks over time)

    const baselineSet = new Set(baseline.map(b => b.file + '::' + b.ref));
    const currentSet = new Set(currentBroken.map(c => c.file + '::' + c.ref));

    let hasNewBreaks = false;
    let hasFixedBreaks = false;

    for (const c of currentBroken) {
        if (!baselineSet.has(c.file + '::' + c.ref)) {
            console.error(`NEW broken ref in ${c.file}: ${c.ref}`);
            hasNewBreaks = true;
        }
    }

    for (const b of baseline) {
        if (!currentSet.has(b.file + '::' + b.ref)) {
            console.error(`FIXED ref in ${b.file}: ${b.ref} is now valid! Baseline must be shrunk.`);
            hasFixedBreaks = true;
        }
    }

    if (isUpdateBaseline) {
        fs.writeFileSync(baselineFile, JSON.stringify(currentBroken, null, 2) + '\n', 'utf8');
        console.log(`Baseline updated with ${currentBroken.length} broken references.`);
        process.exit(0);
    } else {
        if (hasNewBreaks || hasFixedBreaks) {
            console.error('Ratchet failed. Run with --update-baseline to update the baseline.');
            process.exit(1);
        } else {
            console.log(`Docs check passed! Baseline has ${baseline.length} entries.`);
            process.exit(0);
        }
    }
}
