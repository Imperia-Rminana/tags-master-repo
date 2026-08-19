const fs = require('node:fs');

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
        outputPath
    } = parameters;

    if (!owner || !repository || !sourceBranch || !outputPath)
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
    const state = {
        schemaVersion: 1,
        repository: `${owner}/${repository}`,
        sourceBranch,
        targetSha,
        tags
    };

    fs.writeFileSync(outputPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    core.info(
        `Resolved ${sourceBranch} at ${targetSha} with ${tags.length} matching release tags.`
    );

    return state;
}

module.exports = ReadReleaseState;
module.exports.GetTagPrefix = GetTagPrefix;
module.exports.ResolveObjectToCommit = ResolveObjectToCommit;
