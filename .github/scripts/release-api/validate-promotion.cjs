const { ParsePromotionMarker, ParseTag } = require('./promotion-contract.cjs');

const STATUS_CONTEXT = 'scp-management/release-candidate';

function RequireInputs(inputs, names)
{
    for (const name of names)
    {
        if (!inputs[name])
        {
            throw new Error(`Promotion validation input ${name} is required.`);
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

function ValidateCandidatePullRequest(pullRequest, marker, inputs)
{
    const contract = ParseTag(marker.tag);
    const developmentRepository =
        `${inputs.DEVELOPMENT_OWNER}/${inputs.DEVELOPMENT_REPOSITORY}`;
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

    return contract;
}

async function ReadCandidate(parameters)
{
    const { github, core, inputs } = parameters;
    RequireInputs(inputs, [
        'DEVELOPMENT_OWNER',
        'DEVELOPMENT_REPOSITORY',
        'PARENT_OWNER',
        'PARENT_REPOSITORY',
        'PULL_REQUEST_NUMBER',
        'CONTRACT_SECRET'
    ]);

    const pullRequestNumber = ReadPullRequestNumber(inputs.PULL_REQUEST_NUMBER);
    const response = await github.rest.pulls.get({
        owner: inputs.PARENT_OWNER,
        repo: inputs.PARENT_REPOSITORY,
        pull_number: pullRequestNumber
    });
    const pullRequest = response.data;
    if (pullRequest.state !== 'open')
    {
        throw new Error(`Promotion pull request #${pullRequestNumber} is not open.`);
    }

    const marker = ParsePromotionMarker(
        pullRequest.body || '',
        inputs.CONTRACT_SECRET,
        pullRequestNumber
    );
    const contract = ValidateCandidatePullRequest(pullRequest, marker, inputs);
    const stale = Boolean(inputs.EXPECTED_HEAD_SHA) &&
        inputs.EXPECTED_HEAD_SHA !== pullRequest.head.sha;
    let requiresBuild = false;
    if (!stale)
    {
        const statusesResponse = await github.rest.repos.listCommitStatusesForRef({
            owner: inputs.PARENT_OWNER,
            repo: inputs.PARENT_REPOSITORY,
            ref: pullRequest.head.sha,
            per_page: 100
        });
        const latestStatus = statusesResponse.data.find(
            (status) => status.context === STATUS_CONTEXT
        );
        requiresBuild = !latestStatus || latestStatus.state !== 'success';
    }

    if (core)
    {
        core.setOutput('stale', String(stale));
        core.setOutput('requires_build', String(requiresBuild));
        core.setOutput('head_sha', pullRequest.head.sha);
        core.setOutput('source_branch', marker.sourceBranch);
        core.setOutput('tag', marker.tag);
        core.info(stale
            ? `Ignored stale candidate dispatch for pull request #${pullRequestNumber}.`
            : `Validated candidate ${marker.tag} at ${pullRequest.head.sha}.`);
    }

    return {
        contract,
        marker,
        pullRequest,
        stale,
        requiresBuild,
        headSha: pullRequest.head.sha,
        sourceBranch: marker.sourceBranch
    };
}

async function SetCandidateStatus(parameters)
{
    const { github, inputs, headSha, state } = parameters;
    RequireInputs(inputs, ['PARENT_OWNER', 'PARENT_REPOSITORY', 'RUN_URL']);
    if (!/^[0-9a-f]{40}$/.test(headSha || ''))
    {
        throw new Error('A valid candidate head SHA is required.');
    }
    const descriptions = {
        pending: 'Release candidate build is running',
        success: 'Release candidate build passed',
        failure: 'Release candidate build failed'
    };
    if (!Object.hasOwn(descriptions, state))
    {
        throw new Error(`Candidate status state '${state}' is invalid.`);
    }

    await github.rest.repos.createCommitStatus({
        owner: inputs.PARENT_OWNER,
        repo: inputs.PARENT_REPOSITORY,
        sha: headSha,
        state,
        context: STATUS_CONTEXT,
        description: descriptions[state],
        target_url: inputs.RUN_URL
    });
}

module.exports = { ReadCandidate, SetCandidateStatus, STATUS_CONTEXT };
