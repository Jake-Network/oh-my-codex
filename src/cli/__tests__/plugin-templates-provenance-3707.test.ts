import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile, rm, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import {
	hasExpectedOmxPluginCache,
	materializePackagedOmxPluginCache,
	omxPluginCacheBase,
	resolvePackagedOmxMarketplace,
} from "../plugin-marketplace.js";

const packageRoot = process.cwd();

async function withIsolatedUserHome<T>(
	wd: string,
	fn: (codexHomeDir: string) => Promise<T>,
): Promise<T> {
	const codexHomeDir = join(wd, "codex");
	await mkdir(codexHomeDir, { recursive: true });
	return fn(codexHomeDir);
}

async function packagedPluginVersion(): Promise<string> {
	const packaged = await resolvePackagedOmxMarketplace(packageRoot);
	const version = packaged ? (await import("../plugin-marketplace.js")).packagedOmxPluginVersion(packaged) : null;
	if (!version) throw new Error("Cannot determine packaged plugin version");
	return version;
}

describe("issue 3707 P2 templates AGENTS.md provenance in staged snapshot validation", () => {
	it("reject materialization when packaged plugin missing templates/AGENTS.md during staging", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-test-"));
		try {
			const packaged = await resolvePackagedOmxMarketplace(packageRoot);
			assert.ok(packaged);
			const version = await packagedPluginVersion();

			// Create a corrupted package missing templates/AGENTS.md
			const corruptedPackageRoot = join(wd, "corrupted-package");
			await mkdir(corruptedPackageRoot, { recursive: true });

			// Copy all files from packaged marketplace except templates/AGENTS.md
			const src = packaged.pluginRoot;
			const dst = corruptedPackageRoot;

			// Copy basic structure
			for (const dir of ["hooks", "manifest", "skills", ".mcp", ".app"]) {
				const srcPath = join(src, dir);
				try {
					await import("node:fs/promises").then(fs => fs.cp(srcPath, join(dst, dir), { recursive: true }));
				} catch {
					// Skip if directory doesn't exist
				}
			}

			// Create templates dir but intentionally skip AGENTS.md
			await mkdir(join(dst, "templates"), { recursive: true });

			// Try to materialize with corrupted package
			const corruptedPackaged = await resolvePackagedOmxMarketplace(corruptedPackageRoot);
			if (corruptedPackaged) {
				await withIsolatedUserHome(wd, async (codexHomeDir) => {
					const result = await materializePackagedOmxPluginCache(codexHomeDir, corruptedPackaged);
					// Should fail during staged snapshot validation
					assert.notEqual(result.status, "materialized", `Expected failure but got: ${JSON.stringify(result)}`);
					// Verify .omx-complete is NOT written
					const cacheDir = result.cacheDir;
					if (cacheDir) {
						const completeMarker = join(cacheDir, ".omx-complete");
						const stats = await lstat(completeMarker).catch(() => null);
						assert.equal(stats, null, ".omx-complete should not be written for invalid cache");
					}
				});
			}
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("successful materialization with valid templates/AGENTS.md", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-test-"));
		try {
			const packaged = await resolvePackagedOmxMarketplace(packageRoot);
			assert.ok(packaged);

			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
				assert.equal(result.status, "materialized", JSON.stringify(result));
				assert.ok(result.cacheDir);

				// Verify .omx-complete IS written
				const completeMarker = join(result.cacheDir, ".omx-complete");
				const stats = await lstat(completeMarker);
				assert.ok(stats.isFile(), ".omx-complete should be a regular file");

				// Verify the cache is considered valid
				assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), true);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("reject when templates/AGENTS.md is a symlink", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-test-"));
		try {
			const packaged = await resolvePackagedOmxMarketplace(packageRoot);
			assert.ok(packaged);

			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
				assert.equal(result.status, "materialized", JSON.stringify(result));

				if (result.cacheDir) {
					// Replace AGENTS.md with a symlink (simulating provenance violation)
					const agentsPath = join(result.cacheDir, "templates", "AGENTS.md");
					await rm(agentsPath, { force: true });
					const target = join(wd, "external-agents.md");
					await writeFile(target, "# external\n");
					await symlink(target, agentsPath);

					// Next materialization should reject this cache
					const result2 = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
					assert.notEqual(result2.status, "materialized", `Expected rejection but got: ${JSON.stringify(result2)}`);
					assert.match(result2.reason ?? "", /templates|symlink/i);
				}
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("reject when templates directory is missing", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-test-"));
		try {
			const packaged = await resolvePackagedOmxMarketplace(packageRoot);
			assert.ok(packaged);

			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
				assert.equal(result.status, "materialized", JSON.stringify(result));

				if (result.cacheDir) {
					// Remove the entire templates directory
					const templatesPath = join(result.cacheDir, "templates");
					await rm(templatesPath, { recursive: true, force: true });

					// Next materialization should reject this cache
					const result2 = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
					assert.notEqual(result2.status, "materialized", `Expected rejection but got: ${JSON.stringify(result2)}`);
					assert.match(result2.reason ?? "", /templates|missing/i);
				}
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});
});
