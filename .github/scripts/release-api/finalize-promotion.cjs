const { EnsureAnnotatedTag, PublishApprovedRelease } = require('./publish-release.cjs');
const { ParsePromotionMarker, ParseTag } = require('./promotion-contract.cjs');
const { STATUS_CONTEXT } = require('./validate-promotion.cjs');

function RequireInputs(inputs, names)
{
    for (const name of names)
    {
        if (!inputs[name])
        {
            throw new Error(`Finalization input ${name} is required.`);
        }
    }
}

function ReadPullRequestNumber(value)
{
    const pullRequestNumber = Number(value);
    if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1)
    {
        throw new Error('A positive parent pull request number is required.');
    }

    return pullRequestNumber;
}

async function ReadMergedPullRequest(github, inputs)
{
    const pullRequestNumber = ReadPullRequestNumber(inputs.PULL_REQUEST_NUMBER);
    const response = await github.rest.pulls.get({
        owner: inputs.PARENT_OWNER,
        repo: inputs.PARENT_REPOSITORY,
        pull_number: pullRequestNumber
    });
    const pullRequest = response.data;
    if (pullRequest.state !== 'closed' || !pullRequest.merged ||
        !pullRequest.merged_at || !pullRequest.merge_commit_sha)
    {
        throw new Error(`Parent pull request #${pullRequestNumber} has not been merged.`);
    }
    if (inputs.EXPECTED_MERGE_COMMIT_SHA &&
        pullRequest.merge_commit_sha !== inputs.EXPECTED_MERGE_COMMIT_SHA)
    {
        throw new Error('The dispatch merge commit SHA does not match the pull request.');
    }

    return pullRequest;
}

function ValidateMarkerAgainstPullRequest(marker, contract, pullRequest, inputs)
{
    const developmentRepository = `${inputs.DEVELOPMENT_OWNER}/${inputs.DEVELOPMENT_REPOSITORY}`;
    const parentRepository = `${inputs.PARENT_OWNER}/${inputs.PARENT_REPOSITORY}`;
    if (marker.sourceRepository !== developmentRepository ||
        marker.parentRepository !== parentRepository ||
        marker.sourceBranch !== contract.sourceBranch ||
        marker.parentBaseBranch !== contract.parentBaseBranch)
    {
        throw new Error('Promotion marker repositories or branches are invalid.');
    }
    if (!pullRequest.head || !pullRequest.head.repo ||
        pullRequest.head.repo.full_name !== developmentRepository ||
        pullRequest.head.ref !== marker.sourceBranch)
    {
        throw new Error('Promotion pull request source is invalid.');
    }
    if (!pullRequest.base || pullRequest.base.ref !== marker.parentBaseBranch)
    {
        throw new Error('Promotion pull request target is invalid.');
    }
}

async function ReadLastPullRequestCommit(github, inputs, pullRequest)
{
    const commits = await github.paginate(github.rest.pulls.listCommits, {
        owner: inputs.PARENT_OWNER,
        repo: inputs.PARENT_REPOSITORY,
        pull_number: pullRequest.number,
        per_page: 100
    });
    if (commits.length === 0)
    {
        throw new Error('The merged promotion pull request has no commits.');
    }

    const sourceSha = commits[commits.length - 1].sha;
    if (!/^[0-9a-f]{40}$/.test(sourceSha || ''))
    {
        throw new Error('The final promotion head SHA is invalid.');
    }
    if (inputs.EXPECTED_HEAD_SHA && sourceSha !== inputs.EXPECTED_HEAD_SHA)
    {
        throw new Error('The dispatch head SHA does not match the merged pull request.');
    }

    return sourceSha;
}

async function VerifySuccessfulCandidateStatus(github, inputs, sourceSha)
{
    const response = await github.rest.repos.listCommitStatusesForRef({
        owner: inputs.PARENT_OWNER,
        repo: inputs.PARENT_REPOSITORY,
        ref: sourceSha,
        per_page: 100
    });
    const latestStatus = response.data.find((status) => status.context === STATUS_CONTEXT);
    if (!latestStatus || latestStatus.state !== 'success')
    {
        throw new Error(`A successful ${STATUS_CONTEXT} status is required for ${sourceSha}.`);
    }
}

async function VerifyMergeCommit(github, inputs, pullRequest, sourceSha)
{
    const response = await github.rest.repos.getCommit({
        owner: inputs.PARENT_OWNER,
        repo: inputs.PARENT_REPOSITORY,
        ref: pullRequest.merge_commit_sha
    });
    const mergeCommit = response.data;
    if (mergeCommit.sha !== pullRequest.merge_commit_sha ||
        !mergeCommit.parents || mergeCommit.parents.length !== 2 ||
        !mergeCommit.parents.some((parent) => parent.sha === sourceSha))
    {
        throw new Error('Promotion must be integrated with a two-parent merge commit.');
    }
}

async function PublishDevelopment(parameters)
{
    const { github, core, inputs, marker, contract, pullRequest, sourceSha } = parameters;
    const title = contract.component === 'core'
        ? `Core ${contract.version}`
        : `Booster ${contract.boosterName} ${contract.version}`;
    return PublishApprovedRelease({
        github,
        core,
        context: { actor: marker.requestedBy },
        inputs: {
            TARGET_OWNER: inputs.DEVELOPMENT_OWNER,
            TARGET_REPOSITORY: inputs.DEVELOPMENT_REPOSITORY,
            COMPONENT: contract.component,
            BOOSTER_NAME: contract.boosterName,
            VERSION: contract.version,
            TAG: marker.tag,
            TARGET_SHA: sourceSha,
            SOURCE_BRANCH: marker.sourceBranch,
            TITLE: title,
            PREVIOUS_TAG: marker.previousTag,
            IS_OVERRIDE: String(marker.isOverride),
            OVERRIDE_REASON: marker.overrideReason,
            REQUESTED_BY: marker.requestedBy,
            MERGED_BY: pullRequest.merged_by ? pullRequest.merged_by.login : '',
            APPROVAL_RUN_URL: marker.approvalRunUrl,
            PROMOTION_PULL_REQUEST_URL: pullRequest.html_url,
            RUN_URL: inputs.RUN_URL
        }
    });
}

async function EnsureParentTag(github, inputs, marker, pullRequest)
{
    return EnsureAnnotatedTag({
        github,
        owner: inputs.PARENT_OWNER,
        repository: inputs.PARENT_REPOSITORY,
        tag: marker.tag,
        targetSha: pullRequest.merge_commit_sha,
        sourceBranch: marker.parentBaseBranch,
        runUrl: inputs.RUN_URL
    });
}

async function EnsureReintegrationPullRequest(github, inputs, marker, pullRequest)
{
    const head = `${inputs.PARENT_OWNER}:${marker.parentBaseBranch}`;
    const comparison = await github.rest.repos.compareCommitsWithBasehead({
        owner: inputs.DEVELOPMENT_OWNER,
        repo: inputs.DEVELOPMENT_REPOSITORY,
        basehead: `${inputs.DEVELOPMENT_TRUNK_BRANCH}...${pullRequest.merge_commit_sha}`
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
    const expectedParentRepository =
        `${inputs.PARENT_OWNER}/${inputs.PARENT_REPOSITORY}`;
    const matchingPullRequests = existingResponse.data.filter((existingPullRequest) =>
        existingPullRequest.head &&
        existingPullRequest.head.ref === marker.parentBaseBranch &&
        existingPullRequest.head.repo &&
        existingPullRequest.head.repo.full_name === expectedParentRepository &&
        existingPullRequest.base &&
        existingPullRequest.base.ref === inputs.DEVELOPMENT_TRUNK_BRANCH
    );
    if (matchingPullRequests.length > 1)
    {
        throw new Error('More than one reintegration pull request exists.');
    }
    if (matchingPullRequests.length === 1)
    {
        return matchingPullRequests[0];
    }

    const response = await github.rest.pulls.create({
        owner: inputs.DEVELOPMENT_OWNER,
        repo: inputs.DEVELOPMENT_REPOSITORY,
        title: `Reintegrate ${marker.tag} into Development`,
        head,
        head_repo: inputs.PARENT_REPOSITORY,
        base: inputs.DEVELOPMENT_TRUNK_BRANCH,
        body:
            `Reintegrates the Codex merge for \`${marker.tag}\` into Development.\n\n` +
            `Created by ${inputs.RUN_URL}.`,
        maintainer_can_modify: false,
        draft: false
    });
    return response.data;
}

async function FinalizePromotion(parameters)
{
    const { github, core, inputs } = parameters;
    RequireInputs(inputs, [
        'PARENT_OWNER',
        'PARENT_REPOSITORY',
        'DEVELOPMENT_OWNER',
        'DEVELOPMENT_REPOSITORY',
        'DEVELOPMENT_TRUNK_BRANCH',
        'PULL_REQUEST_NUMBER',
        'CONTRACT_SECRET',
        'RUN_URL'
    ]);

    const pullRequest = await ReadMergedPullRequest(github, inputs);
    const marker = ParsePromotionMarker(
        pullRequest.body || '',
        inputs.CONTRACT_SECRET,
        pullRequest.number
    );
    const contract = ParseTag(marker.tag);
    ValidateMarkerAgainstPullRequest(marker, contract, pullRequest, inputs);
    const sourceSha = await ReadLastPullRequestCommit(github, inputs, pullRequest);
    await VerifySuccessfulCandidateStatus(github, inputs, sourceSha);
    await VerifyMergeCommit(github, inputs, pullRequest, sourceSha);

    const development = await PublishDevelopment({
        github, core, inputs, marker, contract, pullRequest, sourceSha
    });
    const parentTagExisted = await EnsureParentTag(github, inputs, marker, pullRequest);
    const reintegration = await EnsureReintegrationPullRequest(
        github,
        inputs,
        marker,
        pullRequest
    );

    core.setOutput('tag', marker.tag);
    core.setOutput('development_tag_existed', String(development.tagExisted));
    core.setOutput('release_created', String(development.releaseCreated));
    core.setOutput('parent_tag_existed', String(parentTagExisted));
    core.setOutput('reintegration_pr_url', reintegration ? reintegration.html_url : '');
    core.info(`Finalized promotion ${marker.tag}.`);

    return {
        contract,
        marker,
        pullRequest,
        sourceSha,
        development,
        parentTagExisted,
        reintegration
    };
}

module.exports = FinalizePromotion;
module.exports.EnsureReintegrationPullRequest = EnsureReintegrationPullRequest;
module.exports.ReadLastPullRequestCommit = ReadLastPullRequestCommit;
module.exports.ReadMergedPullRequest = ReadMergedPullRequest;
module.exports.ValidateMarkerAgainstPullRequest = ValidateMarkerAgainstPullRequest;
module.exports.VerifyMergeCommit = VerifyMergeCommit;
module.exports.VerifySuccessfulCandidateStatus = VerifySuccessfulCandidateStatus;
