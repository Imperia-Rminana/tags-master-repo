const ReadReleaseState = require('./read-release-state.cjs');
const {
    CreatePromotionMarker,
    ParsePromotionMarker,
    ParseTag
} = require('./promotion-contract.cjs');

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

async function ResolveReferenceCommit(github, owner, repository, reference)
{
    return ReadReleaseState.ResolveObjectToCommit(
        github,
        owner,
        repository,
        reference.object
    );
}

async function VerifySourceTag(parameters)
{
    const { github, owner, repository, tag, targetSha } = parameters;
    const reference = await GetReferenceOrNull(github, owner, repository, `tags/${tag}`);
    if (!reference)
    {
        throw new Error(`Development tag ${tag} does not exist.`);
    }

    const commitSha = await ResolveReferenceCommit(github, owner, repository, reference);
    if (commitSha !== targetSha)
    {
        throw new Error(`Development tag ${tag} resolves to ${commitSha} instead of ${targetSha}.`);
    }
}

async function EnsureReference(parameters)
{
    const { github, owner, repository, branch, targetSha, displayName } = parameters;
    let reference = await GetReferenceOrNull(github, owner, repository, `heads/${branch}`);
    if (reference)
    {
        const currentSha = await ResolveReferenceCommit(github, owner, repository, reference);
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

        reference = await GetReferenceOrNull(github, owner, repository, `heads/${branch}`);
        if (!reference)
        {
            throw error;
        }

        const concurrentSha = await ResolveReferenceCommit(github, owner, repository, reference);
        if (concurrentSha !== targetSha)
        {
            throw new Error(
                `${displayName} ${branch} was concurrently created at ${concurrentSha} ` +
                `instead of ${targetSha}.`
            );
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

function ValidateExistingPullRequest(pullRequest, expectedMarker, contract, targetSha)
{
    if (pullRequest.head && pullRequest.head.sha && pullRequest.head.sha !== targetSha)
    {
        throw new Error(`Promotion pull request head is ${pullRequest.head.sha} instead of ${targetSha}.`);
    }
    if (pullRequest.base && pullRequest.base.ref !== contract.parentBaseBranch)
    {
        throw new Error('Promotion pull request targets an unexpected parent branch.');
    }

    const actualMarker = ParsePromotionMarker(pullRequest.body || '');
    const expectedMetadata = ParsePromotionMarker(expectedMarker);
    if (
        actualMarker.schemaVersion !== expectedMetadata.schemaVersion ||
        actualMarker.tag !== expectedMetadata.tag ||
        actualMarker.sourceSha !== expectedMetadata.sourceSha ||
        actualMarker.sourceRepository !== expectedMetadata.sourceRepository
    )
    {
        throw new Error('Promotion pull request metadata conflicts with the approved release.');
    }
    if (pullRequest.state === 'closed' && !pullRequest.merged_at)
    {
        throw new Error('The matching promotion pull request was closed without merging.');
    }
}

async function EnsurePromotionPullRequest(parameters)
{
    const {
        github,
        contract,
        developmentOwner,
        developmentRepository,
        parentOwner,
        parentRepository,
        targetSha,
        runUrl
    } = parameters;
    const sourceRepository = `${developmentOwner}/${developmentRepository}`;
    const marker = CreatePromotionMarker(contract, targetSha, sourceRepository, runUrl);
    const head = `${developmentOwner}:${contract.promotionBranch}`;
    const listResponse = await github.rest.pulls.list({
        owner: parentOwner,
        repo: parentRepository,
        state: 'all',
        head,
        base: contract.parentBaseBranch,
        per_page: 100
    });

    if (listResponse.data.length > 1)
    {
        throw new Error('More than one promotion pull request exists for the snapshot.');
    }
    if (listResponse.data.length === 1)
    {
        ValidateExistingPullRequest(listResponse.data[0], marker, contract, targetSha);
        return listResponse.data[0];
    }

    const title = contract.component === 'core'
        ? `Promote ${contract.tag} to production`
        : `Promote ${contract.tag}`;
    const createResponse = await github.rest.pulls.create({
        owner: parentOwner,
        repo: parentRepository,
        title,
        head,
        head_repo: developmentRepository,
        base: contract.parentBaseBranch,
        body: `Release promotion created by scp-management.\n\n${marker}`,
        maintainer_can_modify: false,
        draft: false
    });
    return createResponse.data;
}

async function OpenPromotion(parameters)
{
    const { github, core, inputs } = parameters;
    const requiredInputNames = [
        'DEVELOPMENT_OWNER',
        'DEVELOPMENT_REPOSITORY',
        'PARENT_OWNER',
        'PARENT_REPOSITORY',
        'TAG',
        'TARGET_SHA',
        'RUN_URL'
    ];
    for (const inputName of requiredInputNames)
    {
        if (!inputs[inputName])
        {
            throw new Error(`Promotion input ${inputName} is required.`);
        }
    }
    if (!/^[0-9a-f]{40}$/.test(inputs.TARGET_SHA))
    {
        throw new Error('Promotion target SHA is invalid.');
    }

    const contract = ParseTag(inputs.TAG);
    await VerifySourceTag({
        github,
        owner: inputs.DEVELOPMENT_OWNER,
        repository: inputs.DEVELOPMENT_REPOSITORY,
        tag: contract.tag,
        targetSha: inputs.TARGET_SHA
    });
    await EnsureReference({
        github,
        owner: inputs.DEVELOPMENT_OWNER,
        repository: inputs.DEVELOPMENT_REPOSITORY,
        branch: contract.promotionBranch,
        targetSha: inputs.TARGET_SHA,
        displayName: 'Promotion snapshot'
    });
    const parentBranchCreated = await EnsureBoosterBaseBranch({
        github,
        contract,
        parentOwner: inputs.PARENT_OWNER,
        parentRepository: inputs.PARENT_REPOSITORY
    });
    const pullRequest = await EnsurePromotionPullRequest({
        github,
        contract,
        developmentOwner: inputs.DEVELOPMENT_OWNER,
        developmentRepository: inputs.DEVELOPMENT_REPOSITORY,
        parentOwner: inputs.PARENT_OWNER,
        parentRepository: inputs.PARENT_REPOSITORY,
        targetSha: inputs.TARGET_SHA,
        runUrl: inputs.RUN_URL
    });

    core.setOutput('promotion_branch', contract.promotionBranch);
    core.setOutput('promotion_pr_number', String(pullRequest.number));
    core.setOutput('promotion_pr_url', pullRequest.html_url);
    core.info(`Promotion pull request ready: ${pullRequest.html_url}`);

    return {
        promotionBranch: contract.promotionBranch,
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
module.exports.VerifySourceTag = VerifySourceTag;

