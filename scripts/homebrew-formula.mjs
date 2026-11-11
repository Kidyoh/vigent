#!/usr/bin/env node
/**
 * Write the Homebrew formula for a release: the standalone binaries for macOS
 * and Linux, at the version in package.json, with the checksums from
 * dist-bin/SHA256SUMS (what scripts/build-binary.mjs wrote).
 *
 *   node scripts/homebrew-formula.mjs               print it
 *   node scripts/homebrew-formula.mjs Formula/vigent.rb   write it there
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** SHA256SUMS → { "vigent-linux-x64.tar.gz": "<sha256>", … } */
export function parseSums(text) {
	const sums = {};
	for (const line of text.split("\n")) {
		const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
		if (m) sums[m[2]] = m[1];
	}
	return sums;
}

/** The formula's text. Throws when a platform's checksum is missing. */
export function formula(version, sums, repo = "farming-labs/vigent") {
	const from = (target) => {
		const file = `vigent-${target}.tar.gz`;
		if (!sums[file]) throw new Error(`SHA256SUMS has no line for ${file}`);
		return `      url "https://github.com/${repo}/releases/download/v${version}/${file}"\n      sha256 "${sums[file]}"`;
	};
	return `# Written by scripts/homebrew-formula.mjs for each release; edit that, not this.
class Vigent < Formula
  desc "Vim-native orchestrator for coding-agent CLIs, each in its own git worktree"
  homepage "https://vigent.farming-labs.dev"
  version "${version}"
  license "MIT"

  on_macos do
    on_arm do
${from("darwin-arm64")}
    end
    on_intel do
${from("darwin-x64")}
    end
  end

  on_linux do
    on_arm do
${from("linux-arm64")}
    end
    on_intel do
${from("linux-x64")}
    end
  end

  def install
    # riftri stays beside vigent, where vigent looks for it
    libexec.install "vigent", "riftri"
    bin.install_symlink libexec/"vigent"
  end

  test do
    assert_equal "vigent #{version}", shell_output("#{bin}/vigent --version").strip
  end
end
`;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
		const text = formula(version, parseSums(fs.readFileSync(path.join(root, "dist-bin", "SHA256SUMS"), "utf8")));
		const to = process.argv[2];
		if (!to) process.stdout.write(text);
		else {
			fs.mkdirSync(path.dirname(path.resolve(to)), { recursive: true });
			fs.writeFileSync(to, text);
		}
	} catch (err) {
		console.error(`homebrew-formula: ${err.message}`);
		process.exit(1);
	}
}
