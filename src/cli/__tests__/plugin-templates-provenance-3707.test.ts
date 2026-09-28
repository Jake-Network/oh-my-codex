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
	const { packagedOmxPluginVersion } = await import("../plugin-marketplace.js");
	const packaged = await resolvePackagedOmxMarketplace(packageRoot);
	if (!packaged) throw new Error("Cannot resolve packaged marketplace");
	const version = await packagedOmxPluginVersion(packaged);
	if (!version) throw new Error("Cannot determine packaged plugin version");
	return version;
}

describe("issue 3707 P2 templates AGENTS.md provenance in staged snapshot validation", () => {
	it("reject materialization when packaged plugin missing templates/AGENTS.md during staging", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-test-"));
		try {
			const packaged = await resolvePackagedOmxMarketplace(packageRoot);
			assert.ok(packaged, "original package should resolve");
			const version = await packagedPluginVersion();

			// Create a corrupted package fixture with full package structure
			const corruptedPackageRoot = join(wd, "corrupted-package");
			await mkdir(corruptedPackageRoot, { recursive: true });

			// Copy the entire package structure (.agents/plugins/marketplace.json and dist)
			const { cp } = await import("node:fs/promises");
			
			// Copy marketplace.json
			const marketplaceDir = join(corruptedPackageRoot, ".agents", "plugins");
			await mkdir(marketplaceDir, { recursive: true });
			await cp(
				join(packageRoot, ".agents", "plugins", "marketplace.json"),
				join(marketplaceDir, "marketplace.json")
			);

			// Copy all plugin files except templates/AGENTS.md
			const pluginDst = join(corruptedPackageRoot, "plugins", "oh-my-codex");
			await cp(packaged.pluginRoot, pluginDst, { recursive: true });

			// Copy dist/cli/omx.js for launcher validation
			const distSrc = join(packageRoot, "dist", "cli");
			const distDst = join(corruptedPackageRoot, "dist", "cli");
			await mkdir(distDst, { recursive: true });
			await cp(distSrc, distDst, { recursive: true });

			// Delete templates/AGENTS.md to create the corruption
			const agentsPath = join(pluginDst, "templates", "AGENTS.md");
			await rm(agentsPath, { force: true });

			// Now the corrupted package should resolve since it has proper structure
			const corruptedPackaged = await resolvePackagedOmxMarketplace(corruptedPackageRoot);
			assert.ok(corruptedPackaged, "corrupted package should resolve due to proper structure");

			// Try to materialize with corrupted package - should fail during snapshot validation
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const result = await materializePackagedOmxPluginCache(codexHomeDir, corruptedPackaged);
				assert.notEqual(result.status, "materialized", `Expected failure but got: ${JSON.stringify(result)}`);
				assert.match(result.reason ?? "", /templates|AGENTS/i, "reason should mention templates/AGENTS.md");
				// Verify .omx-complete is NOT written
				const completeMarker = join(result.cacheDir ?? "", ".omx-complete");
				const stats = await lstat(completeMarker).catch(() => null);
				assert.equal(stats, null, ".omx-complete should not be written for invalid cache");
			});
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
				assert.ok(result.cacheDir, "materialized result should have cacheDir");

				// Replace AGENTS.md with a symlink (simulating provenance violation)
				const agentsPath = join(result.cacheDir, "templates", "AGENTS.md");
				await rm(agentsPath, { force: true });
				const target = join(wd, "external-agents.md");
				await writeFile(target, "# external\n");
				await symlink(target, agentsPath);

				// Next materialization should reject this cache
				const result2 = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
				assert.notEqual(result2.status, "materialized", `Expected rejection but got: ${JSON.stringify(result2)}`);
				assert.match(result2.reason ?? "", /templates|symlink/i, "reason should mention templates or symlink");

				// Verify the cache is not considered valid
				const isValid = await hasExpectedOmxPluginCache(codexHomeDir, packaged);
				assert.equal(isValid, false, "cache with symlinked AGENTS.md should be rejected");
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
				assert.ok(result.cacheDir, "materialized result should have cacheDir");

				// Remove the entire templates directory
				const templatesPath = join(result.cacheDir, "templates");
				await rm(templatesPath, { recursive: true, force: true });

				// Next materialization should reject this cache
				const result2 = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
				assert.notEqual(result2.status, "materialized", `Expected rejection but got: ${JSON.stringify(result2)}`);
				assert.match(result2.reason ?? "", /templates|missing/i, "reason should mention templates or missing");

				// Verify the cache is not considered valid
				const isValid = await hasExpectedOmxPluginCache(codexHomeDir, packaged);
				assert.equal(isValid, false, "cache with missing templates dir should be rejected");
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});
});
