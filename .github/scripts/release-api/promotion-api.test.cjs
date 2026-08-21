const assert = require('node:assert/strict');
const test = require('node:test');

const {
    CreatePromotionMarker,
    ParsePromotionMarker,
    ParseTag
} = require('./promotion-contract.cjs');
const OpenPromotion = require('./open-promotion.cjs');
const ValidatePromotion = require('./validate-promotion.cjs');
const FinalizePromotion = require('./finalize-promotion.cjs');

const SOURCE_SHA = '0123456789abcdef0123456789abcdef01234567';
const NEXT_SHA = '1111111111111111111111111111111111111111';
const PRODUCTION_SHA = '2222222222222222222222222222222222222222';
const MERGE_SHA = '3333333333333333333333333333333333333333';
const CONTRACT_SECRET = '0123456789abcdef0123456789abcdef';

function CreateMarkerMetadata(overrides = {})
{
    return {
        schemaVersion: 2,
        tag: 'core/2.0.0',
        sourceRepository: 'imperia-scm/tags-slave-repo-fork',
        sourceBranch: 'release/2.0',
        parentRepository: 'Imperia-Rminana/tags-slave-repo',
        parentBaseBranch: 'production',
        previousTag: 'core/1.9.4',
        isOverride: false,
        overrideReason: '',
        requestedBy: 'release-manager',
        approvalRunUrl: 'https://github.com/Imperia-Rminana/tags-master-repo/actions/runs/42',
        ...overrides
    };
}

test('ParseTag maps tags to direct source and parent branches', () =>
{
    assert.deepEqual(ParseTag('core/2.0.1'), {
        component: 'core',
        boosterName: '',
        releaseLine: '2.0',
        version: '2.0.1',
        tag: 'core/2.0.1',
        sourceBranch: 'release/2.0',
        parentBaseBranch: 'production'
    });
    assert.deepEqual(ParseTag('boost/demo/2.0.3'), {
        component: 'booster',
        boosterName: 'demo',
        releaseLine: '2.0',
        version: '2.0.3',
        tag: 'boost/demo/2.0.3',
        sourceBranch: 'boost/demo/2.0',
        parentBaseBranch: 'boost/demo/2.0'
    });
    assert.throws(() => ParseTag('core/2x0x1'), /invalid/);
    assert.throws(() => ParseTag('boost/demo/2x0x1'), /invalid/);
});

test('signed promotion marker round-trips canonical metadata', () =>
{
    const marker = CreatePromotionMarker(CreateMarkerMetadata(), CONTRACT_SECRET, 41);
    const parsed = ParsePromotionMarker(`Candidate\n\n${marker}`, CONTRACT_SECRET, 41);

    assert.deepEqual(parsed, CreateMarkerMetadata());
    assert.match(marker, /"signature":"sha256=[0-9a-f]{64}"/);
});

test('signed promotion marker rejects tampering, wrong secrets and unknown fields', () =>
{
    const marker = CreatePromotionMarker(CreateMarkerMetadata(), CONTRACT_SECRET, 41);

    assert.throws(
        () => ParsePromotionMarker(
            marker.replace('core/2.0.0', 'core/9.0.0'), CONTRACT_SECRET, 41
        ),
        /signature/i
    );
    assert.throws(
        () => ParsePromotionMarker(marker, 'abcdef0123456789abcdef0123456789', 41),
        /signature/i
    );
    assert.throws(
        () => CreatePromotionMarker(
            { ...CreateMarkerMetadata(), unexpected: true }, CONTRACT_SECRET, 41
        ),
        /fields/i
    );
    assert.throws(
        () => CreatePromotionMarker(CreateMarkerMetadata(), 'short', 41),
        /secret/i
    );
    assert.throws(
        () => CreatePromotionMarker(CreateMarkerMetadata({
            isOverride: true,
            overrideReason: 'Approved --> copied marker'
        }), CONTRACT_SECRET, 41),
        /delimiter/i
    );
    assert.throws(
        () => ParsePromotionMarker(
            '<!-- scp-promotion:{"schemaVersion":1} -->', CONTRACT_SECRET, 41
        ),
        /schema/i
    );
    assert.throws(
        () => ParsePromotionMarker(marker, CONTRACT_SECRET, 42),
        /signature/i
    );
});

function CreateNotFoundError()
{
    const error = new Error('Not Found');
    error.status = 404;
    return error;
}

function CreateOpenPromotionGithub(options = {})
{
    const createdReferences = [];
    const createdPullRequests = [];
    const updatedPullRequests = [];
    const createdStatuses = [];
    const pullRequests = options.pullRequests || [];
    const github = {
        rest: {
            git: {
                getRef: async (parameters) =>
                {
                    if (parameters.repo === 'tags-slave-repo-fork' &&
                        parameters.ref === `heads/${options.sourceBranch || 'release/2.0'}`)
                    {
                        return {
                            data: {
                                object: {
                                    type: 'commit',
                                    sha: options.sourceSha || SOURCE_SHA
                                }
                            }
                        };
                    }
                    if (parameters.repo === 'tags-slave-repo' && parameters.ref === 'heads/production')
                    {
                        return { data: { object: { type: 'commit', sha: PRODUCTION_SHA } } };
                    }
                    if (options.parentBranchExists && parameters.repo === 'tags-slave-repo')
                    {
                        return { data: { object: { type: 'commit', sha: PRODUCTION_SHA } } };
                    }

                    throw CreateNotFoundError();
                },
                createRef: async (parameters) =>
                {
                    createdReferences.push(parameters);
                    return { data: parameters };
                }
            },
            pulls: {
                list: async () => ({ data: pullRequests }),
                create: async (parameters) =>
                {
                    createdPullRequests.push(parameters);
                    return {
                        data: {
                            number: 41,
                            html_url: 'https://github.com/Imperia-Rminana/tags-slave-repo/pull/41',
                            state: 'open',
                            body: parameters.body,
                            head: {
                                ref: parameters.head.split(':')[1],
                                sha: SOURCE_SHA,
                                repo: { full_name: 'imperia-scm/tags-slave-repo-fork' }
                            },
                            base: { ref: parameters.base }
                        }
                    };
                },
                update: async (parameters) =>
                {
                    updatedPullRequests.push(parameters);
                    return {
                        data: {
                            number: parameters.pull_number,
                            html_url: `https://github.com/Imperia-Rminana/tags-slave-repo/pull/${parameters.pull_number}`,
                            state: 'open',
                            body: parameters.body,
                            head: {
                                ref: options.sourceBranch || 'release/2.0',
                                sha: options.sourceSha || SOURCE_SHA,
                                repo: { full_name: 'imperia-scm/tags-slave-repo-fork' }
                            },
                            base: {
                                ref: options.sourceBranch && options.sourceBranch.startsWith('boost/')
                                    ? options.sourceBranch
                                    : 'production'
                            }
                        }
                    };
                }
            },
            repos: {
                createCommitStatus: async (parameters) =>
                {
                    createdStatuses.push(parameters);
                    return { data: parameters };
                }
            }
        }
    };

    return {
        github,
        createdReferences,
        createdPullRequests,
        updatedPullRequests,
        createdStatuses
    };
}

function CreateOpenPromotionParameters(github, overrides = {})
{
    return {
        github,
        core: { setOutput: () => {}, info: () => {} },
        inputs: {
            DEVELOPMENT_OWNER: 'imperia-scm',
            DEVELOPMENT_REPOSITORY: 'tags-slave-repo-fork',
            PARENT_OWNER: 'Imperia-Rminana',
            PARENT_REPOSITORY: 'tags-slave-repo',
            TAG: 'core/2.0.0',
            TARGET_SHA: SOURCE_SHA,
            SOURCE_BRANCH: 'release/2.0',
            PREVIOUS_TAG: 'core/1.9.4',
            IS_OVERRIDE: 'false',
            OVERRIDE_REASON: '',
            REQUESTED_BY: 'release-manager',
            RUN_URL: 'https://github.com/Imperia-Rminana/tags-master-repo/actions/runs/42',
            CONTRACT_SECRET,
            ...overrides
        }
    };
}

test('OpenPromotion opens a direct Core PR and marks the built SHA successful', async () =>
{
    const state = CreateOpenPromotionGithub();

    const result = await OpenPromotion(CreateOpenPromotionParameters(state.github));

    assert.equal(result.sourceBranch, 'release/2.0');
    assert.equal(result.pullRequestNumber, 41);
    assert.equal(state.createdReferences.length, 0);
    assert.equal(state.createdPullRequests.length, 1);
    assert.equal(state.createdPullRequests[0].head, 'imperia-scm:release/2.0');
    assert.equal(state.createdPullRequests[0].head_repo, 'tags-slave-repo-fork');
    assert.equal(state.createdPullRequests[0].base, 'production');
    assert.equal(
        state.createdPullRequests[0].body,
        'Release candidate contract is being signed by scp-management.'
    );
    assert.equal(state.updatedPullRequests[0].pull_number, 41);
    assert.deepEqual(
        ParsePromotionMarker(state.updatedPullRequests[0].body, CONTRACT_SECRET, 41),
        CreateMarkerMetadata()
    );
    assert.deepEqual(state.createdStatuses[0], {
        owner: 'Imperia-Rminana',
        repo: 'tags-slave-repo',
        sha: SOURCE_SHA,
        state: 'success',
        context: 'scp-management/release-candidate',
        description: 'Release candidate build passed',
        target_url: 'https://github.com/Imperia-Rminana/tags-master-repo/actions/runs/42'
    });
});

test('OpenPromotion creates a missing Booster base and opens from the direct Booster branch', async () =>
{
    const state = CreateOpenPromotionGithub({ sourceBranch: 'boost/demo/2.0' });
    const parameters = CreateOpenPromotionParameters(state.github, {
        TAG: 'boost/demo/2.0.0',
        SOURCE_BRANCH: 'boost/demo/2.0',
        PREVIOUS_TAG: 'boost/demo/1.9.0'
    });

    const result = await OpenPromotion(parameters);

    assert.equal(result.parentBranchCreated, true);
    assert.deepEqual(state.createdReferences[0], {
        owner: 'Imperia-Rminana',
        repo: 'tags-slave-repo',
        ref: 'refs/heads/boost/demo/2.0',
        sha: PRODUCTION_SHA
    });
    assert.equal(state.createdPullRequests[0].head, 'imperia-scm:boost/demo/2.0');
    assert.equal(state.createdPullRequests[0].base, 'boost/demo/2.0');
});

test('OpenPromotion reuses a matching signed open PR after the source branch advances', async () =>
{
    const marker = CreatePromotionMarker(CreateMarkerMetadata(), CONTRACT_SECRET, 40);
    const existingPullRequest = {
        number: 40,
        html_url: 'https://github.com/Imperia-Rminana/tags-slave-repo/pull/40',
        state: 'open',
        body: marker,
        head: {
            ref: 'release/2.0',
            sha: NEXT_SHA,
            repo: { full_name: 'imperia-scm/tags-slave-repo-fork' }
        },
        base: { ref: 'production' }
    };
    const state = CreateOpenPromotionGithub({
        pullRequests: [existingPullRequest],
        sourceSha: NEXT_SHA
    });

    const result = await OpenPromotion(CreateOpenPromotionParameters(state.github, {
        TARGET_SHA: NEXT_SHA
    }));

    assert.equal(result.pullRequestNumber, 40);
    assert.equal(state.createdPullRequests.length, 0);
    assert.equal(state.createdStatuses[0].sha, NEXT_SHA);
});

test('OpenPromotion repairs a PR whose contract update was interrupted', async () =>
{
    const pendingPullRequest = {
        number: 40,
        html_url: 'https://github.com/Imperia-Rminana/tags-slave-repo/pull/40',
        state: 'open',
        body: 'Release candidate contract is being signed by scp-management.',
        head: {
            ref: 'release/2.0',
            sha: SOURCE_SHA,
            repo: { full_name: 'imperia-scm/tags-slave-repo-fork' }
        },
        base: { ref: 'production' }
    };
    const state = CreateOpenPromotionGithub({ pullRequests: [pendingPullRequest] });

    const result = await OpenPromotion(CreateOpenPromotionParameters(state.github));

    assert.equal(result.pullRequestNumber, 40);
    assert.equal(state.createdPullRequests.length, 0);
    assert.equal(state.updatedPullRequests[0].pull_number, 40);
    assert.deepEqual(
        ParsePromotionMarker(state.updatedPullRequests[0].body, CONTRACT_SECRET, 40),
        CreateMarkerMetadata()
    );
});

test('OpenPromotion ignores a same-branch PR from the parent repository', async () =>
{
    const unrelatedPullRequest = {
        number: 39,
        state: 'open',
        body: 'Unrelated pull request',
        head: {
            ref: 'release/2.0',
            sha: SOURCE_SHA,
            repo: { full_name: 'Imperia-Rminana/tags-slave-repo' }
        },
        base: { ref: 'production' }
    };
    const state = CreateOpenPromotionGithub({ pullRequests: [unrelatedPullRequest] });

    const result = await OpenPromotion(CreateOpenPromotionParameters(state.github));

    assert.equal(result.pullRequestNumber, 41);
    assert.equal(state.createdPullRequests.length, 1);
});

test('OpenPromotion rejects branch drift and manipulated existing contracts', async () =>
{
    const moved = CreateOpenPromotionGithub({ sourceSha: NEXT_SHA });
    await assert.rejects(
        OpenPromotion(CreateOpenPromotionParameters(moved.github)),
        /moved/i
    );

    const marker = CreatePromotionMarker(CreateMarkerMetadata(), CONTRACT_SECRET, 40)
        .replace('core/2.0.0', 'core/9.0.0');
    const conflicting = CreateOpenPromotionGithub({
        pullRequests: [{
            number: 40,
            state: 'open',
            body: marker,
            head: {
                ref: 'release/2.0',
                sha: SOURCE_SHA,
                repo: { full_name: 'imperia-scm/tags-slave-repo-fork' }
            },
            base: { ref: 'production' }
        }]
    });
    await assert.rejects(
        OpenPromotion(CreateOpenPromotionParameters(conflicting.github)),
        /signature/i
    );
});

function CreateValidationGithub(options = {})
{
    const statuses = options.statuses || [];
    const createdStatuses = [];
    const pullRequest = {
        number: 41,
        state: 'open',
        body: CreatePromotionMarker(CreateMarkerMetadata(), CONTRACT_SECRET, 41),
        head: {
            ref: 'release/2.0',
            sha: options.headSha || SOURCE_SHA,
            repo: { full_name: 'imperia-scm/tags-slave-repo-fork' }
        },
        base: { ref: 'production' }
    };
    const github = {
        rest: {
            pulls: {
                get: async () => ({ data: pullRequest })
            },
            repos: {
                listCommitStatusesForRef: async () => ({ data: statuses }),
                createCommitStatus: async (parameters) =>
                {
                    createdStatuses.push(parameters);
                    return { data: parameters };
                }
            }
        }
    };
    return { github, pullRequest, createdStatuses };
}

function CreateValidationParameters(github, overrides = {})
{
    return {
        github,
        core: { setOutput: () => {}, info: () => {} },
        inputs: {
            DEVELOPMENT_OWNER: 'imperia-scm',
            DEVELOPMENT_REPOSITORY: 'tags-slave-repo-fork',
            PARENT_OWNER: 'Imperia-Rminana',
            PARENT_REPOSITORY: 'tags-slave-repo',
            PULL_REQUEST_NUMBER: '41',
            EXPECTED_HEAD_SHA: SOURCE_SHA,
            CONTRACT_SECRET,
            RUN_URL: 'https://github.com/Imperia-Rminana/tags-master-repo/actions/runs/43',
            ...overrides
        }
    };
}

test('ValidatePromotion validates the signed current head and publishes statuses', async () =>
{
    const state = CreateValidationGithub();
    const candidate = await ValidatePromotion.ReadCandidate(
        CreateValidationParameters(state.github)
    );

    assert.equal(candidate.stale, false);
    assert.equal(candidate.requiresBuild, true);
    assert.equal(candidate.headSha, SOURCE_SHA);
    assert.equal(candidate.sourceBranch, 'release/2.0');

    await ValidatePromotion.SetCandidateStatus({
        github: state.github,
        inputs: CreateValidationParameters(state.github).inputs,
        headSha: SOURCE_SHA,
        state: 'pending'
    });
    assert.equal(state.createdStatuses[0].context, 'scp-management/release-candidate');
    assert.equal(state.createdStatuses[0].state, 'pending');
});

test('ValidatePromotion ignores stale dispatches and reuses success for the same SHA', async () =>
{
    const staleState = CreateValidationGithub({ headSha: NEXT_SHA });
    const stale = await ValidatePromotion.ReadCandidate(
        CreateValidationParameters(staleState.github)
    );
    assert.equal(stale.stale, true);

    const successfulState = CreateValidationGithub({
        statuses: [{
            context: 'scp-management/release-candidate',
            state: 'success',
            sha: SOURCE_SHA
        }]
    });
    const successful = await ValidatePromotion.ReadCandidate(
        CreateValidationParameters(successfulState.github)
    );
    assert.equal(successful.requiresBuild, false);
});

test('ValidatePromotion rejects invalid candidate shape and status values', async () =>
{
    const state = CreateValidationGithub();
    state.pullRequest.base.ref = 'main';
    await assert.rejects(
        ValidatePromotion.ReadCandidate(CreateValidationParameters(state.github)),
        /target/i
    );
    await assert.rejects(
        ValidatePromotion.SetCandidateStatus({
            github: state.github,
            inputs: CreateValidationParameters(state.github).inputs,
            headSha: SOURCE_SHA,
            state: 'unknown'
        }),
        /status state/i
    );
});

function CreateFinalizationGithub(options = {})
{
    const createdTags = [];
    const createdPullRequests = [];
    const uploadedAssets = [];
    const comparisons = [];
    const listCommits = async () => undefined;
    const listReleaseAssets = async () => undefined;
    const marker = CreatePromotionMarker(CreateMarkerMetadata(), CONTRACT_SECRET, 41);
    const pullRequest = {
        number: 41,
        state: 'closed',
        merged: true,
        merged_at: '2026-08-20T10:00:00Z',
        merge_commit_sha: MERGE_SHA,
        merged_by: { login: 'merger' },
        html_url: 'https://github.com/Imperia-Rminana/tags-slave-repo/pull/41',
        body: options.body || marker,
        head: {
            ref: 'release/2.0',
            sha: options.pullHeadSha || SOURCE_SHA,
            repo: { full_name: 'imperia-scm/tags-slave-repo-fork' }
        },
        base: { ref: 'production' }
    };
    const github = {
        paginate: async (method) =>
        {
            if (method === listCommits)
            {
                return options.commits || [{ sha: SOURCE_SHA }];
            }
            if (method === listReleaseAssets)
            {
                return [];
            }
            throw new Error('Unexpected pagination method.');
        },
        rest: {
            pulls: {
                get: async () => ({ data: pullRequest }),
                listCommits,
                list: async () => ({ data: options.reintegrationPullRequests || [] }),
                create: async (parameters) =>
                {
                    createdPullRequests.push(parameters);
                    return { data: { html_url: 'https://github.com/dev/pull/99' } };
                }
            },
            git: {
                getRef: async () => { throw CreateNotFoundError(); },
                createTag: async (parameters) =>
                {
                    createdTags.push(parameters);
                    return { data: { sha: `tag-object-${createdTags.length}` } };
                },
                createRef: async (parameters) => ({ data: parameters })
            },
            repos: {
                listCommitStatusesForRef: async () => ({
                    data: options.statuses || [{
                        context: 'scp-management/release-candidate',
                        state: 'success',
                        sha: SOURCE_SHA
                    }]
                }),
                getCommit: async () => ({
                    data: {
                        sha: MERGE_SHA,
                        parents: options.parents || [
                            { sha: PRODUCTION_SHA },
                            { sha: SOURCE_SHA }
                        ]
                    }
                }),
                getReleaseByTag: async () => { throw CreateNotFoundError(); },
                generateReleaseNotes: async () => ({ data: { body: 'Generated notes' } }),
                createRelease: async () => ({ data: { id: 50 } }),
                listReleaseAssets,
                uploadReleaseAsset: async (parameters) =>
                {
                    uploadedAssets.push(parameters);
                    return { data: parameters };
                },
                compareCommitsWithBasehead: async (parameters) =>
                {
                    comparisons.push(parameters);
                    return { data: { ahead_by: 1 } };
                }
            }
        }
    };
    return {
        github,
        pullRequest,
        createdTags,
        createdPullRequests,
        uploadedAssets,
        comparisons
    };
}

function CreateFinalizationParameters(github, overrides = {})
{
    return {
        github,
        core: { outputs: {}, setOutput(name, value) { this.outputs[name] = value; }, info: () => {} },
        inputs: {
            PARENT_OWNER: 'Imperia-Rminana',
            PARENT_REPOSITORY: 'tags-slave-repo',
            DEVELOPMENT_OWNER: 'imperia-scm',
            DEVELOPMENT_REPOSITORY: 'tags-slave-repo-fork',
            DEVELOPMENT_TRUNK_BRANCH: 'main_development',
            PULL_REQUEST_NUMBER: '41',
            EXPECTED_HEAD_SHA: SOURCE_SHA,
            EXPECTED_MERGE_COMMIT_SHA: MERGE_SHA,
            CONTRACT_SECRET,
            RUN_URL: 'https://github.com/Imperia-Rminana/tags-master-repo/actions/runs/44',
            ...overrides
        }
    };
}

test('FinalizePromotion publishes Development before Codex and opens reintegration', async () =>
{
    const state = CreateFinalizationGithub();
    const parameters = CreateFinalizationParameters(state.github);

    const result = await FinalizePromotion(parameters);

    assert.equal(result.sourceSha, SOURCE_SHA);
    assert.equal(state.createdTags.length, 2);
    assert.equal(state.createdTags[0].repo, 'tags-slave-repo-fork');
    assert.equal(state.createdTags[0].object, SOURCE_SHA);
    assert.equal(state.createdTags[1].repo, 'tags-slave-repo');
    assert.equal(state.createdTags[1].object, MERGE_SHA);
    assert.equal(state.createdPullRequests[0].head, 'Imperia-Rminana:production');
    assert.equal(state.createdPullRequests[0].base, 'main_development');
    assert.equal(state.comparisons[0].basehead, `main_development...${MERGE_SHA}`);
    const metadata = JSON.parse(state.uploadedAssets[0].data.toString('utf8'));
    assert.equal(metadata.schemaVersion, 2);
    assert.equal(metadata.commit, SOURCE_SHA);
    assert.equal(metadata.promotionPullRequestUrl, state.pullRequest.html_url);
});

test('FinalizePromotion ignores source branch commits pushed after the merge', async () =>
{
    const state = CreateFinalizationGithub({ pullHeadSha: NEXT_SHA });

    const result = await FinalizePromotion(CreateFinalizationParameters(state.github));

    assert.equal(result.sourceSha, SOURCE_SHA);
    assert.equal(state.createdTags[0].object, SOURCE_SHA);
});

test('FinalizePromotion only reuses reintegration PRs from the exact parent repository', async () =>
{
    const wrongRepository = CreateFinalizationGithub({
        reintegrationPullRequests: [{
            html_url: 'https://github.com/imperia-scm/tags-slave-repo-fork/pull/88',
            head: {
                ref: 'production',
                repo: { full_name: 'imperia-scm/tags-slave-repo-fork' }
            },
            base: { ref: 'main_development' }
        }]
    });

    await FinalizePromotion(CreateFinalizationParameters(wrongRepository.github));

    assert.equal(wrongRepository.createdPullRequests.length, 1);

    const expectedRepository = CreateFinalizationGithub({
        reintegrationPullRequests: [{
            html_url: 'https://github.com/imperia-scm/tags-slave-repo-fork/pull/89',
            head: {
                ref: 'production',
                repo: { full_name: 'Imperia-Rminana/tags-slave-repo' }
            },
            base: { ref: 'main_development' }
        }]
    });

    const result = await FinalizePromotion(CreateFinalizationParameters(expectedRepository.github));

    assert.equal(expectedRepository.createdPullRequests.length, 0);
    assert.equal(
        result.reintegration.html_url,
        'https://github.com/imperia-scm/tags-slave-repo-fork/pull/89'
    );
});

test('FinalizePromotion rejects stale dispatches, failed builds and non-merge commits', async () =>
{
    const stale = CreateFinalizationGithub();
    await assert.rejects(
        FinalizePromotion(CreateFinalizationParameters(stale.github, {
            EXPECTED_HEAD_SHA: NEXT_SHA
        })),
        /head SHA/i
    );

    const failed = CreateFinalizationGithub({
        statuses: [{ context: 'scp-management/release-candidate', state: 'failure' }]
    });
    await assert.rejects(
        FinalizePromotion(CreateFinalizationParameters(failed.github)),
        /successful.*status/i
    );

    const squash = CreateFinalizationGithub({ parents: [{ sha: PRODUCTION_SHA }] });
    await assert.rejects(
        FinalizePromotion(CreateFinalizationParameters(squash.github)),
        /two-parent merge commit/i
    );

    const replayed = CreateFinalizationGithub({
        body: CreatePromotionMarker(CreateMarkerMetadata(), CONTRACT_SECRET, 40)
    });
    await assert.rejects(
        FinalizePromotion(CreateFinalizationParameters(replayed.github)),
        /signature/i
    );
});
