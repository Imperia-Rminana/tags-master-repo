const ReadReleaseState = require('./read-release-state.cjs');
const {
    CreatePromotionMarker,
    ParsePromotionMarker,
    ParseTag
} = require('./promotion-contract.cjs');

const STATUS_CONTEXT = 'scp-management/release-candidate';
const PENDING_CONTRACT_BODY =
    'Release candidate contract is being signed by scp-management.';

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
        const response = await github.rest.git.getRef({ owner, repo: repository, ref: reference });
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
    return ReadReleaseState.ResolveObjectToCommit(github, owner, repository, reference.object);
}

async function EnsureReference(parameters)
{
    const { github, owner, repository, branch, targetSha, displayName } = parameters;
    const existing = await GetReferenceOrNull(github, owner, repository, `heads/${branch}`);
    if (existing)
    {
        const currentSha = await ResolveReferenceCommit(github, owner, repository, existing);
        if (currentSha !== targetSha)
        {
            throw new Error(`${displayName} ${branch} exists at ${currentSha} instead of ${targetSha}.`);
        }
        return false;
    }
    try
    {
        await github.rest.git.createRef({
            owner,
            repo: repository,
            ref: `refs/heads/${branch}`,
            sha: targetSha
        });
        return true;
    }
    catch (error)
    {
        if (!IsValidationFailure(error))
        {
            throw error;
        }
        const concurrent = await GetReferenceOrNull(github, owner, repository, `heads/${branch}`);
        if (!concurrent || await ResolveReferenceCommit(github, owner, repository, concurrent) !== targetSha)
        {
            throw new Error(`${displayName} ${branch} was concurrently created at another commit.`, {
                cause: error
            });
        }
        return false;
    }
}

async function EnsureBoosterBaseBranch(parameters)
{
    const { github, contract, parentOwner, parentRepository } = parameters;
    if (contract.component !== 'booster')
    {
        return false;
    }
    const existing = await GetReferenceOrNull(
        github,
        parentOwner,
        parentRepository,
        `heads/${contract.parentBaseBranch}`
    );
    if (existing)
    {
        return false;
    }
    const production = await GetReferenceOrNull(
        github,
        parentOwner,
        parentRepository,
        'heads/production'
    );
    if (!production)
    {
        throw new Error('Parent production branch does not exist.');
    }
    const productionSha = await ResolveReferenceCommit(
        github,
        parentOwner,
        parentRepository,
        production
    );
    return EnsureReference({
        github,
        owner: parentOwner,
        repository: parentRepository,
        branch: contract.parentBaseBranch,
        targetSha: productionSha,
        displayName: 'Parent Booster branch'
    });
}

function CreateMetadata(inputs, contract)
{
    return {
        schemaVersion: 2,
        tag: contract.tag,
        sourceRepository: `${inputs.DEVELOPMENT_OWNER}/${inputs.DEVELOPMENT_REPOSITORY}`,
        sourceBranch: contract.sourceBranch,
        parentRepository: `${inputs.PARENT_OWNER}/${inputs.PARENT_REPOSITORY}`,
        parentBaseBranch: contract.parentBaseBranch,
        previousTag: inputs.PREVIOUS_TAG || '',
        isOverride: inputs.IS_OVERRIDE === 'true',
        overrideReason: inputs.OVERRIDE_REASON || '',
        requestedBy: inputs.REQUESTED_BY,
        approvalRunUrl: inputs.RUN_URL
    };
}

function ValidateExistingPullRequest(pullRequest, expectedMetadata, inputs)
{
    ValidatePullRequestSource(pullRequest, expectedMetadata);
    const actualMetadata = ParsePromotionMarker(
        pullRequest.body || '',
        inputs.CONTRACT_SECRET,
        pullRequest.number
    );
    for (const field of [
        'tag',
        'sourceRepository',
        'sourceBranch',
        'parentRepository',
        'parentBaseBranch',
        'previousTag',
        'isOverride',
        'overrideReason'
    ])
    {
        if (actualMetadata[field] !== expectedMetadata[field])
        {
            throw new Error(`Existing promotion contract field ${field} conflicts with this run.`);
        }
    }
}

function ValidatePullRequestSource(pullRequest, expectedMetadata)
{
    if (!pullRequest.head || pullRequest.head.ref !== expectedMetadata.sourceBranch ||
        !pullRequest.head.repo || pullRequest.head.repo.full_name !== expectedMetadata.sourceRepository ||
        !pullRequest.base || pullRequest.base.ref !== expectedMetadata.parentBaseBranch)
    {
        throw new Error('Existing promotion pull request has an unexpected source or target.');
    }
}

async function SignPromotionPullRequest(github, inputs, pullRequest, metadata)
{
    const marker = CreatePromotionMarker(
        metadata,
        inputs.CONTRACT_SECRET,
        pullRequest.number
    );
    const response = await github.rest.pulls.update({
        owner: inputs.PARENT_OWNER,
        repo: inputs.PARENT_REPOSITORY,
        pull_number: pullRequest.number,
        body: `Release candidate created by scp-management.\n\n${marker}`
    });
    return response.data;
}

async function EnsurePromotionPullRequest(parameters)
{
    const { github, contract, inputs, metadata } = parameters;
    const head = `${inputs.DEVELOPMENT_OWNER}:${contract.sourceBranch}`;
    const response = await github.rest.pulls.list({
        owner: inputs.PARENT_OWNER,
        repo: inputs.PARENT_REPOSITORY,
        state: 'open',
        head,
        base: contract.parentBaseBranch,
        per_page: 100
    });
    const sourceRepository =
        `${inputs.DEVELOPMENT_OWNER}/${inputs.DEVELOPMENT_REPOSITORY}`;
    const matchingPullRequests = response.data.filter((pullRequest) =>
        pullRequest.head &&
        pullRequest.head.ref === contract.sourceBranch &&
        pullRequest.head.repo &&
        pullRequest.head.repo.full_name === sourceRepository &&
        pullRequest.base &&
        pullRequest.base.ref === contract.parentBaseBranch
    );
    if (matchingPullRequests.length > 1)
    {
        throw new Error('More than one open promotion pull request exists for the source branch.');
    }
    if (matchingPullRequests.length === 1)
    {
        const existingPullRequest = matchingPullRequests[0];
        if (existingPullRequest.body === PENDING_CONTRACT_BODY)
        {
            ValidatePullRequestSource(existingPullRequest, metadata);
            return SignPromotionPullRequest(github, inputs, existingPullRequest, metadata);
        }
        ValidateExistingPullRequest(existingPullRequest, metadata, inputs);
        return existingPullRequest;
    }
    const title = contract.component === 'core'
        ? `Promote ${contract.tag} to production`
        : `Promote ${contract.tag}`;
    const createResponse = await github.rest.pulls.create({
        owner: inputs.PARENT_OWNER,
        repo: inputs.PARENT_REPOSITORY,
        title,
        head,
        head_repo: inputs.DEVELOPMENT_REPOSITORY,
        base: contract.parentBaseBranch,
        body: PENDING_CONTRACT_BODY,
        maintainer_can_modify: false,
        draft: false
    });
    return SignPromotionPullRequest(github, inputs, createResponse.data, metadata);
}

async function SetSuccessfulStatus(github, inputs)
{
    await github.rest.repos.createCommitStatus({
        owner: inputs.PARENT_OWNER,
        repo: inputs.PARENT_REPOSITORY,
        sha: inputs.TARGET_SHA,
        state: 'success',
        context: STATUS_CONTEXT,
        description: 'Release candidate build passed',
        target_url: inputs.RUN_URL
    });
}

async function OpenPromotion(parameters)
{
    const { github, core, inputs } = parameters;
    for (const name of [
        'DEVELOPMENT_OWNER',
        'DEVELOPMENT_REPOSITORY',
        'PARENT_OWNER',
        'PARENT_REPOSITORY',
        'TAG',
        'TARGET_SHA',
        'SOURCE_BRANCH',
        'IS_OVERRIDE',
        'REQUESTED_BY',
        'RUN_URL',
        'CONTRACT_SECRET'
    ])
    {
        if (!inputs[name])
        {
            throw new Error(`Promotion input ${name} is required.`);
        }
    }
    if (!/^[0-9a-f]{40}$/.test(inputs.TARGET_SHA))
    {
        throw new Error('Promotion target SHA is invalid.');
    }
    if (!['true', 'false'].includes(inputs.IS_OVERRIDE))
    {
        throw new Error('Promotion override flag is invalid.');
    }

    const contract = ParseTag(inputs.TAG);
    if (inputs.SOURCE_BRANCH !== contract.sourceBranch)
    {
        throw new Error(`Promotion source branch must be ${contract.sourceBranch}.`);
    }
    const sourceReference = await GetReferenceOrNull(
        github,
        inputs.DEVELOPMENT_OWNER,
        inputs.DEVELOPMENT_REPOSITORY,
        `heads/${contract.sourceBranch}`
    );
    if (!sourceReference)
    {
        throw new Error(`Development source branch ${contract.sourceBranch} does not exist.`);
    }
    const currentSha = await ResolveReferenceCommit(
        github,
        inputs.DEVELOPMENT_OWNER,
        inputs.DEVELOPMENT_REPOSITORY,
        sourceReference
    );
    if (currentSha !== inputs.TARGET_SHA)
    {
        throw new Error(
            `Source branch moved from approved SHA ${inputs.TARGET_SHA} to ${currentSha}.`
        );
    }

    const parentBranchCreated = await EnsureBoosterBaseBranch({
        github,
        contract,
        parentOwner: inputs.PARENT_OWNER,
        parentRepository: inputs.PARENT_REPOSITORY
    });
    const metadata = CreateMetadata(inputs, contract);
    const pullRequest = await EnsurePromotionPullRequest({ github, contract, inputs, metadata });
    await SetSuccessfulStatus(github, inputs);

    core.setOutput('source_branch', contract.sourceBranch);
    core.setOutput('promotion_pr_number', String(pullRequest.number));
    core.setOutput('promotion_pr_url', pullRequest.html_url);
    core.info(`Promotion pull request ready: ${pullRequest.html_url}`);
    return {
        sourceBranch: contract.sourceBranch,
        parentBaseBranch: contract.parentBaseBranch,
        pullRequestNumber: pullRequest.number,
        pullRequestUrl: pullRequest.html_url,
        parentBranchCreated
    };
}

module.exports = OpenPromotion;
module.exports.EnsureBoosterBaseBranch = EnsureBoosterBaseBranch;
module.exports.EnsurePromotionPullRequest = EnsurePromotionPullRequest;
module.exports.EnsureReference = EnsureReference;
module.exports.GetReferenceOrNull = GetReferenceOrNull;
module.exports.STATUS_CONTEXT = STATUS_CONTEXT;
