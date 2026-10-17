import fs from 'node:fs';

export function parseClaims(markdown) {
  const claims = [];
  // Match rows looking like: | something | mechanism | path::test name |
  const rowRegex = /^\|([^|]+)\|([^|]+)\|([^|]+)\|$/gm;
  let match;
  while ((match = rowRegex.exec(markdown)) !== null) {
    const guarantee = match[1].trim();
    const mechanism = match[2].trim();
    const proofRaw = match[3].trim();

    // Check if proof matches path::test_name
    if (proofRaw.includes('::')) {
      const parts = proofRaw.split('::');
      if (parts.length === 2) {
        claims.push({
          guarantee,
          mechanism,
          file: parts[0].trim(),
          test: parts[1].trim(),
          raw: match[0],
          proofStr: proofRaw
        });
      }
    }
  }
  return claims;
}

export function verifyClaims(claims, readFile) {
  const errors = [];
  const cache = new Map();

  for (const claim of claims) {
    let content;
    try {
      if (cache.has(claim.file)) {
        content = cache.get(claim.file);
      } else {
        content = readFile(claim.file);
        cache.set(claim.file, content);
      }
    } catch (err) {
      errors.push(`Missing file for claim '${claim.guarantee}': ${claim.file}`);
      continue;
    }

    if (!content.includes(claim.test)) {
      errors.push(`Test not found in ${claim.file} for claim '${claim.guarantee}': ${claim.test}`);
    }
  }

  return errors;
}

if (process.argv[1] && process.argv[1].endsWith('check-security-claims.mjs') && process.argv.length === 2) {
  try {
    const markdown = fs.readFileSync('docs/SECURITY_MODEL.md', 'utf-8');
    const claims = parseClaims(markdown);
    if (claims.length === 0) {
      console.error("No claims found in docs/SECURITY_MODEL.md. Ensure there is at least one valid row.");
      process.exit(1);
    }
    const errors = verifyClaims(claims, (path) => fs.readFileSync(path, 'utf-8'));

    if (errors.length > 0) {
      console.error("Security claims verification failed:");
      for (const err of errors) {
        console.error(`- ${err}`);
      }
      process.exit(1);
    } else {
      console.log(`Successfully verified ${claims.length} security claims.`);
      process.exit(0);
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error("docs/SECURITY_MODEL.md not found.");
      process.exit(1);
    }
    console.error("Unexpected error:", err);
    process.exit(1);
  }
}
