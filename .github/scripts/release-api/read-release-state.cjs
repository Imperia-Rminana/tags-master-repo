const fs = require('node:fs');
const { ParsePromotionMarker, ParseTag } = require('./promotion-contract.cjs');

function GetTagPrefix(component, boosterName)
{
    if (component === 'core')
    {
        return 'core/';
    }

    if (component === 'booster' && /^[a-z0-9][a-z0-9-]*$/.test(boosterName))
    {
        return `boost/${boosterName}/`;
    }

    throw new Error('Component or booster name is invalid.');
}

async function ResolveObjectToCommit(github, owner, repository, initialObject)
{
    const visitedObjects = new Set();
    let currentObject = initialObject;

    while (currentObject.type === 'tag')
    {
        if (visitedObjects.has(currentObject.sha))
        {
            throw new Error(`Tag object cycle detected at ${currentObject.sha}.`);
        }

        visitedObjects.add(currentObject.sha);
        const tagResponse = await github.rest.git.getTag({
            owner,
            repo: repository,
            tag_sha: currentObject.sha
        });
        currentObject = tagResponse.data.object;
    }

    if (currentObject.type !== 'commit')
    {
        throw new Error(
            `Git object ${currentObject.sha} resolves to unsupported type ${currentObject.type}.`
        );
    }

    return currentObject.sha;
}

async function ReadReleaseState(parameters)
{
    const {
        github,
        core,
        owner,
        repository,
        sourceBranch,
        component,
        boosterName,
        parentOwner,
        parentRepository,
        contractSecret,
        outputPath
    } = parameters;

    if (!owner || !repository || !sourceBranch || !parentOwner || !parentRepository ||
        !contractSecret || !outputPath)
    {
        throw new Error('Owner, repository, source branch and output path are required.');
    }

    const tagPrefix = GetTagPrefix(component, boosterName);
    const branchResponse = await github.rest.git.getRef({
        owner,
        repo: repository,
        ref: `heads/${sourceBranch}`
    });
    const targetSha = await ResolveObjectToCommit(
        github,
        owner,
        repository,
        branchResponse.data.object
    );
    const tagReferences = await github.paginate(github.rest.git.listMatchingRefs, {
        owner,
        repo: repository,
        ref: `tags/${tagPrefix}`,
        per_page: 100
    });
    const tags = [];

    for (const tagReference of tagReferences)
    {
        if (!tagReference.ref.startsWith('refs/tags/'))
        {
            throw new Error(`Unexpected tag reference '${tagReference.ref}'.`);
        }

        const name = tagReference.ref.substring('refs/tags/'.length);
        const commitSha = await ResolveObjectToCommit(
            github,
            owner,
            repository,
            tagReference.object
        );
        tags.push({ name, commitSha });
    }

    tags.sort((left, right) => left.name.localeCompare(right.name));
    const expectedParentBaseBranch = component === 'core' ? 'production' : sourceBranch;
    const pullRequests = await github.paginate(github.rest.pulls.list, {
        owner: parentOwner,
        repo: parentRepository,
        state: 'all',
        head: `${owner}:${sourceBranch}`,
        base: expectedParentBaseBranch,
        per_page: 100
    });
    const reservations = [];
    const publishedTags = new Set(tags.map((tag) => tag.name));
    for (const pullRequest of pullRequests)
    {
        const expectedSourceRepository = `${owner}/${repository}`;
        if (!pullRequest.head || pullRequest.head.ref !== sourceBranch ||
            !pullRequest.head.repo ||
            pullRequest.head.repo.full_name !== expectedSourceRepository ||
            !pullRequest.base || pullRequest.base.ref !== expectedParentBaseBranch)
        {
            continue;
        }
        if (pullRequest.state === 'closed' && !pullRequest.merged_at)
        {
            continue;
        }
        const metadata = ParsePromotionMarker(
            pullRequest.body || '',
            contractSecret,
            pullRequest.number
        );
        const contract = ParseTag(metadata.tag);
        const expectedParentRepository = `${parentOwner}/${parentRepository}`;
        if (metadata.sourceRepository !== expectedSourceRepository ||
            metadata.sourceBranch !== sourceBranch ||
            metadata.parentRepository !== expectedParentRepository ||
            contract.sourceBranch !== sourceBranch ||
            contract.parentBaseBranch !== expectedParentBaseBranch)
        {
            throw new Error(`Promotion pull request #${pullRequest.number} does not match its contract.`);
        }
        if (pullRequest.merged_at && publishedTags.has(metadata.tag))
        {
            continue;
        }
        reservations.push({
            pullRequestNumber: pullRequest.number,
            url: pullRequest.html_url,
            state: pullRequest.merged_at ? 'merged_pending' : 'open',
            tag: metadata.tag,
            sourceBranch: metadata.sourceBranch,
            previousTag: metadata.previousTag,
            isOverride: metadata.isOverride,
            overrideReason: metadata.overrideReason
        });
    }
    reservations.sort((left, right) => left.pullRequestNumber - right.pullRequestNumber);
    const state = {
        schemaVersion: 2,
        repository: `${owner}/${repository}`,
        sourceBranch,
        targetSha,
        tags,
        reservations
    };

    fs.writeFileSync(outputPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    core.info(
        `Resolved ${sourceBranch} at ${targetSha} with ${tags.length} matching release tags ` +
        `and ${reservations.length} active reservations.`
    );

    return state;
}

module.exports = ReadReleaseState;
module.exports.GetTagPrefix = GetTagPrefix;
module.exports.ResolveObjectToCommit = ResolveObjectToCommit;
