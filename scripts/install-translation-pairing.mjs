#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import {
    closeSync,
    fstatSync,
    lstatSync,
    openSync,
    readdirSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isAbsolute, join, resolve } from 'node:path'
const MINIMUM_GIT = [2, 26, 0]
const INSTALL_LOCK = 'dsh-translation-pairing-install.lock'
const INSTALL_LOCK_TIMEOUT_MS = 30_000
const INSTALL_LOCK_INITIALIZATION_TIMEOUT_MS = 5_000
const INSTALL_LOCK_POLL_MS = 50
const REPOSITORY_EXTENSION_PATTERN = '^extensions\\.'
const PAIRING_MERGE_DRIVER_CONFIG = [
    ['merge.dsh-translation-pairing.name', 'DeepSeek Harness bilingual pairing records'],
    [
        'merge.dsh-translation-pairing.driver',
        'scripts/merge-translation-pairing-driver.sh %O %A %B %P',
    ],
]
const PAIRING_MERGE_DRIVER_PROBE = [
    '--import',
    'tsx/esm',
    'scripts/merge-translation-pairing.ts',
    '--probe',
]

function errorCode(error) {
    return typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : undefined
}

function commandFailure(command, args, result) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : ''
    const detail = result.error?.message ?? (stderr || `exit status ${String(result.status)}`)
    return new Error(`${command} ${args.join(' ')} failed: ${detail}`)
}

function capture(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd,
        encoding: 'utf8',
        env: process.env,
    })
    if (result.status !== 0 && !options.allowStatuses?.includes(result.status)) {
        throw commandFailure(command, args, result)
    }
    return result
}

function git(args, root, options = {}) {
    return capture('git', args, { ...options, cwd: root })
}

function nulValues(result) {
    if (result.status !== 0) return []
    if (result.stdout === '') return ['']
    const output = result.stdout.endsWith('\0') ? result.stdout.slice(0, -1) : result.stdout
    return output.split('\0')
}

function stripGitLineTerminator(output) {
    const withoutLineFeed = output.endsWith('\n') ? output.slice(0, -1) : output
    return process.platform === 'win32' && withoutLineFeed.endsWith('\r')
        ? withoutLineFeed.slice(0, -1)
        : withoutLineFeed
}

function directFileConfigValues(root, configPath, key) {
    return nulValues(git(
        ['config', '--file', configPath, '--no-includes', '--null', '--get-all', key],
        root,
        { allowStatuses: [1] },
    ))
}

function parseFileConfigEntries(fields, key) {
    if (fields.length % 2 !== 0) {
        throw new Error(`git config returned invalid file entries for ${key}`)
    }
    const entries = []
    for (let index = 0; index < fields.length; index += 2) {
        entries.push({ origin: fields[index], value: fields[index + 1] })
    }
    return entries
}

function includedFileConfigEntries(root, configPath, key) {
    const fields = nulValues(git(
        ['config', '--file', configPath, '--includes', '--null', '--show-origin', '--get-all', key],
        root,
        { allowStatuses: [1] },
    ))
    return parseFileConfigEntries(fields, key)
}

function splitConfigNameValue(field, pattern) {
    const separator = field.indexOf('\n')
    if (separator < 0) throw new Error(`git config returned an invalid name and value for ${pattern}`)
    return { name: field.slice(0, separator), value: field.slice(separator + 1) }
}

function directFileConfigMatchingEntries(root, configPath, pattern) {
    const fields = nulValues(git(
        ['config', '--file', configPath, '--no-includes', '--null', '--show-origin', '--get-regexp', pattern],
        root,
        { allowStatuses: [1] },
    ))
    if (fields.length % 2 !== 0) {
        throw new Error(`git config returned invalid matching file entries for ${pattern}`)
    }
    const entries = []
    for (let index = 0; index < fields.length; index += 2) {
        entries.push({ origin: fields[index], ...splitConfigNameValue(fields[index + 1], pattern) })
    }
    return entries
}

function effectiveConfigEntry(root, key) {
    const fields = nulValues(git(
        ['config', '--null', '--show-scope', '--show-origin', '--get', key],
        root,
        { allowStatuses: [1] },
    ))
    if (fields.length === 0) return undefined
    if (fields.length !== 3) {
        throw new Error(`git config returned an invalid scoped value for ${key}`)
    }
    const [scope, origin, value] = fields
    return { origin, scope, value }
}

function parseGitBoolean(value, key) {
    const normalized = value.toLowerCase()
    if (normalized === '' || normalized === 'true' || normalized === 'yes' || normalized === 'on' || normalized === '1') return true
    if (normalized === 'false' || normalized === 'no' || normalized === 'off' || normalized === '0') return false
    throw new Error(`invalid Boolean value for ${key}: ${JSON.stringify(value)}`)
}

function assertSingle(values, key) {
    if (values.length > 1) throw new Error(`multiple ${key} values are not supported`)
    return values[0]
}

function worktreeConfigExtensionEnabled(root, commonConfigPath) {
    const extensionText = assertSingle(
        directFileConfigValues(root, commonConfigPath, 'extensions.worktreeConfig'),
        'extensions.worktreeConfig',
    )
    return extensionText === undefined
        ? false
        : parseGitBoolean(extensionText, 'extensions.worktreeConfig')
}

function hasDirectConfigEntries(root, configPath) {
    return git(['config', '--file', configPath, '--no-includes', '--null', '--list'], root).stdout !== ''
}

function registeredWorktreeConfigPaths(commonDirectory) {
    const paths = [join(commonDirectory, 'config.worktree')]
    const linkedDirectory = join(commonDirectory, 'worktrees')
    try {
        const entries = readdirSync(linkedDirectory, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name))
        for (const entry of entries) {
            paths.push(join(linkedDirectory, entry.name, 'config.worktree'))
        }
    } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error
    }
    return paths
}

function lstatIfPresent(path) {
    try {
        return lstatSync(path)
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return undefined
        throw error
    }
}

function assertCommonConfigFile(commonConfigPath) {
    const configStat = lstatIfPresent(commonConfigPath)
    if (configStat === undefined || !configStat.isFile() || configStat.isSymbolicLink()) {
        throw new Error(
            `refusing common repository config ${JSON.stringify(commonConfigPath)} because it is not a regular file`,
        )
    }
}

function assertWorktreeConfigFiles(root, commonDirectory, commonConfigPath, currentConfigPath) {
    const extensionEnabled = worktreeConfigExtensionEnabled(root, commonConfigPath)
    for (const configPath of registeredWorktreeConfigPaths(commonDirectory)) {
        const configStat = lstatIfPresent(configPath)
        if (configStat === undefined) continue
        if (!configStat.isFile() || configStat.isSymbolicLink()) {
            const state = extensionEnabled ? 'active' : 'dormant'
            throw new Error(
                `refusing ${state} worktree config ${JSON.stringify(configPath)} because it is not a regular file; `
                + 'replace it with a regular worktree config or remove it before retrying',
            )
        }
        if (extensionEnabled) continue
        if (!hasDirectConfigEntries(root, configPath)) continue
        const isCurrent = normalizedPath(configPath) === normalizedPath(currentConfigPath)
        const owner = isCurrent ? 'current' : 'sibling'
        throw new Error(
            `cannot enable extensions.worktreeConfig while ${owner} dormant worktree config `
            + `${JSON.stringify(configPath)} contains user-owned settings that enabling the extension would activate; `
            + 'inspect and migrate those settings, then enable the extension explicitly or remove them before retrying',
        )
    }
}

function assertSupportedGit(root) {
    const version = git(['--version'], root).stdout.trim()
    const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(version)
    if (match === null) throw new Error(`cannot determine Git version from ${JSON.stringify(version)}`)
    const actual = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
    for (let index = 0; index < MINIMUM_GIT.length; index += 1) {
        if (actual[index] > MINIMUM_GIT[index]) return
        if (actual[index] < MINIMUM_GIT[index]) {
            throw new Error(`Git 2.26 or newer is required for worktree-local pairing configuration; found ${version}`)
        }
    }
}

function planWorktreeConfigMigration(root, commonConfigPath) {
    const versions = directFileConfigValues(root, commonConfigPath, 'core.repositoryFormatVersion')
    const versionText = assertSingle(versions, 'core.repositoryFormatVersion')
    const version = Number(versionText)
    if (!Number.isInteger(version) || version < 0) {
        throw new Error(`unsupported core.repositoryFormatVersion: ${JSON.stringify(versionText)}`)
    }

    if (version === 0) {
        const extensionEntry = directFileConfigMatchingEntries(
            root,
            commonConfigPath,
            REPOSITORY_EXTENSION_PATTERN,
        )[0]
        if (extensionEntry !== undefined) {
            throw new Error(
                `cannot upgrade core.repositoryFormatVersion from 0 while dormant repository extension `
                + `${extensionEntry.name} is configured (${configSource(extensionEntry)}); `
                + 'audit and migrate it, then set repository format 1 explicitly before retrying',
            )
        }
    }

    const extensionEnabled = worktreeConfigExtensionEnabled(root, commonConfigPath)
    const worktreeText = assertSingle(
        directFileConfigValues(root, commonConfigPath, 'core.worktree'),
        'core.worktree',
    )
    if (worktreeText !== undefined) {
        throw new Error(
            `cannot enable extensions.worktreeConfig while core.worktree is in the common config `
            + `(file:${commonConfigPath}: ${JSON.stringify(worktreeText)}); `
            + 'move it to the main worktree config first',
        )
    }

    const directBareText = assertSingle(directFileConfigValues(root, commonConfigPath, 'core.bare'), 'core.bare')
    const directBare = directBareText === undefined ? undefined : parseGitBoolean(directBareText, 'core.bare')
    if (directBare === true) {
        throw new Error(
            `cannot enable extensions.worktreeConfig for a common config with core.bare=true `
            + `(file:${commonConfigPath}: ${JSON.stringify(directBareText)})`,
        )
    }

    return { directBare, extensionEnabled, version }
}

function applyWorktreeConfigMigration(root, commonConfigPath, migration) {
    const { directBare, extensionEnabled, version } = migration
    if (version === 0) {
        git(['config', '--file', commonConfigPath, 'core.repositoryFormatVersion', '1'], root)
    }
    if (!extensionEnabled) {
        git(['config', '--file', commonConfigPath, 'extensions.worktreeConfig', 'true'], root)
    }
    if (directBare === false) {
        git(['config', '--file', commonConfigPath, '--unset-all', 'core.bare'], root)
    }
}

function readInstallLock(lockPath) {
    try {
        return readFileSync(lockPath, 'utf8')
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return undefined
        throw error
    }
}

function installLockStat(lockPath) {
    try {
        return lstatSync(lockPath)
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return undefined
        throw error
    }
}

function parseInstallLock(record) {
    const match = /^([1-9]\d*) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\n$/i.exec(record)
    if (match === null) return undefined
    const owner = Number(match[1])
    return Number.isSafeInteger(owner) ? owner : undefined
}

function installLockRecordMayBeIncomplete(record) {
    // Exclusive creation exposes the inode before its owner record is fully written.
    return record === '' || (!record.endsWith('\n') && /^[1-9]\d*(?: [0-9a-f-]*)?$/i.test(record))
}

function lockOwnerIsAlive(owner) {
    try {
        process.kill(owner, 0)
        return true
    } catch (error) {
        if (errorCode(error) === 'ESRCH') return false
        if (errorCode(error) === 'EPERM') return true
        throw error
    }
}

function manualLockRecoveryError(lockPath, condition) {
    return new Error(
        `${condition} translation-pairing installer lock ${JSON.stringify(lockPath)}. `
        + 'Confirm no translation-pairing installer is running, remove it manually, and retry.',
    )
}

function lockOwnershipChangedError(lockPath) {
    return new Error(`translation-pairing installer lock ownership changed for ${lockPath}; refusing to remove it`)
}

function releaseInstallLock(lockPath, ownedRecord, ownedStat) {
    const currentStat = installLockStat(lockPath)
    if (
        currentStat === undefined
        || !currentStat.isFile()
        || currentStat.isSymbolicLink()
        || currentStat.dev !== ownedStat.dev
        || currentStat.ino !== ownedStat.ino
        || readInstallLock(lockPath) !== ownedRecord
    ) {
        throw lockOwnershipChangedError(lockPath)
    }
    try {
        unlinkSync(lockPath)
    } catch (error) {
        if (errorCode(error) === 'ENOENT') {
            throw lockOwnershipChangedError(lockPath)
        }
        throw error
    }
}

async function acquireInstallLock(commonDirectory) {
    const lockPath = join(commonDirectory, INSTALL_LOCK)
    const deadline = Date.now() + INSTALL_LOCK_TIMEOUT_MS
    const ownedRecord = `${String(process.pid)} ${randomUUID()}\n`
    let initializingLock
    while (true) {
        try {
            const lockHandle = openSync(lockPath, 'wx', 0o600)
            let ownedStat
            try {
                ownedStat = fstatSync(lockHandle)
                const writeDelay = Number(process.env.DSH_TEST_TRANSLATION_PAIRING_LOCK_WRITE_DELAY_MS ?? 0)
                if (writeDelay > 0) {
                    await new Promise(resolveWait => setTimeout(resolveWait, writeDelay))
                }
                writeFileSync(lockHandle, ownedRecord)
            } finally {
                closeSync(lockHandle)
            }
            const publishedStat = installLockStat(lockPath)
            if (
                publishedStat === undefined
                || !publishedStat.isFile()
                || publishedStat.isSymbolicLink()
                || publishedStat.dev !== ownedStat.dev
                || publishedStat.ino !== ownedStat.ino
            ) {
                throw lockOwnershipChangedError(lockPath)
            }
            return () => releaseInstallLock(lockPath, ownedRecord, ownedStat)
        } catch (error) {
            if (errorCode(error) !== 'EEXIST') throw error
            const existingStat = installLockStat(lockPath)
            if (existingStat === undefined) continue
            if (!existingStat.isFile() || existingStat.isSymbolicLink()) {
                throw manualLockRecoveryError(lockPath, 'invalid')
            }
            const existingRecord = readInstallLock(lockPath)
            if (existingRecord === undefined) continue
            const verifiedStat = installLockStat(lockPath)
            if (verifiedStat === undefined) continue
            if (!verifiedStat.isFile() || verifiedStat.isSymbolicLink()) {
                throw manualLockRecoveryError(lockPath, 'invalid')
            }
            if (verifiedStat.dev !== existingStat.dev || verifiedStat.ino !== existingStat.ino) continue
            const owner = parseInstallLock(existingRecord)
            if (owner === undefined) {
                if (!installLockRecordMayBeIncomplete(existingRecord)) {
                    throw manualLockRecoveryError(lockPath, 'invalid')
                }
                const now = Date.now()
                if (
                    initializingLock === undefined
                    || initializingLock.dev !== existingStat.dev
                    || initializingLock.ino !== existingStat.ino
                ) {
                    initializingLock = {
                        deadline: now + INSTALL_LOCK_INITIALIZATION_TIMEOUT_MS,
                        dev: existingStat.dev,
                        ino: existingStat.ino,
                    }
                }
                if (now >= initializingLock.deadline) {
                    throw manualLockRecoveryError(lockPath, 'invalid')
                }
                await new Promise(resolveWait => setTimeout(resolveWait, INSTALL_LOCK_POLL_MS))
                continue
            }
            initializingLock = undefined
            if (!lockOwnerIsAlive(owner)) throw manualLockRecoveryError(lockPath, 'stale')
            if (Date.now() >= deadline) {
                throw new Error(`timed out waiting for translation-pairing installer lock ${lockPath}`)
            }
            await new Promise(resolveWait => setTimeout(resolveWait, INSTALL_LOCK_POLL_MS))
        }
    }
}

function configSource(entry) {
    return `${entry.origin}: ${JSON.stringify(entry.value)}`
}

function normalizedPath(path) {
    const normalized = resolve(path)
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function configOriginPath(origin, root) {
    if (!origin.startsWith('file:')) return undefined
    const originPath = origin.slice('file:'.length)
    return isAbsolute(originPath) ? originPath : resolve(root, originPath)
}

function originIsFile(origin, root, configPath) {
    const originPath = configOriginPath(origin, root)
    return originPath !== undefined && normalizedPath(originPath) === normalizedPath(configPath)
}

function installPairingMergeDriver(root, worktreeConfigPath) {
    const added = []
    try {
        for (const [key, expected] of PAIRING_MERGE_DRIVER_CONFIG) {
            const entries = includedFileConfigEntries(root, worktreeConfigPath, key)
            const includedEntry = entries.find(entry => !originIsFile(entry.origin, root, worktreeConfigPath))
            if (includedEntry !== undefined) {
                throw new Error(
                    `refusing pairing merge-driver config from an included worktree file (${configSource(includedEntry)})`,
                )
            }
            const existing = assertSingle(entries.map(entry => entry.value), `worktree ${key}`)
            const effectiveBefore = effectiveConfigEntry(root, key)
            if (effectiveBefore?.scope === 'command') {
                throw new Error(
                    `refusing command-scoped ${key} (${configSource(effectiveBefore)}); `
                    + 'transient configuration cannot be replaced by the worktree installer',
                )
            }
            if (existing === undefined && effectiveBefore !== undefined && effectiveBefore.value !== expected) {
                throw new Error(
                    `refusing to mask inherited ${key} (${configSource(effectiveBefore)}); `
                    + 'remove or integrate the custom pairing merge driver explicitly',
                )
            }
            if (existing !== undefined && existing !== expected) {
                throw new Error(
                    `refusing to replace worktree ${key} value ${JSON.stringify(existing)}; `
                    + 'remove or integrate the custom pairing merge driver explicitly',
                )
            }
            if (existing === undefined) {
                git(['config', '--worktree', key, expected], root)
                added.push(key)
            }
            const installed = includedFileConfigEntries(root, worktreeConfigPath, key)
            if (
                installed.length !== 1
                || installed[0]?.value !== expected
                || !originIsFile(installed[0].origin, root, worktreeConfigPath)
            ) {
                throw new Error(`new worktree-local ${key} did not become the direct worktree value`)
            }
            const effectiveAfter = effectiveConfigEntry(root, key)
            if (
                effectiveAfter === undefined
                || effectiveAfter.scope !== 'worktree'
                || effectiveAfter.value !== expected
                || !originIsFile(effectiveAfter.origin, root, worktreeConfigPath)
            ) {
                throw new Error(`new worktree-local ${key} did not become the effective direct worktree value`)
            }
        }
    } catch (error) {
        const rollbackErrors = []
        for (const key of added.reverse()) {
            try {
                git(['config', '--worktree', '--unset-all', key], root)
            } catch (rollbackError) {
                rollbackErrors.push(rollbackError)
            }
        }
        if (rollbackErrors.length > 0) {
            throw new AggregateError(
                [error, ...rollbackErrors],
                `Pairing merge-driver configuration failed: ${String(error)}; `
                + `rollback also failed: ${rollbackErrors.map(String).join('; ')}`,
            )
        }
        throw error
    }
    return () => {
        for (const key of added.reverse()) git(['config', '--worktree', '--unset-all', key], root)
    }
}

function probePairingMergeDriver(root) {
    capture(process.execPath, PAIRING_MERGE_DRIVER_PROBE, { cwd: root })
}

async function main() {
    if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') return
    const probe = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
    if (probe.status !== 0) return
    const root = stripGitLineTerminator(probe.stdout)

    assertSupportedGit(root)
    const gitDirectory = stripGitLineTerminator(git(['rev-parse', '--absolute-git-dir'], root).stdout)
    const commonOutput = stripGitLineTerminator(git(['rev-parse', '--git-common-dir'], root).stdout)
    const commonDirectory = isAbsolute(commonOutput) ? commonOutput : resolve(root, commonOutput)
    const commonConfigPath = join(commonDirectory, 'config')
    const worktreeConfigPath = join(gitDirectory, 'config.worktree')
    const releaseLock = await acquireInstallLock(commonDirectory)
    let installationError

    try {
        assertCommonConfigFile(commonConfigPath)
        assertWorktreeConfigFiles(
            root,
            commonDirectory,
            commonConfigPath,
            worktreeConfigPath,
        )
        const migration = planWorktreeConfigMigration(root, commonConfigPath)
        applyWorktreeConfigMigration(root, commonConfigPath, migration)

        let rollbackPairingMergeDriver = () => {}
        try {
            probePairingMergeDriver(root)
            rollbackPairingMergeDriver = installPairingMergeDriver(root, worktreeConfigPath)
        } catch (error) {
            const rollbackErrors = []
            try {
                rollbackPairingMergeDriver()
            } catch (rollbackError) {
                rollbackErrors.push(rollbackError)
            }
            if (rollbackErrors.length > 0) {
                throw new AggregateError(
                    [error, ...rollbackErrors],
                    `Translation pairing installation failed: ${String(error)}; `
                    + `rollback also failed: ${rollbackErrors.map(String).join('; ')}`,
                )
            }
            throw error
        }
    } catch (error) {
        installationError = error
        throw error
    } finally {
        try {
            releaseLock()
        } catch (releaseError) {
            if (installationError !== undefined) {
                throw new AggregateError(
                    [installationError, releaseError],
                    `Translation pairing installation failed: ${String(installationError)}; installer lock release also failed: ${String(releaseError)}`,
                )
            }
            throw releaseError
        }
    }
}

try {
    await main()
} catch (error) {
    console.error(`[install-translation-pairing] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
}
