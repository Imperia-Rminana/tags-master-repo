const ReadReleaseState = require('./read-release-state.cjs');
const { EnsureAnnotatedTag } = require('./publish-release.cjs');
const {
    ParsePromotionBranch,
    ParsePromotionMarker
} = require('./promotion-contract.cjs');

function IsNotFound(error)
{
    return error && error.status === 404;
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

async function ResolveReferenceCommit(github, owner, repository, reference)
{
    return ReadReleaseState.ResolveObjectToCommit(
        github,
        owner,
        repository,
        reference.object
    );
}

async function ReadAndValidateMergedPullRequest(parameters)
{
    const { github, inputs } = parameters;
    const pullRequestNumber = Number(inputs.PULL_REQUEST_NUMBER);
    if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1)
    {
        throw new Error('A positive parent pull request number is required.');
    }

    const response = await github.rest.pulls.get({
        owner: inputs.PARENT_OWNER,
        repo: inputs.PARENT_REPOSITORY,
        pull_number: pullRequestNumber
    });
    const pullRequest = response.data;
    if (pullRequest.state !== 'closed' || !pullRequest.merged || !pullRequest.merged_at ||
        !pullRequest.merge_commit_sha)
    {
        throw new Error(`Parent pull request #${pullRequestNumber} has not been merged.`);
    }

    return pullRequest;
}

function ValidateMarkerAgainstPullRequest(contract, marker, pullRequest, inputs)
{
    const expectedSourceRepository =
        `${inputs.DEVELOPMENT_OWNER}/${inputs.DEVELOPMENT_REPOSITORY}`;
    if (marker.tag !== contract.tag || marker.sourceSha !== pullRequest.head.sha ||
        marker.sourceRepository !== expectedSourceRepository)
    {
        throw new Error('Promotion marker does not match the merged pull request.');
    }
    if (!pullRequest.head.repo || pullRequest.head.repo.full_name !== expectedSourceRepository ||
        pullRequest.head.ref !== contract.promotionBranch)
    {
        throw new Error('Promotion pull request source is invalid.');
    }
    if (!pullRequest.base || pullRequest.base.ref !== contract.parentBaseBranch)
    {
        throw new Error('Promotion pull request target is invalid.');
    }
}

async function VerifyDevelopmentTag(parameters)
{
    const { github, inputs, contract, pullRequest } = parameters;
    const reference = await GetReferenceOrNull(
        github,
        inputs.DEVELOPMENT_OWNER,
        inputs.DEVELOPMENT_REPOSITORY,
        `tags/${contract.tag}`
    );
    if (!reference)
    {
        throw new Error(`Development tag ${contract.tag} does not exist.`);
    }

    const tagCommit = await ResolveReferenceCommit(
        github,
        inputs.DEVELOPMENT_OWNER,
        inputs.DEVELOPMENT_REPOSITORY,
        reference
    );
    if (tagCommit !== pullRequest.head.sha)
    {
        throw new Error(`Development tag ${contract.tag} does not match the promotion head.`);
    }
}

async function VerifyMergeCommit(parameters)
{
    const { github, inputs, pullRequest } = parameters;
    const response = await github.rest.repos.getCommit({
        owner: inputs.PARENT_OWNER,
        repo: inputs.PARENT_REPOSITORY,
        ref: pullRequest.merge_commit_sha
    });
    const mergeCommit = response.data;
    if (mergeCommit.sha !== pullRequest.merge_commit_sha ||
        !mergeCommit.parents || mergeCommit.parents.length !== 2 ||
        !mergeCommit.parents.some((parent) => parent.sha === pullRequest.head.sha))
    {
        throw new Error('Promotion must be integrated with a two-parent merge commit.');
    }
}

async function EnsureParentTag(parameters)
{
    const { github, inputs, contract, pullRequest } = parameters;
    return EnsureAnnotatedTag({
        github,
        owner: inputs.PARENT_OWNER,
        repository: inputs.PARENT_REPOSITORY,
        tag: contract.tag,
        targetSha: pullRequest.merge_commit_sha,
        sourceBranch: contract.parentBaseBranch,
        runUrl: inputs.RUN_URL
    });
}

async function EnsureReintegrationPullRequest(parameters)
{
    const { github, inputs, contract } = parameters;
    const head = `${inputs.PARENT_OWNER}:${contract.parentBaseBranch}`;
    const comparison = await github.rest.repos.compareCommitsWithBasehead({
        owner: inputs.DEVELOPMENT_OWNER,
        repo: inputs.DEVELOPMENT_REPOSITORY,
        basehead: `${inputs.DEVELOPMENT_TRUNK_BRANCH}...${head}`
    });
    if (comparison.data.ahead_by === 0)
    {
        return null;
    }

    const existingResponse = await github.rest.pulls.list({
        owner: inputs.DEVELOPMENT_OWNER,
        repo: inputs.DEVELOPMENT_REPOSITORY,
        state: 'open',
        head,
        base: inputs.DEVELOPMENT_TRUNK_BRANCH,
        per_page: 100
    });
    if (existingResponse.data.length > 1)
    {
        throw new Error('More than one reintegration pull request exists.');
    }
    if (existingResponse.data.length === 1)
    {
        return existingResponse.data[0];
    }

    const response = await github.rest.pulls.create({
        owner: inputs.DEVELOPMENT_OWNER,
        repo: inputs.DEVELOPMENT_REPOSITORY,
        title: `Reintegrate ${contract.tag} into Development`,
        head,
        head_repo: inputs.PARENT_REPOSITORY,
        base: inputs.DEVELOPMENT_TRUNK_BRANCH,
        body:
            `Reintegrates the Codex merge for \`${contract.tag}\` into Development.\n\n` +
            `Created by ${inputs.RUN_URL}.`,
        maintainer_can_modify: false,
        draft: false
    });
    return response.data;
}

async function DeleteSnapshotBranch(parameters)
{
    const { github, inputs, contract, pullRequest } = parameters;
    const reference = await GetReferenceOrNull(
        github,
        inputs.DEVELOPMENT_OWNER,
        inputs.DEVELOPMENT_REPOSITORY,
        `heads/${contract.promotionBranch}`
    );
    if (!reference)
    {
        return false;
    }

    const snapshotCommit = await ResolveReferenceCommit(
        github,
        inputs.DEVELOPMENT_OWNER,
        inputs.DEVELOPMENT_REPOSITORY,
        reference
    );
    if (snapshotCommit !== pullRequest.head.sha)
    {
        throw new Error('Promotion snapshot moved after the parent pull request was merged.');
    }

    await github.rest.git.deleteRef({
        owner: inputs.DEVELOPMENT_OWNER,
        repo: inputs.DEVELOPMENT_REPOSITORY,
        ref: `heads/${contract.promotionBranch}`
    });
    return true;
}

async function FinalizePromotion(parameters)
{
    const { github, core, inputs } = parameters;
    const requiredNames = [
        'PARENT_OWNER',
        'PARENT_REPOSITORY',
        'DEVELOPMENT_OWNER',
        'DEVELOPMENT_REPOSITORY',
        'DEVELOPMENT_TRUNK_BRANCH',
        'PULL_REQUEST_NUMBER',
        'RUN_URL'
    ];
    for (const name of requiredNames)
    {
        if (!inputs[name])
        {
            throw new Error(`Finalization input ${name} is required.`);
        }
    }

    const pullRequest = await ReadAndValidateMergedPullRequest({ github, inputs });
    const contract = ParsePromotionBranch(pullRequest.head.ref);
    const marker = ParsePromotionMarker(pullRequest.body || '');
    ValidateMarkerAgainstPullRequest(contract, marker, pullRequest, inputs);
    await VerifyDevelopmentTag({ github, inputs, contract, pullRequest });
    await VerifyMergeCommit({ github, inputs, pullRequest });
    const tagExisted = await EnsureParentTag({ github, inputs, contract, pullRequest });
    const reintegration = await EnsureReintegrationPullRequest({
        github,
        inputs,
        contract,
        pullRequest
    });
    const snapshotDeleted = await DeleteSnapshotBranch({
        github,
        inputs,
        contract,
        pullRequest
    });

    core.setOutput('tag', contract.tag);
    core.setOutput('tag_existed', String(tagExisted));
    core.setOutput('reintegration_pr_url', reintegration ? reintegration.html_url : '');
    core.setOutput('snapshot_deleted', String(snapshotDeleted));
    core.info(`Finalized promotion ${contract.tag}.`);

    return { contract, pullRequest, reintegration, tagExisted, snapshotDeleted };
}

module.exports = FinalizePromotion;
module.exports.DeleteSnapshotBranch = DeleteSnapshotBranch;
module.exports.EnsureParentTag = EnsureParentTag;
module.exports.EnsureReintegrationPullRequest = EnsureReintegrationPullRequest;
module.exports.ReadAndValidateMergedPullRequest = ReadAndValidateMergedPullRequest;
module.exports.ValidateMarkerAgainstPullRequest = ValidateMarkerAgainstPullRequest;
module.exports.VerifyDevelopmentTag = VerifyDevelopmentTag;
module.exports.VerifyMergeCommit = VerifyMergeCommit;

