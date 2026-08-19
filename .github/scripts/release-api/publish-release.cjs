const ReadReleaseState = require('./read-release-state.cjs');

function IsNotFound(error)
{
    return error && error.status === 404;
}

function IsValidationFailure(error)
{
    return error && error.status === 422;
}

async function GetReferenceOrNull(github, owner, repository, reference)
{
    try
    {
        const response = await github.rest.git.getRef({
            owner,
            repo: repository,
            ref: reference
        });

        return response.data;
    }
    catch (error)
    {
        if (IsNotFound(error))
        {
            return null;
        }

        throw error;
    }
}

async function GetReleaseOrNull(github, owner, repository, tag)
{
    try
    {
        const response = await github.rest.repos.getReleaseByTag({
            owner,
            repo: repository,
            tag
        });

        return response.data;
    }
    catch (error)
    {
        if (IsNotFound(error))
        {
            return null;
        }

        throw error;
    }
}

async function VerifyTagCommit(github, owner, repository, tagReference, targetSha, tag)
{
    const tagCommit = await ReadReleaseState.ResolveObjectToCommit(
        github,
        owner,
        repository,
        tagReference.object
    );

    if (tagCommit !== targetSha)
    {
        throw new Error(`Tag ${tag} exists at ${tagCommit} instead of approved SHA ${targetSha}.`);
    }
}

async function EnsureAnnotatedTag(parameters)
{
    const {
        github,
        owner,
        repository,
        tag,
        targetSha,
        sourceBranch,
        runUrl
    } = parameters;
    let tagReference = await GetReferenceOrNull(
        github,
        owner,
        repository,
        `tags/${tag}`
    );

    if (tagReference)
    {
        await VerifyTagCommit(github, owner, repository, tagReference, targetSha, tag);
        return true;
    }

    const tagMessage = `${tag} from ${sourceBranch} at ${targetSha}\n\nWorkflow: ${runUrl}`;
    const createdTagResponse = await github.rest.git.createTag({
        owner,
        repo: repository,
        tag,
        message: tagMessage,
        object: targetSha,
        type: 'commit',
        tagger: {
            name: 'github-actions[bot]',
            email: '41898282+github-actions[bot]@users.noreply.github.com',
            date: new Date().toISOString()
        }
    });

    try
    {
        await github.rest.git.createRef({
            owner,
            repo: repository,
            ref: `refs/tags/${tag}`,
            sha: createdTagResponse.data.sha
        });
    }
    catch (error)
    {
        if (!IsValidationFailure(error))
        {
            throw error;
        }

        tagReference = await GetReferenceOrNull(
            github,
            owner,
            repository,
            `tags/${tag}`
        );
        if (!tagReference)
        {
            throw error;
        }

        await VerifyTagCommit(github, owner, repository, tagReference, targetSha, tag);
        return true;
    }

    return false;
}

async function EnsureRelease(parameters)
{
    const {
        github,
        owner,
        repository,
        tag,
        title,
        targetSha,
        previousTag,
        overrideReason
    } = parameters;
    let release = await GetReleaseOrNull(github, owner, repository, tag);

    if (release)
    {
        return { release, releaseCreated: false };
    }

    const noteParameters = {
        owner,
        repo: repository,
        tag_name: tag,
        target_commitish: targetSha
    };
    if (previousTag)
    {
        noteParameters.previous_tag_name = previousTag;
    }

    const notesResponse = await github.rest.repos.generateReleaseNotes(noteParameters);
    let releaseBody = notesResponse.data.body;
    if (overrideReason)
    {
        releaseBody = `${releaseBody}\n\nExceptional version override: ${overrideReason}`;
    }

    try
    {
        const createResponse = await github.rest.repos.createRelease({
            owner,
            repo: repository,
            tag_name: tag,
            name: title,
            body: releaseBody,
            draft: false,
            prerelease: false
        });
        release = createResponse.data;
    }
    catch (error)
    {
        if (!IsValidationFailure(error))
        {
            throw error;
        }

        release = await GetReleaseOrNull(github, owner, repository, tag);
        if (!release)
        {
            throw error;
        }

        return { release, releaseCreated: false };
    }

    return { release, releaseCreated: true };
}

async function UploadMetadata(parameters)
{
    const {
        github,
        owner,
        repository,
        release,
        metadata
    } = parameters;
    const assetName = 'release-metadata.json';
    const assets = await github.paginate(github.rest.repos.listReleaseAssets, {
        owner,
        repo: repository,
        release_id: release.id,
        per_page: 100
    });

    for (const asset of assets)
    {
        if (asset.name === assetName)
        {
            await github.rest.repos.deleteReleaseAsset({
                owner,
                repo: repository,
                asset_id: asset.id
            });
        }
    }

    const metadataContent = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    await github.rest.repos.uploadReleaseAsset({
        owner,
        repo: repository,
        release_id: release.id,
        name: assetName,
        headers: {
            'content-type': 'application/json',
            'content-length': metadataContent.length
        },
        data: metadataContent
    });
}

async function PublishRelease(parameters)
{
    const { github, core, context, inputs } = parameters;
    const owner = inputs.TARGET_OWNER;
    const repository = inputs.TARGET_REPOSITORY;
    const sourceBranch = inputs.SOURCE_BRANCH;
    const targetSha = inputs.TARGET_SHA;
    const tag = inputs.TAG;
    const runUrl = inputs.RUN_URL;

    if (!owner || !repository || !sourceBranch || !targetSha || !tag || !runUrl)
    {
        throw new Error('Target repository and approved release data are required.');
    }

    if (!/^[0-9a-f]{40}$/.test(targetSha))
    {
        throw new Error(`Approved target SHA '${targetSha}' is invalid.`);
    }

    const branchResponse = await github.rest.git.getRef({
        owner,
        repo: repository,
        ref: `heads/${sourceBranch}`
    });
    const currentSha = await ReadReleaseState.ResolveObjectToCommit(
        github,
        owner,
        repository,
        branchResponse.data.object
    );
    if (currentSha !== targetSha)
    {
        throw new Error(
            `Source branch moved from approved SHA ${targetSha} to ${currentSha}. ` +
            'Start a new release run.'
        );
    }

    const tagExisted = await EnsureAnnotatedTag({
        github,
        owner,
        repository,
        tag,
        targetSha,
        sourceBranch,
        runUrl
    });
    const releaseResult = await EnsureRelease({
        github,
        owner,
        repository,
        tag,
        title: inputs.TITLE,
        targetSha,
        previousTag: inputs.PREVIOUS_TAG,
        overrideReason: inputs.OVERRIDE_REASON
    });
    const publishedAtUtc = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const metadata = {
        schemaVersion: 1,
        component: inputs.COMPONENT,
        boosterName: inputs.BOOSTER_NAME,
        version: inputs.VERSION,
        tag,
        commit: targetSha,
        sourceBranch,
        previousTag: inputs.PREVIOUS_TAG,
        publishedAtUtc,
        actor: context.actor,
        workflowUrl: runUrl,
        buildGate: 'passed',
        override: inputs.IS_OVERRIDE === 'true',
        overrideReason: inputs.OVERRIDE_REASON
    };
    await UploadMetadata({
        github,
        owner,
        repository,
        release: releaseResult.release,
        metadata
    });

    core.setOutput('tag_existed', String(tagExisted));
    core.setOutput('release_created', String(releaseResult.releaseCreated));
    core.info(`Published ${tag} in ${owner}/${repository}.`);

    return {
        tagExisted,
        releaseCreated: releaseResult.releaseCreated,
        metadata
    };
}

module.exports = PublishRelease;
module.exports.EnsureAnnotatedTag = EnsureAnnotatedTag;
module.exports.EnsureRelease = EnsureRelease;
module.exports.GetReferenceOrNull = GetReferenceOrNull;
module.exports.GetReleaseOrNull = GetReleaseOrNull;
module.exports.UploadMetadata = UploadMetadata;
