const assert = require('node:assert/strict');
const test = require('node:test');

const {
    CreatePromotionMarker,
    ParsePromotionBranch,
    ParsePromotionMarker,
    ParseTag
} = require('./promotion-contract.cjs');
const OpenPromotion = require('./open-promotion.cjs');
const FinalizePromotion = require('./finalize-promotion.cjs');

const SOURCE_SHA = '0123456789abcdef0123456789abcdef01234567';
const PRODUCTION_SHA = '1111111111111111111111111111111111111111';

test('ParseTag maps a Core tag to production promotion', () =>
{
    assert.deepEqual(ParseTag('core/2.0.1'), {
        component: 'core',
        boosterName: '',
        releaseLine: '2.0',
        tag: 'core/2.0.1',
        promotionBranch: 'promotion/core/2.0.1',
        parentBaseBranch: 'production'
    });
});

test('ParseTag maps a Booster tag to its versioned parent branch', () =>
{
    assert.deepEqual(ParseTag('boost/demo/2.0.3'), {
        component: 'booster',
        boosterName: 'demo',
        releaseLine: '2.0',
        tag: 'boost/demo/2.0.3',
        promotionBranch: 'promotion/boost/demo/2.0.3',
        parentBaseBranch: 'boost/demo/2.0'
    });
});

test('ParseTag rejects unsupported names and leading zeroes', () =>
{
    for (const tag of ['core/02.0.1', 'core/2.0', 'boost/Demo/2.0.1', 'other/2.0.1'])
    {
        assert.throws(() => ParseTag(tag), /invalid/i);
    }
});

test('ParsePromotionBranch accepts only immutable promotion branches', () =>
{
    assert.equal(ParsePromotionBranch('promotion/core/2.0.1').tag, 'core/2.0.1');
    assert.equal(
        ParsePromotionBranch('promotion/boost/demo/2.0.1').tag,
        'boost/demo/2.0.1'
    );
    assert.throws(() => ParsePromotionBranch('release/2.0'), /promotion/i);
});

test('Promotion marker round-trips canonical release metadata', () =>
{
    const contract = ParseTag('core/2.0.1');
    const marker = CreatePromotionMarker(
        contract,
        SOURCE_SHA,
        'imperia-scm/scp-studio-development',
        'https://github.com/imperia-scm/scp-management/actions/runs/42'
    );

    assert.deepEqual(ParsePromotionMarker(`Release promotion\n\n${marker}`), {
        schemaVersion: 1,
        tag: 'core/2.0.1',
        sourceSha: SOURCE_SHA,
        sourceRepository: 'imperia-scm/scp-studio-development',
        runUrl: 'https://github.com/imperia-scm/scp-management/actions/runs/42'
    });
});

test('Promotion marker rejects missing, duplicate and malformed metadata', () =>
{
    const contract = ParseTag('core/2.0.1');
    const marker = CreatePromotionMarker(
        contract,
        SOURCE_SHA,
        'imperia-scm/scp-studio-development',
        'https://github.com/imperia-scm/scp-management/actions/runs/42'
    );

    assert.throws(() => ParsePromotionMarker('No marker'), /marker/i);
    assert.throws(() => ParsePromotionMarker(`${marker}\n${marker}`), /exactly one/i);
    assert.throws(
        () => ParsePromotionMarker('<!-- scp-promotion:{"schemaVersion":1} -->'),
        /metadata/i
    );
    assert.throws(() => ParsePromotionMarker('<!-- scp-promotion:{'), /malformed/i);
    assert.throws(() => ParsePromotionMarker('<!-- scp-promotion:no-json -->'), /JSON/i);
    assert.throws(
        () => CreatePromotionMarker(null, SOURCE_SHA, 'owner/repo', 'https://example.test'),
        /SHA/i
    );
    assert.throws(
        () => CreatePromotionMarker(contract, SOURCE_SHA, 'invalid', 'https://example.test'),
        /repository/i
    );
    assert.throws(
        () => CreatePromotionMarker(contract, SOURCE_SHA, 'owner/repo', 'http://example.test'),
        /URL/i
    );
});

function CreateNotFoundError()
{
    const error = new Error('Not Found');
    error.status = 404;
    return error;
}

function CreatePromotionGithub(options = {})
{
    const createdReferences = [];
    const createdPullRequests = [];
    const existingReferences = options.existingReferences || {};
    const existingPullRequests = options.existingPullRequests || [];
    const github = {
        rest: {
            git: {
                getRef: async (parameters) =>
                {
                    if (parameters.ref === `tags/${options.tag || 'core/2.0.0'}`)
                    {
                        return { data: { object: { type: 'tag', sha: 'tag-object' } } };
                    }
                    if (parameters.ref === 'heads/production')
                    {
                        return { data: { object: { type: 'commit', sha: PRODUCTION_SHA } } };
                    }
                    if (existingReferences[parameters.ref])
                    {
                        return { data: { object: existingReferences[parameters.ref] } };
                    }

                    throw CreateNotFoundError();
                },
                getTag: async () => ({
                    data: { object: { type: 'commit', sha: SOURCE_SHA } }
                }),
                createRef: async (parameters) =>
                {
                    createdReferences.push(parameters);
                    return { data: { ref: parameters.ref, object: { sha: parameters.sha } } };
                }
            },
            pulls: {
                list: async () => ({ data: existingPullRequests }),
                create: async (parameters) =>
                {
                    createdPullRequests.push(parameters);
                    return {
                        data: {
                            number: 41,
                            html_url: 'https://github.com/imperia-scm/scp-codex/pull/41',
                            body: parameters.body,
                            head: { ref: parameters.head.split(':')[1], sha: SOURCE_SHA },
                            base: { ref: parameters.base }
                        }
                    };
                }
            }
        }
    };

    return { github, createdReferences, createdPullRequests };
}

function CreateOpenPromotionParameters(github, overrides = {})
{
    return {
        github,
        core: { setOutput: () => {}, info: () => {} },
        inputs: {
            DEVELOPMENT_OWNER: 'imperia-scm',
            DEVELOPMENT_REPOSITORY: 'scp-studio-development',
            PARENT_OWNER: 'imperia-scm',
            PARENT_REPOSITORY: 'scp-codex',
            TAG: 'core/2.0.0',
            TARGET_SHA: SOURCE_SHA,
            RUN_URL: 'https://github.com/imperia-scm/scp-management/actions/runs/42',
            ...overrides
        }
    };
}

test('OpenPromotion creates an immutable Core snapshot and parent pull request', async () =>
{
    const state = CreatePromotionGithub();

    const result = await OpenPromotion(CreateOpenPromotionParameters(state.github));

    assert.equal(result.promotionBranch, 'promotion/core/2.0.0');
    assert.equal(state.createdReferences.length, 1);
    assert.deepEqual(state.createdReferences[0], {
        owner: 'imperia-scm',
        repo: 'scp-studio-development',
        ref: 'refs/heads/promotion/core/2.0.0',
        sha: SOURCE_SHA
    });
    assert.equal(state.createdPullRequests.length, 1);
    assert.equal(state.createdPullRequests[0].base, 'production');
    assert.equal(state.createdPullRequests[0].head, 'imperia-scm:promotion/core/2.0.0');
    assert.equal(state.createdPullRequests[0].head_repo, 'scp-studio-development');
});

test('OpenPromotion creates a missing Booster base from parent production', async () =>
{
    const state = CreatePromotionGithub({ tag: 'boost/demo/2.0.0' });
    const parameters = CreateOpenPromotionParameters(state.github, {
        TAG: 'boost/demo/2.0.0'
    });

    const result = await OpenPromotion(parameters);

    assert.equal(result.parentBaseBranch, 'boost/demo/2.0');
    assert.equal(result.parentBranchCreated, true);
    assert.deepEqual(state.createdReferences[1], {
        owner: 'imperia-scm',
        repo: 'scp-codex',
        ref: 'refs/heads/boost/demo/2.0',
        sha: PRODUCTION_SHA
    });
});

test('OpenPromotion rejects an existing snapshot at another SHA', async () =>
{
    const state = CreatePromotionGithub({
        existingReferences: {
            'heads/promotion/core/2.0.0': {
                type: 'commit',
                sha: PRODUCTION_SHA
            }
        }
    });

    await assert.rejects(
        OpenPromotion(CreateOpenPromotionParameters(state.github)),
        /snapshot.*instead of/i
    );
    assert.equal(state.createdPullRequests.length, 0);
});

test('OpenPromotion reuses matching snapshot and pull request', async () =>
{
    const contract = ParseTag('core/2.0.0');
    const marker = CreatePromotionMarker(
        contract,
        SOURCE_SHA,
        'imperia-scm/scp-studio-development',
        'https://github.com/imperia-scm/scp-management/actions/runs/41'
    );
    const existingPullRequest = {
        number: 41,
        html_url: 'https://example.test/pull/41',
        state: 'open',
        body: marker,
        head: { sha: SOURCE_SHA },
        base: { ref: 'production' }
    };
    const state = CreatePromotionGithub({
        existingReferences: {
            'heads/promotion/core/2.0.0': { type: 'commit', sha: SOURCE_SHA }
        },
        existingPullRequests: [existingPullRequest]
    });

    const result = await OpenPromotion(CreateOpenPromotionParameters(state.github));

    assert.equal(result.pullRequestNumber, 41);
    assert.equal(state.createdReferences.length, 0);
    assert.equal(state.createdPullRequests.length, 0);
});

test('OpenPromotion rejects conflicting or duplicate pull requests', async () =>
{
    const contract = ParseTag('core/2.0.0');
    const conflictingMarker = CreatePromotionMarker(
        contract,
        PRODUCTION_SHA,
        'imperia-scm/scp-studio-development',
        'https://github.com/imperia-scm/scp-management/actions/runs/42'
    );
    const pullRequest = {
        state: 'open',
        body: conflictingMarker,
        head: { sha: SOURCE_SHA },
        base: { ref: 'production' }
    };
    const conflicting = CreatePromotionGithub({ existingPullRequests: [pullRequest] });
    await assert.rejects(
        OpenPromotion(CreateOpenPromotionParameters(conflicting.github)),
        /metadata conflicts/i
    );

    const duplicate = CreatePromotionGithub({ existingPullRequests: [pullRequest, pullRequest] });
    await assert.rejects(
        OpenPromotion(CreateOpenPromotionParameters(duplicate.github)),
        /more than one/i
    );
});

test('OpenPromotion validates required inputs, SHA and source tag', async () =>
{
    const state = CreatePromotionGithub();
    await assert.rejects(
        OpenPromotion(CreateOpenPromotionParameters(state.github, { RUN_URL: '' })),
        /RUN_URL is required/i
    );
    await assert.rejects(
        OpenPromotion(CreateOpenPromotionParameters(state.github, { TARGET_SHA: 'bad' })),
        /target SHA/i
    );

    const missingTag = CreatePromotionGithub();
    missingTag.github.rest.git.getRef = async () => { throw CreateNotFoundError(); };
    await assert.rejects(
        OpenPromotion(CreateOpenPromotionParameters(missingTag.github)),
        /tag.*does not exist/i
    );
});

test('EnsureReference recovers from a concurrent matching creation', async () =>
{
    let readCount = 0;
    const github = {
        rest: {
            git: {
                getRef: async () =>
                {
                    readCount++;
                    if (readCount === 1)
                    {
                        throw CreateNotFoundError();
                    }
                    return { data: { object: { type: 'commit', sha: SOURCE_SHA } } };
                },
                createRef: async () =>
                {
                    const error = new Error('already exists');
                    error.status = 422;
                    throw error;
                }
            }
        }
    };

    const created = await OpenPromotion.EnsureReference({
        github,
        owner: 'owner',
        repository: 'repository',
        branch: 'promotion/core/2.0.0',
        targetSha: SOURCE_SHA,
        displayName: 'Snapshot'
    });

    assert.equal(created, false);
});

test('OpenPromotion helpers propagate API failures and source-tag conflicts', async () =>
{
    const apiError = new Error('GitHub unavailable');
    apiError.status = 500;
    const github = { rest: { git: { getRef: async () => { throw apiError; } } } };
    await assert.rejects(
        OpenPromotion.GetReferenceOrNull(github, 'owner', 'repo', 'heads/main'),
        /unavailable/i
    );

    const state = CreatePromotionGithub();
    state.github.rest.git.getTag = async () => ({
        data: { object: { type: 'commit', sha: PRODUCTION_SHA } }
    });
    await assert.rejects(
        OpenPromotion(CreateOpenPromotionParameters(state.github)),
        /resolves to.*instead of/i
    );
});

test('EnsureReference rejects unrecoverable and conflicting concurrent creation', async () =>
{
    const parameters = {
        owner: 'owner',
        repository: 'repo',
        branch: 'promotion/core/2.0.0',
        targetSha: SOURCE_SHA,
        displayName: 'Snapshot'
    };
    const apiError = new Error('server failure');
    apiError.status = 500;
    const unrecoverable = {
        rest: {
            git: {
                getRef: async () => { throw CreateNotFoundError(); },
                createRef: async () => { throw apiError; }
            }
        }
    };
    await assert.rejects(
        OpenPromotion.EnsureReference({ github: unrecoverable, ...parameters }),
        /server failure/i
    );

    let readCount = 0;
    const conflicting = {
        rest: {
            git: {
                getRef: async () =>
                {
                    readCount++;
                    if (readCount === 1)
                    {
                        throw CreateNotFoundError();
                    }
                    return { data: { object: { type: 'commit', sha: PRODUCTION_SHA } } };
                },
                createRef: async () =>
                {
                    const error = new Error('exists');
                    error.status = 422;
                    throw error;
                }
            }
        }
    };
    await assert.rejects(
        OpenPromotion.EnsureReference({ github: conflicting, ...parameters }),
        /concurrently created.*instead of/i
    );
});

test('EnsureBoosterBaseBranch reuses an existing base and requires production', async () =>
{
    const contract = ParseTag('boost/demo/2.0.0');
    const existing = {
        rest: {
            git: {
                getRef: async () => ({
                    data: { object: { type: 'commit', sha: PRODUCTION_SHA } }
                })
            }
        }
    };
    assert.equal(await OpenPromotion.EnsureBoosterBaseBranch({
        github: existing,
        contract,
        parentOwner: 'owner',
        parentRepository: 'repo'
    }), false);

    const missing = {
        rest: { git: { getRef: async () => { throw CreateNotFoundError(); } } }
    };
    await assert.rejects(
        OpenPromotion.EnsureBoosterBaseBranch({
            github: missing,
            contract,
            parentOwner: 'owner',
            parentRepository: 'repo'
        }),
        /production branch does not exist/i
    );
});

test('EnsurePromotionPullRequest rejects mismatched existing pull request fields', async () =>
{
    const contract = ParseTag('core/2.0.0');
    const marker = CreatePromotionMarker(
        contract,
        SOURCE_SHA,
        'imperia-scm/scp-studio-development',
        'https://example.test/run'
    );
    const baseParameters = {
        contract,
        developmentOwner: 'imperia-scm',
        developmentRepository: 'scp-studio-development',
        parentOwner: 'imperia-scm',
        parentRepository: 'scp-codex',
        targetSha: SOURCE_SHA,
        runUrl: 'https://example.test/run'
    };
    for (const [pullRequest, message] of [
        [{ state: 'open', body: marker, head: { sha: PRODUCTION_SHA }, base: { ref: 'production' } }, /head is/i],
        [{ state: 'open', body: marker, head: { sha: SOURCE_SHA }, base: { ref: 'main' } }, /unexpected parent branch/i],
        [{ state: 'closed', body: marker, head: { sha: SOURCE_SHA }, base: { ref: 'production' } }, /closed without merging/i]
    ])
    {
        const github = { rest: { pulls: { list: async () => ({ data: [pullRequest] }) } } };
        await assert.rejects(
            OpenPromotion.EnsurePromotionPullRequest({ github, ...baseParameters }),
            message
        );
    }
});

const MERGE_SHA = '2222222222222222222222222222222222222222';

function CreateFinalizationGithub(options = {})
{
    const tag = options.tag || 'core/2.0.0';
    const contract = ParseTag(tag);
    const marker = CreatePromotionMarker(
        contract,
        SOURCE_SHA,
        'imperia-scm/scp-studio-development',
        'https://github.com/imperia-scm/scp-management/actions/runs/42'
    );
    const createdTags = [];
    const createdReferences = [];
    const createdPullRequests = [];
    const deletedReferences = [];
    const pullRequest = {
        number: 51,
        state: options.state || 'closed',
        merged: options.merged === undefined ? true : options.merged,
        merged_at: options.merged === false ? null : '2026-08-20T10:00:00Z',
        merge_commit_sha: MERGE_SHA,
        body: marker,
        head: {
            ref: contract.promotionBranch,
            sha: SOURCE_SHA,
            repo: { full_name: 'imperia-scm/scp-studio-development' }
        },
        base: { ref: contract.parentBaseBranch },
        html_url: 'https://github.com/imperia-scm/scp-codex/pull/51'
    };
    const github = {
        rest: {
            pulls: {
                get: async () => ({ data: pullRequest }),
                list: async () => ({ data: options.existingReturnPullRequests || [] }),
                create: async (parameters) =>
                {
                    createdPullRequests.push(parameters);
                    return { data: { number: 52, html_url: 'https://example.test/pull/52' } };
                }
            },
            git: {
                getRef: async (parameters) =>
                {
                    if (!options.missingSourceTag && parameters.repo === 'scp-studio-development' &&
                        parameters.ref === `tags/${tag}`)
                    {
                        return { data: { object: { type: 'tag', sha: 'source-tag-object' } } };
                    }
                    if (!options.missingSnapshot && parameters.repo === 'scp-studio-development' &&
                        parameters.ref === `heads/${contract.promotionBranch}`)
                    {
                        return {
                            data: {
                                object: {
                                    type: 'commit',
                                    sha: options.snapshotSha || SOURCE_SHA
                                }
                            }
                        };
                    }
                    if (parameters.repo === 'scp-codex' && parameters.ref === `tags/${tag}`)
                    {
                        if (options.parentTagExists)
                        {
                            return { data: { object: { type: 'tag', sha: 'parent-tag-object' } } };
                        }
                        throw CreateNotFoundError();
                    }

                    throw CreateNotFoundError();
                },
                getTag: async (parameters) => ({
                    data: {
                        object: {
                            type: 'commit',
                            sha: parameters.repo === 'scp-codex' ? MERGE_SHA : SOURCE_SHA
                        }
                    }
                }),
                createTag: async (parameters) =>
                {
                    createdTags.push(parameters);
                    return { data: { sha: 'parent-tag-object' } };
                },
                createRef: async (parameters) =>
                {
                    createdReferences.push(parameters);
                    return { data: {} };
                },
                deleteRef: async (parameters) =>
                {
                    deletedReferences.push(parameters);
                    return { data: {} };
                }
            },
            repos: {
                getCommit: async () => ({
                    data: {
                        sha: MERGE_SHA,
                        parents: [{ sha: PRODUCTION_SHA }, { sha: SOURCE_SHA }]
                    }
                }),
                compareCommitsWithBasehead: async () => ({
                    data: { ahead_by: options.aheadBy === undefined ? 1 : options.aheadBy }
                })
            }
        }
    };

    return {
        github,
        pullRequest,
        createdTags,
        createdReferences,
        createdPullRequests,
        deletedReferences
    };
}

function CreateFinalizationParameters(github)
{
    return {
        github,
        core: { setOutput: () => {}, info: () => {} },
        inputs: {
            PARENT_OWNER: 'imperia-scm',
            PARENT_REPOSITORY: 'scp-codex',
            DEVELOPMENT_OWNER: 'imperia-scm',
            DEVELOPMENT_REPOSITORY: 'scp-studio-development',
            DEVELOPMENT_TRUNK_BRANCH: 'main_development',
            PULL_REQUEST_NUMBER: '51',
            RUN_URL: 'https://github.com/imperia-scm/scp-management/actions/runs/99'
        }
    };
}

test('FinalizePromotion tags a valid Core merge and opens production reintegration', async () =>
{
    const state = CreateFinalizationGithub();

    const result = await FinalizePromotion(CreateFinalizationParameters(state.github));

    assert.equal(result.contract.tag, 'core/2.0.0');
    assert.equal(state.createdTags[0].object, MERGE_SHA);
    assert.equal(state.createdPullRequests[0].base, 'main_development');
    assert.equal(state.createdPullRequests[0].head, 'imperia-scm:production');
    assert.equal(state.createdPullRequests[0].head_repo, 'scp-codex');
    assert.deepEqual(state.deletedReferences[0], {
        owner: 'imperia-scm',
        repo: 'scp-studio-development',
        ref: 'heads/promotion/core/2.0.0'
    });
});

test('FinalizePromotion tags a valid Booster merge and reintegrates its parent branch', async () =>
{
    const state = CreateFinalizationGithub({ tag: 'boost/demo/2.0.0' });

    await FinalizePromotion(CreateFinalizationParameters(state.github));

    assert.equal(state.createdPullRequests[0].head, 'imperia-scm:boost/demo/2.0');
});

test('FinalizePromotion rejects an open pull request', async () =>
{
    const state = CreateFinalizationGithub({ state: 'open', merged: false });

    await assert.rejects(
        FinalizePromotion(CreateFinalizationParameters(state.github)),
        /merged/i
    );
    assert.equal(state.createdTags.length, 0);
});

test('FinalizePromotion rejects squash and rebase merge topology', async () =>
{
    const state = CreateFinalizationGithub();
    state.github.rest.repos.getCommit = async () => ({
        data: { sha: MERGE_SHA, parents: [{ sha: PRODUCTION_SHA }] }
    });

    await assert.rejects(
        FinalizePromotion(CreateFinalizationParameters(state.github)),
        /merge commit/i
    );
    assert.equal(state.deletedReferences.length, 0);
});

test('FinalizePromotion skips a return pull request when comparison is empty', async () =>
{
    const state = CreateFinalizationGithub({ aheadBy: 0 });

    const result = await FinalizePromotion(CreateFinalizationParameters(state.github));

    assert.equal(result.reintegration, null);
    assert.equal(state.createdPullRequests.length, 0);
    assert.equal(state.deletedReferences.length, 1);
});

test('FinalizePromotion reuses an existing parent tag and reintegration pull request', async () =>
{
    const existingPullRequest = { number: 60, html_url: 'https://example.test/pull/60' };
    const state = CreateFinalizationGithub({
        parentTagExists: true,
        existingReturnPullRequests: [existingPullRequest]
    });

    const result = await FinalizePromotion(CreateFinalizationParameters(state.github));

    assert.equal(result.tagExisted, true);
    assert.equal(result.reintegration, existingPullRequest);
    assert.equal(state.createdTags.length, 0);
    assert.equal(state.createdPullRequests.length, 0);
});

test('FinalizePromotion treats a missing snapshot as already cleaned', async () =>
{
    const state = CreateFinalizationGithub({ missingSnapshot: true });

    const result = await FinalizePromotion(CreateFinalizationParameters(state.github));

    assert.equal(result.snapshotDeleted, false);
});

test('FinalizePromotion rejects invalid identity and marker disagreements before mutation', async () =>
{
    const invalidNumber = CreateFinalizationGithub();
    const invalidParameters = CreateFinalizationParameters(invalidNumber.github);
    invalidParameters.inputs.PULL_REQUEST_NUMBER = '0';
    await assert.rejects(FinalizePromotion(invalidParameters), /positive/i);

    const wrongMarker = CreateFinalizationGithub();
    wrongMarker.pullRequest.body = wrongMarker.pullRequest.body.replace(SOURCE_SHA, PRODUCTION_SHA);
    await assert.rejects(
        FinalizePromotion(CreateFinalizationParameters(wrongMarker.github)),
        /marker does not match/i
    );
    assert.equal(wrongMarker.createdTags.length, 0);
});

test('FinalizePromotion rejects missing Development tags and moved snapshots', async () =>
{
    const missingTag = CreateFinalizationGithub({ missingSourceTag: true });
    await assert.rejects(
        FinalizePromotion(CreateFinalizationParameters(missingTag.github)),
        /tag.*does not exist/i
    );

    const movedSnapshot = CreateFinalizationGithub({ snapshotSha: PRODUCTION_SHA });
    await assert.rejects(
        FinalizePromotion(CreateFinalizationParameters(movedSnapshot.github)),
        /snapshot moved/i
    );
    assert.equal(movedSnapshot.deletedReferences.length, 0);
});

test('FinalizePromotion rejects duplicate reintegration pull requests', async () =>
{
    const pullRequest = { number: 60 };
    const state = CreateFinalizationGithub({
        existingReturnPullRequests: [pullRequest, pullRequest]
    });

    await assert.rejects(
        FinalizePromotion(CreateFinalizationParameters(state.github)),
        /more than one reintegration/i
    );
    assert.equal(state.deletedReferences.length, 0);
});

