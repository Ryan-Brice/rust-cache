import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as github from "@actions/github";

import { cleanBin, cleanGit, cleanRegistry, cleanTargetDir } from "./cleanup";
import { CacheConfig, isCacheUpToDate } from "./config";
import { getCacheProvider, reportError } from "./utils";

process.on("uncaughtException", (e) => {
  core.error(e.message);
  if (e.stack) {
    core.error(e.stack);
  }
});

async function run() {
  const cacheProvider = getCacheProvider();

  const save = core.getInput("save-if").toLowerCase() || "true";

  if (!(cacheProvider.cache.isFeatureAvailable() && save === "true")) {
    return;
  }

  const envHashKey = core.getInput("add-rust-environment-hash-key").toLowerCase();

  try {
    // Skip saving cache if it is up-to-date and we are hashing the Rust environment
    // as part of the cache key. If we are not hashing the Rust environment, not doing
    // this check would mean we never update the cache after the initial save.
    if (isCacheUpToDate() && envHashKey == "true") {
      core.info(`Cache up-to-date.`);
      return;
    }

    const config = CacheConfig.fromState();
    config.printInfo(cacheProvider);
    core.info("");

    // If rust environment hash key is enabled, delete existing cache entry before
    // saving new cache to avoid failing to save when cache already exists.
    if (envHashKey == "true" && cacheProvider.name === "github") {
      core.info("Rust environment hash key enabled - deleting existing cache entry if any before saving new cache.");
      try {
        await deleteGHCacheByKey(config.cacheKey);
      } catch (e) {
        core.warning(`Failed to delete existing cache entry: ${(e as Error).message}`);
        core.debug((e as Error).stack || "");
      }
    }


    // TODO: remove this once https://github.com/actions/toolkit/pull/553 lands
    if (process.env["RUNNER_OS"] == "macOS") {
      await macOsWorkaround();
    }

    const workspaceCrates = core.getInput("cache-workspace-crates").toLowerCase() || "false";
    const allPackages = [];
    for (const workspace of config.workspaces) {
      const packages = await workspace.getPackagesOutsideWorkspaceRoot();
      if (workspaceCrates === "true") {
        const wsMembers = await workspace.getWorkspaceMembers();
        packages.push(...wsMembers);
      }
      allPackages.push(...packages);
      try {
        core.info(`... Cleaning ${workspace.target} ...`);
        await cleanTargetDir(workspace.target, packages);
      } catch (e) {
        core.debug(`${(e as any).stack}`);
      }
    }

    try {
      const crates = core.getInput("cache-all-crates").toLowerCase() || "false";
      core.info(`... Cleaning cargo registry (cache-all-crates: ${crates}) ...`);
      await cleanRegistry(allPackages, crates !== "true");
    } catch (e) {
      core.debug(`${(e as any).stack}`);
    }

    if (config.cacheBin) {
      try {
        core.info(`... Cleaning cargo/bin ...`);
        await cleanBin(config.cargoBins);
      } catch (e) {
        core.debug(`${(e as any).stack}`);
      }
    }

    try {
      core.info(`... Cleaning cargo git cache ...`);
      await cleanGit(allPackages);
    } catch (e) {
      core.debug(`${(e as any).stack}`);
    }

    core.info(`... Saving cache ...`);
    // Pass a copy of cachePaths to avoid mutating the original array as reported by:
    // https://github.com/actions/toolkit/pull/1378
    // TODO: remove this once the underlying bug is fixed.
    await cacheProvider.cache.saveCache(config.cachePaths.slice(), config.cacheKey);
  } catch (e) {
    reportError(e);
  }
  process.exit();
}

run();

async function macOsWorkaround() {
  try {
    // Workaround for https://github.com/actions/cache/issues/403
    // Also see https://github.com/rust-lang/cargo/issues/8603
    await exec.exec("sudo", ["/usr/sbin/purge"], { silent: true });
  } catch {}
}

async function deleteGHCacheByKey(cacheKey: string) {
  try {
    const token = await core.getIDToken() || process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error("GitHub token is required to delete cache when using the github cache provider.");
    }
    const octokit = github.getOctokit(token);
    const context = github.context;
    await octokit.rest.actions.deleteActionsCacheByKey({
      owner: context.repo.owner,
      repo: context.repo.repo,
      ref: context.ref,
      key: cacheKey,
    });
    core.info(`Cache with key ${cacheKey} deleted successfully.`);
  } catch (e) {
    reportError(e);
  }
}