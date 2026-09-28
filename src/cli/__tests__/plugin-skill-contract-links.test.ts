import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = process.cwd();
const pluginName = 'oh-my-codex';
const pluginRoot = join(root, 'plugins', pluginName);
const pluginSkillsDir = join(pluginRoot, 'skills');

/**
 * Extract markdown links from text: [text](path)
 * Returns array of resolved paths
 */
function extractMarkdownLinks(content: string): string[] {
	const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
	const links: string[] = [];
	let match;

	while ((match = markdownLinkRegex.exec(content)) !== null) {
		const linkPath = match[2];
		// Only process relative links (not URLs or absolute paths)
		if (!linkPath.startsWith('http') && !linkPath.startsWith('/') && !linkPath.startsWith('#')) {
			links.push(linkPath);
		}
	}

	return links;
}

/**
 * Resolve a relative path within a skill directory to the plugin root
 */
function resolvePathInPlugin(skillDir: string, relativePath: string): string {
	return resolve(join(skillDir, relativePath));
}

/**
 * Check if a resolved path is within the plugin root
 */
function isPathInsidePluginRoot(path: string): boolean {
	const relativePath = resolve(path);
	const pluginRootResolved = resolve(pluginRoot);
	// Normalize both paths for comparison
	return relativePath.startsWith(pluginRootResolved + '/') || relativePath === pluginRootResolved;
}

describe('plugin skill contract links', () => {
	it('should verify all relative markdown links in plugin skills resolve inside plugin root', async () => {
		const skillDirs = await readdir(pluginSkillsDir, { withFileTypes: true });
		const skillNames = skillDirs
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);

		assert.ok(
			skillNames.length > 0,
			`Expected at least one skill directory in ${pluginSkillsDir}`,
		);

		const linkErrors: Array<{ skill: string; file: string; link: string; resolvedPath: string; reason: string }> =
			[];

		for (const skillName of skillNames) {
			const skillDir = join(pluginSkillsDir, skillName);
			const skillMdPath = join(skillDir, 'SKILL.md');

			if (!existsSync(skillMdPath)) {
				// Skills may not all have SKILL.md, skip silently
				continue;
			}

			const content = await readFile(skillMdPath, 'utf-8');
			const links = extractMarkdownLinks(content);

			for (const link of links) {
				const resolvedPath = resolvePathInPlugin(skillDir, link);

				if (!isPathInsidePluginRoot(resolvedPath)) {
					linkErrors.push({
						skill: skillName,
						file: 'SKILL.md',
						link,
						resolvedPath,
						reason: `resolves outside plugin root: ${pluginRoot}`,
					});
				} else if (!existsSync(resolvedPath)) {
					// Only report non-existent paths if they resolve inside the plugin
					linkErrors.push({
						skill: skillName,
						file: 'SKILL.md',
						link,
						resolvedPath,
						reason: `target file does not exist inside plugin`,
					});
				}
			}
		}

		if (linkErrors.length > 0) {
			const errorMessage = linkErrors
				.map(
					(err) =>
						`  ${err.skill}/SKILL.md [${err.link}] -> ${err.resolvedPath}: ${err.reason}`,
				)
				.join('\n');
			assert.fail(`Plugin skill links must resolve inside plugin root:\n${errorMessage}`);
		}
	});

	it('should verify templates/AGENTS.md exists in plugin', async () => {
		const pluginAgentsPath = join(pluginRoot, 'templates', 'AGENTS.md');
		assert.ok(
			existsSync(pluginAgentsPath),
			`Expected templates/AGENTS.md to exist at ${pluginAgentsPath}`,
		);
	});
});
