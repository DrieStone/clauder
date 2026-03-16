#!/usr/bin/env node

// macOS Gatekeeper blocks ad-hoc signed binaries bundled by npm packages.
// The SDK's bundled ripgrep binary hangs silently when blocked (no error).
// This script re-signs affected binaries with a local ad-hoc signature
// that macOS accepts. Runs automatically via the "postinstall" npm script.

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

if (process.platform !== 'darwin') {
  process.exit(0);
}

const root = new URL('..', import.meta.url).pathname;

const binaries = [
  'node_modules/@anthropic-ai/claude-code/vendor/ripgrep/arm64-darwin/rg',
  'node_modules/@anthropic-ai/claude-code/vendor/ripgrep/arm64-darwin/ripgrep.node',
  'node_modules/@anthropic-ai/claude-code/vendor/ripgrep/x64-darwin/rg',
  'node_modules/@anthropic-ai/claude-code/vendor/ripgrep/x64-darwin/ripgrep.node',
];

let signed = 0;
for (const rel of binaries) {
  const abs = join(root, rel);
  if (!existsSync(abs)) continue;

  try {
    execSync(`spctl --assess --type execute "${abs}" 2>&1`);
    // Already accepted — skip
  } catch {
    // Rejected or can't assess — re-sign
    try {
      execSync(`codesign --force --sign - "${abs}"`, { stdio: 'pipe' });
      signed++;
      console.log(`  codesigned: ${rel}`);
    } catch (e) {
      console.warn(`  codesign failed for ${rel}: ${e.message}`);
    }
  }
}

if (signed > 0) {
  console.log(`fix-codesign: re-signed ${signed} binary(ies) for macOS Gatekeeper`);
}
