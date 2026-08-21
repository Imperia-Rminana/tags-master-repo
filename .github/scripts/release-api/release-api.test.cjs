const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ReadReleaseState = require('./read-release-state.cjs');
const PublishRelease = require('./publish-release.cjs');
const { CreatePromotionMarker } = require('./promotion-contract.cjs');

const TARGET_SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CONTRACT_SECRET = '0123456789abcdef0123456789abcdef';

function CreateReservationMarker(pullRequestNumber = 10, overrides = {})
{
    return CreatePromotionMarker({
        schemaVersion: 2,
        tag: 'core/2.0.0',
        sourceRepository: 'imperia-scm/tags-slave-repo-fork',
        sourceBranch: 'release/2.0',
        parentRepository: 'Imperia-Rminana/tags-slave-repo',
        parentBaseBranch: 'production',
        previousTag: 'core/1.9.0',
        isOverride: false,
        overrideReason: '',
        requestedBy: 'release-manager',
        approvalRunUrl: 'https://github.com/Imperia-Rminana/tags-master-repo/actions/runs/42',
        ...overrides
    }, CONTRACT_SECRET, pullRequestNumber);
}

function CreateError(status, message)
{
    const error = new Error(message || `HTTP ${status}`);
    error.status = status;
    return error;
}

function CreateCore()
{
    const messages = [];
    const outputs = {};

    return {
        messages,
        outputs,
        info(message)
        {
            messages.push(message);
        },
        setOutput(name, value)
        {
            outputs[name] = value;
        }
    };
}

test('GetTagPrefix validates Core and Booster namespaces', () =>
{
    assert.equal(ReadReleaseState.GetTagPrefix('core', ''), 'core/');
    assert.equal(ReadReleaseState.GetTagPrefix('booster', 'forecast'), 'boost/forecast/');
    assert.throws(
        () => ReadReleaseState.GetTagPrefix('booster', 'Forecast Team'),
        /invalid/
    );
    assert.throws(() => ReadReleaseState.GetTagPrefix('unknown', ''), /invalid/);
});

test('ResolveObjectToCommit handles commits and nested annotated tags', async () =>
{
    const requestedTags = [];
    const github = {
        rest: {
            git: {
                async getTag(parameters)
                {
                    requestedTags.push(parameters.tag_sha);
                    if (parameters.tag_sha === 'tag-one')
                    {
                        return { data: { object: { type: 'tag', sha: 'tag-two' } } };
                    }

                    return { data: { object: { type: 'commit', sha: TARGET_SHA } } };
                }
            },
            pulls: {
                list: async () => ({ data: [] })
            }
        }
    };

    const directCommit = await ReadReleaseState.ResolveObjectToCommit(
        github,
        'imperia-scm',
        'tags-slave-repo-fork',
        { type: 'commit', sha: TARGET_SHA }
    );
    const annotatedCommit = await ReadReleaseState.ResolveObjectToCommit(
        github,
        'imperia-scm',
        'tags-slave-repo-fork',
        { type: 'tag', sha: 'tag-one' }
    );

    assert.equal(directCommit, TARGET_SHA);
    assert.equal(annotatedCommit, TARGET_SHA);
    assert.deepEqual(requestedTags, ['tag-one', 'tag-two']);
});

test('ResolveObjectToCommit rejects cycles and unsupported objects', async () =>
{
    const github = {
        rest: {
            git: {
                async getTag(parameters)
                {
                    return { data: { object: { type: 'tag', sha: parameters.tag_sha } } };
                }
            }
        }
    };

    await assert.rejects(
        ReadReleaseState.ResolveObjectToCommit(
            github,
            'owner',
            'repository',
            { type: 'tag', sha: 'cycle' }
        ),
        /cycle detected/
    );
    await assert.rejects(
        ReadReleaseState.ResolveObjectToCommit(
            github,
            'owner',
            'repository',
            { type: 'tree', sha: OTHER_SHA }
        ),
        /unsupported type tree/
    );
});

test('ReadReleaseState writes sorted tags resolved to commits', async () =>
{
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-api-'));
    const outputPath = path.join(temporaryDirectory, 'state.json');
    const core = CreateCore();
    const listMatchingRefs = async () => undefined;
    const listPullRequests = async () => undefined;
    const github = {
        paginate: async (method, parameters) =>
        {
            if (method === listMatchingRefs)
            {
                assert.equal(parameters.ref, 'tags/core/');
                return [
                    {
                        ref: 'refs/tags/core/2.0.0',
                        object: { type: 'tag', sha: 'tag-object' }
                    },
                    {
                        ref: 'refs/tags/core/1.0.0',
                        object: { type: 'commit', sha: OTHER_SHA }
                    }
                ];
            }

            assert.equal(method, listPullRequests);
            assert.equal(parameters.base, 'production');
            return [];
        },
        rest: {
            git: {
                listMatchingRefs,
                async getRef(parameters)
                {
                    assert.equal(parameters.ref, 'heads/release/2.0');
                    return { data: { object: { type: 'commit', sha: TARGET_SHA } } };
                },
                async getTag(parameters)
                {
                    assert.equal(parameters.tag_sha, 'tag-object');
                    return { data: { object: { type: 'commit', sha: TARGET_SHA } } };
                }
            },
            pulls: {
                list: listPullRequests
            }
        }
    };

    try
    {
        const state = await ReadReleaseState({
            github,
            core,
            owner: 'imperia-scm',
            repository: 'tags-slave-repo-fork',
            sourceBranch: 'release/2.0',
            component: 'core',
            boosterName: '',
            parentOwner: 'Imperia-Rminana',
            parentRepository: 'tags-slave-repo',
            contractSecret: CONTRACT_SECRET,
            outputPath
        });

        assert.equal(state.schemaVersion, 2);
        assert.equal(state.repository, 'imperia-scm/tags-slave-repo-fork');
        assert.deepEqual(state.reservations, []);
        assert.deepEqual(
            state.tags.map((tag) => tag.name),
            ['core/1.0.0', 'core/2.0.0']
        );
        assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), state);
        assert.match(core.messages[0], /2 matching release tags/);
    }
    finally
    {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
});

test('ReadReleaseState records open and merged-unfinalized signed reservations', async () =>
{
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-api-'));
    const outputPath = path.join(temporaryDirectory, 'state.json');
    const openPullRequest = {
        number: 10,
        state: 'open',
        merged_at: null,
        body: CreateReservationMarker(),
        head: {
            ref: 'release/2.0',
            sha: TARGET_SHA,
            repo: { full_name: 'imperia-scm/tags-slave-repo-fork' }
        },
        base: { ref: 'production' },
        html_url: 'https://github.com/Imperia-Rminana/tags-slave-repo/pull/10'
    };
    const mergedPullRequest = {
        ...openPullRequest,
        number: 11,
        state: 'closed',
        merged_at: '2026-08-20T10:00:00Z',
        body: CreateReservationMarker(11),
        html_url: 'https://github.com/Imperia-Rminana/tags-slave-repo/pull/11'
    };
    const closedPullRequest = {
        ...openPullRequest,
        number: 12,
        state: 'closed',
        merged_at: null,
        body: CreateReservationMarker(12)
    };
    const unrelatedPullRequest = {
        ...openPullRequest,
        number: 9,
        body: 'Normal pull request without a promotion marker',
        base: { ref: 'main' }
    };
    const listMatchingRefs = async () => undefined;
    const listPullRequests = async () => undefined;
    const github = {
        paginate: async (method, parameters) =>
        {
            if (method === listMatchingRefs)
            {
                return [];
            }

            assert.equal(method, listPullRequests);
            assert.equal(parameters.base, 'production');
            return [
                unrelatedPullRequest,
                openPullRequest,
                mergedPullRequest,
                closedPullRequest
            ];
        },
        rest: {
            git: {
                listMatchingRefs,
                getRef: async () => ({
                    data: { object: { type: 'commit', sha: TARGET_SHA } }
                })
            },
            pulls: {
                list: listPullRequests
            }
        }
    };

    try
    {
        const state = await ReadReleaseState({
            github,
            core: CreateCore(),
            owner: 'imperia-scm',
            repository: 'tags-slave-repo-fork',
            sourceBranch: 'release/2.0',
            component: 'core',
            boosterName: '',
            parentOwner: 'Imperia-Rminana',
            parentRepository: 'tags-slave-repo',
            contractSecret: CONTRACT_SECRET,
            outputPath
        });

        assert.deepEqual(state.reservations.map((reservation) => ({
            pullRequestNumber: reservation.pullRequestNumber,
            state: reservation.state,
            tag: reservation.tag,
            url: reservation.url
        })), [
            {
                pullRequestNumber: 10,
                state: 'open',
                tag: 'core/2.0.0',
                url: 'https://github.com/Imperia-Rminana/tags-slave-repo/pull/10'
            },
            {
                pullRequestNumber: 11,
                state: 'merged_pending',
                tag: 'core/2.0.0',
                url: 'https://github.com/Imperia-Rminana/tags-slave-repo/pull/11'
            }
        ]);
    }
    finally
    {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
});

test('ReadReleaseState validates inputs and returned references', async () =>
{
    await assert.rejects(
        ReadReleaseState({
            github: {},
            core: CreateCore(),
            owner: '',
            repository: '',
            sourceBranch: '',
            component: 'core',
            boosterName: '',
            outputPath: ''
        }),
        /required/
    );

    const github = {
        paginate: async () => [
            { ref: 'refs/heads/not-a-tag', object: { type: 'commit', sha: TARGET_SHA } }
        ],
        rest: {
            git: {
                listMatchingRefs: async () => undefined,
                getRef: async () => ({
                    data: { object: { type: 'commit', sha: TARGET_SHA } }
                })
            }
        }
    };
    await assert.rejects(
        ReadReleaseState({
            github,
            core: CreateCore(),
            owner: 'owner',
            repository: 'repository',
            sourceBranch: 'release/1.0',
            component: 'core',
            boosterName: '',
            parentOwner: 'owner',
            parentRepository: 'parent',
            contractSecret: CONTRACT_SECRET,
            outputPath: 'unused.json'
        }),
        /Unexpected tag reference/
    );
});

test('GetReferenceOrNull and GetReleaseOrNull handle absence and API failures', async () =>
{
    const missingGithub = {
        rest: {
            git: { getRef: async () => { throw CreateError(404); } },
            repos: { getReleaseByTag: async () => { throw CreateError(404); } }
        }
    };
    assert.equal(
        await PublishRelease.GetReferenceOrNull(missingGithub, 'owner', 'repo', 'tags/tag'),
        null
    );
    assert.equal(
        await PublishRelease.GetReleaseOrNull(missingGithub, 'owner', 'repo', 'tag'),
        null
    );

    const failingGithub = {
        rest: {
            git: { getRef: async () => { throw CreateError(500); } },
            repos: { getReleaseByTag: async () => { throw CreateError(500); } }
        }
    };
    await assert.rejects(
        PublishRelease.GetReferenceOrNull(failingGithub, 'owner', 'repo', 'tags/tag'),
        /HTTP 500/
    );
    await assert.rejects(
        PublishRelease.GetReleaseOrNull(failingGithub, 'owner', 'repo', 'tag'),
        /HTTP 500/
    );
});

test('EnsureAnnotatedTag accepts an existing tag at the approved commit', async () =>
{
    const github = {
        rest: {
            git: {
                getRef: async () => ({
                    data: { object: { type: 'commit', sha: TARGET_SHA } }
                })
            }
        }
    };
    const tagExisted = await PublishRelease.EnsureAnnotatedTag({
        github,
        owner: 'owner',
        repository: 'repo',
        tag: 'core/1.0.0',
        targetSha: TARGET_SHA,
        sourceBranch: 'release/1.0',
        runUrl: 'https://example.test/run'
    });

    assert.equal(tagExisted, true);
});

test('EnsureAnnotatedTag creates an annotated tag and reference', async () =>
{
    const calls = [];
    const github = {
        rest: {
            git: {
                getRef: async () => { throw CreateError(404); },
                async createTag(parameters)
                {
                    calls.push(['tag', parameters]);
                    return { data: { sha: 'created-tag-object' } };
                },
                async createRef(parameters)
                {
                    calls.push(['ref', parameters]);
                }
            }
        }
    };
    const tagExisted = await PublishRelease.EnsureAnnotatedTag({
        github,
        owner: 'owner',
        repository: 'repo',
        tag: 'core/1.0.0',
        targetSha: TARGET_SHA,
        sourceBranch: 'release/1.0',
        runUrl: 'https://example.test/run'
    });

    assert.equal(tagExisted, false);
    assert.equal(calls[0][0], 'tag');
    assert.equal(calls[0][1].object, TARGET_SHA);
    assert.equal(calls[0][1].type, 'commit');
    assert.match(calls[0][1].message, /Workflow: https:\/\/example.test\/run/);
    assert.deepEqual(calls[1], [
        'ref',
        {
            owner: 'owner',
            repo: 'repo',
            ref: 'refs/tags/core/1.0.0',
            sha: 'created-tag-object'
        }
    ]);
});

test('EnsureAnnotatedTag recovers from a concurrent reference creation', async () =>
{
    let getRefCalls = 0;
    const github = {
        rest: {
            git: {
                async getRef()
                {
                    getRefCalls++;
                    if (getRefCalls === 1)
                    {
                        throw CreateError(404);
                    }

                    return { data: { object: { type: 'commit', sha: TARGET_SHA } } };
                },
                createTag: async () => ({ data: { sha: 'unused-tag-object' } }),
                createRef: async () => { throw CreateError(422); }
            }
        }
    };
    const tagExisted = await PublishRelease.EnsureAnnotatedTag({
        github,
        owner: 'owner',
        repository: 'repo',
        tag: 'core/1.0.0',
        targetSha: TARGET_SHA,
        sourceBranch: 'release/1.0',
        runUrl: 'https://example.test/run'
    });

    assert.equal(tagExisted, true);
    assert.equal(getRefCalls, 2);
});

test('EnsureAnnotatedTag rejects conflicts and unexpected reference failures', async () =>
{
    const conflictingGithub = {
        rest: {
            git: {
                getRef: async () => ({
                    data: { object: { type: 'commit', sha: OTHER_SHA } }
                })
            }
        }
    };
    await assert.rejects(
        PublishRelease.EnsureAnnotatedTag({
            github: conflictingGithub,
            owner: 'owner',
            repository: 'repo',
            tag: 'core/1.0.0',
            targetSha: TARGET_SHA,
            sourceBranch: 'release/1.0',
            runUrl: 'url'
        }),
        /instead of approved SHA/
    );

    const failingGithub = {
        rest: {
            git: {
                getRef: async () => { throw CreateError(404); },
                createTag: async () => ({ data: { sha: 'tag-object' } }),
                createRef: async () => { throw CreateError(500); }
            }
        }
    };
    await assert.rejects(
        PublishRelease.EnsureAnnotatedTag({
            github: failingGithub,
            owner: 'owner',
            repository: 'repo',
            tag: 'core/1.0.0',
            targetSha: TARGET_SHA,
            sourceBranch: 'release/1.0',
            runUrl: 'url'
        }),
        /HTTP 500/
    );
});

test('EnsureAnnotatedTag rethrows a validation failure when no reference appears', async () =>
{
    const github = {
        rest: {
            git: {
                getRef: async () => { throw CreateError(404); },
                createTag: async () => ({ data: { sha: 'tag-object' } }),
                createRef: async () => { throw CreateError(422); }
            }
        }
    };
    await assert.rejects(
        PublishRelease.EnsureAnnotatedTag({
            github,
            owner: 'owner',
            repository: 'repo',
            tag: 'core/1.0.0',
            targetSha: TARGET_SHA,
            sourceBranch: 'release/1.0',
            runUrl: 'url'
        }),
        /HTTP 422/
    );
});

test('EnsureRelease returns an existing release without generating notes', async () =>
{
    const release = { id: 10, tag_name: 'core/1.0.0' };
    const github = {
        rest: {
            repos: {
                getReleaseByTag: async () => ({ data: release })
            }
        }
    };
    const result = await PublishRelease.EnsureRelease({
        github,
        owner: 'owner',
        repository: 'repo',
        tag: 'core/1.0.0',
        title: 'Core 1.0.0',
        targetSha: TARGET_SHA,
        previousTag: '',
        overrideReason: ''
    });

    assert.deepEqual(result, { release, releaseCreated: false });
});

test('EnsureRelease generates notes and creates a release', async () =>
{
    let createParameters;
    let noteParameters;
    const github = {
        rest: {
            repos: {
                getReleaseByTag: async () => { throw CreateError(404); },
                async generateReleaseNotes(parameters)
                {
                    noteParameters = parameters;
                    return { data: { body: 'Generated notes' } };
                },
                async createRelease(parameters)
                {
                    createParameters = parameters;
                    return { data: { id: 11 } };
                }
            }
        }
    };
    const result = await PublishRelease.EnsureRelease({
        github,
        owner: 'owner',
        repository: 'repo',
        tag: 'core/1.0.1',
        title: 'Core 1.0.1',
        targetSha: TARGET_SHA,
        previousTag: 'core/1.0.0',
        overrideReason: 'Reserved patch'
    });

    assert.equal(result.releaseCreated, true);
    assert.equal(noteParameters.previous_tag_name, 'core/1.0.0');
    assert.equal(noteParameters.target_commitish, TARGET_SHA);
    assert.match(createParameters.body, /Exceptional version override: Reserved patch/);
    assert.equal(createParameters.draft, false);
    assert.equal(createParameters.prerelease, false);
});

test('EnsureRelease recovers from a concurrent release creation', async () =>
{
    let lookupCount = 0;
    const github = {
        rest: {
            repos: {
                async getReleaseByTag()
                {
                    lookupCount++;
                    if (lookupCount === 1)
                    {
                        throw CreateError(404);
                    }

                    return { data: { id: 12 } };
                },
                generateReleaseNotes: async () => ({ data: { body: 'Notes' } }),
                createRelease: async () => { throw CreateError(422); }
            }
        }
    };
    const result = await PublishRelease.EnsureRelease({
        github,
        owner: 'owner',
        repository: 'repo',
        tag: 'core/1.0.0',
        title: 'Core 1.0.0',
        targetSha: TARGET_SHA,
        previousTag: '',
        overrideReason: ''
    });

    assert.equal(result.releaseCreated, false);
    assert.equal(result.release.id, 12);
});

test('EnsureRelease propagates failures that cannot be recovered', async () =>
{
    const unexpectedGithub = {
        rest: {
            repos: {
                getReleaseByTag: async () => { throw CreateError(404); },
                generateReleaseNotes: async () => ({ data: { body: 'Notes' } }),
                createRelease: async () => { throw CreateError(500); }
            }
        }
    };
    await assert.rejects(
        PublishRelease.EnsureRelease({
            github: unexpectedGithub,
            owner: 'owner',
            repository: 'repo',
            tag: 'tag',
            title: 'Title',
            targetSha: TARGET_SHA,
            previousTag: '',
            overrideReason: ''
        }),
        /HTTP 500/
    );

    const missingAfterRaceGithub = {
        rest: {
            repos: {
                getReleaseByTag: async () => { throw CreateError(404); },
                generateReleaseNotes: async () => ({ data: { body: 'Notes' } }),
                createRelease: async () => { throw CreateError(422); }
            }
        }
    };
    await assert.rejects(
        PublishRelease.EnsureRelease({
            github: missingAfterRaceGithub,
            owner: 'owner',
            repository: 'repo',
            tag: 'tag',
            title: 'Title',
            targetSha: TARGET_SHA,
            previousTag: '',
            overrideReason: ''
        }),
        /HTTP 422/
    );
});

test('UploadMetadata replaces an existing metadata asset', async () =>
{
    const deletedAssets = [];
    let uploadParameters;
    const listReleaseAssets = async () => undefined;
    const github = {
        paginate: async (method) =>
        {
            assert.equal(method, listReleaseAssets);
            return [
                { id: 20, name: 'other.zip' },
                { id: 21, name: 'release-metadata.json' }
            ];
        },
        rest: {
            repos: {
                listReleaseAssets,
                async deleteReleaseAsset(parameters)
                {
                    deletedAssets.push(parameters.asset_id);
                },
                async uploadReleaseAsset(parameters)
                {
                    uploadParameters = parameters;
                }
            }
        }
    };
    await PublishRelease.UploadMetadata({
        github,
        owner: 'owner',
        repository: 'repo',
        release: { id: 30 },
        metadata: { tag: 'core/1.0.0' }
    });

    assert.deepEqual(deletedAssets, [21]);
    assert.equal(uploadParameters.name, 'release-metadata.json');
    assert.equal(uploadParameters.headers['content-type'], 'application/json');
    assert.equal(uploadParameters.headers['content-length'], uploadParameters.data.length);
    assert.deepEqual(JSON.parse(uploadParameters.data.toString('utf8')), {
        tag: 'core/1.0.0'
    });
});

function CreatePublishingGithub(options)
{
    const settings = options || {};
    const assets = [];
    const listReleaseAssets = async () => undefined;
    let tagLookupCount = 0;

    return {
        assets,
        paginate: async (method) =>
        {
            if (method === listReleaseAssets)
            {
                return [];
            }

            throw new Error('Unexpected paginated API method.');
        },
        rest: {
            git: {
                async getRef(parameters)
                {
                    if (parameters.ref.startsWith('heads/'))
                    {
                        return {
                            data: {
                                object: {
                                    type: 'commit',
                                    sha: settings.branchSha || TARGET_SHA
                                }
                            }
                        };
                    }

                    tagLookupCount++;
                    throw CreateError(404, `Missing tag lookup ${tagLookupCount}`);
                },
                createTag: async () => ({ data: { sha: 'tag-object' } }),
                createRef: async () => undefined
            },
            repos: {
                listReleaseAssets,
                getReleaseByTag: async () => { throw CreateError(404); },
                generateReleaseNotes: async () => ({ data: { body: 'Notes' } }),
                createRelease: async () => ({ data: { id: 40 } }),
                deleteReleaseAsset: async () => undefined,
                async uploadReleaseAsset(parameters)
                {
                    assets.push(parameters);
                }
            }
        }
    };
}

function CreatePublishParameters(github)
{
    return {
        github,
        core: CreateCore(),
        context: { actor: 'release-manager' },
        inputs: {
            TARGET_OWNER: 'imperia-scm',
            TARGET_REPOSITORY: 'tags-slave-repo-fork',
            SOURCE_BRANCH: 'release/1.0',
            TARGET_SHA,
            TAG: 'core/1.0.0',
            RUN_URL: 'https://example.test/actions/runs/1',
            TITLE: 'Core 1.0.0',
            PREVIOUS_TAG: '',
            OVERRIDE_REASON: '',
            COMPONENT: 'core',
            BOOSTER_NAME: '',
            VERSION: '1.0.0',
            IS_OVERRIDE: 'false'
        }
    };
}

test('PublishRelease performs an end-to-end API publication', async () =>
{
    const github = CreatePublishingGithub();
    const parameters = CreatePublishParameters(github);
    const result = await PublishRelease(parameters);

    assert.equal(result.tagExisted, false);
    assert.equal(result.releaseCreated, true);
    assert.equal(result.metadata.repository, undefined);
    assert.equal(result.metadata.actor, 'release-manager');
    assert.equal(result.metadata.override, false);
    assert.match(result.metadata.publishedAtUtc, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(parameters.core.outputs.tag_existed, 'false');
    assert.equal(parameters.core.outputs.release_created, 'true');
    assert.equal(github.assets.length, 1);
});

test('PublishRelease validates required data, SHA and branch movement', async () =>
{
    const missingParameters = CreatePublishParameters(CreatePublishingGithub());
    missingParameters.inputs.TAG = '';
    await assert.rejects(PublishRelease(missingParameters), /required/);

    const invalidShaParameters = CreatePublishParameters(CreatePublishingGithub());
    invalidShaParameters.inputs.TARGET_SHA = 'invalid';
    await assert.rejects(PublishRelease(invalidShaParameters), /invalid/);

    const movedParameters = CreatePublishParameters(
        CreatePublishingGithub({ branchSha: OTHER_SHA })
    );
    await assert.rejects(PublishRelease(movedParameters), /Source branch moved/);
});
