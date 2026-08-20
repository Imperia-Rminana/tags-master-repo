const MARKER_PREFIX = '<!-- scp-promotion:';
const MARKER_SUFFIX = ' -->';
const SEMVER_PART = '(0|[1-9][0-9]*)';
const CORE_TAG_PATTERN = new RegExp(`^core/(${SEMVER_PART})\\.(${SEMVER_PART})\\.(${SEMVER_PART})$`);
const BOOSTER_TAG_PATTERN = new RegExp(
    `^boost/([a-z0-9][a-z0-9-]*)/(${SEMVER_PART})\\.(${SEMVER_PART})\\.(${SEMVER_PART})$`
);

function ParseTag(tag)
{
    const coreMatch = CORE_TAG_PATTERN.exec(tag);
    if (coreMatch)
    {
        const releaseLine = `${coreMatch[1]}.${coreMatch[3]}`;
        return {
            component: 'core',
            boosterName: '',
            releaseLine,
            tag,
            promotionBranch: `promotion/${tag}`,
            parentBaseBranch: 'production'
        };
    }

    const boosterMatch = BOOSTER_TAG_PATTERN.exec(tag);
    if (boosterMatch)
    {
        const boosterName = boosterMatch[1];
        const releaseLine = `${boosterMatch[2]}.${boosterMatch[4]}`;
        return {
            component: 'booster',
            boosterName,
            releaseLine,
            tag,
            promotionBranch: `promotion/${tag}`,
            parentBaseBranch: `boost/${boosterName}/${releaseLine}`
        };
    }

    throw new Error(`Release tag '${tag}' is invalid.`);
}

function ParsePromotionBranch(branch)
{
    if (!branch || !branch.startsWith('promotion/'))
    {
        throw new Error(`Branch '${branch}' is not an immutable promotion branch.`);
    }

    return ParseTag(branch.substring('promotion/'.length));
}

function CreatePromotionMarker(contract, sourceSha, sourceRepository, runUrl)
{
    if (!contract || !/^[0-9a-f]{40}$/.test(sourceSha))
    {
        throw new Error('Promotion source SHA is invalid.');
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sourceRepository))
    {
        throw new Error('Promotion source repository is invalid.');
    }
    if (!/^https:\/\//.test(runUrl))
    {
        throw new Error('Promotion workflow URL is invalid.');
    }

    const metadata = {
        schemaVersion: 1,
        tag: contract.tag,
        sourceSha,
        sourceRepository,
        runUrl
    };
    return `${MARKER_PREFIX}${JSON.stringify(metadata)}${MARKER_SUFFIX}`;
}

function ParsePromotionMarker(body)
{
    const markers = [];
    let searchIndex = 0;

    while (true)
    {
        const startIndex = body.indexOf(MARKER_PREFIX, searchIndex);
        if (startIndex === -1)
        {
            break;
        }

        const contentStart = startIndex + MARKER_PREFIX.length;
        const endIndex = body.indexOf(MARKER_SUFFIX, contentStart);
        if (endIndex === -1)
        {
            throw new Error('Promotion marker is malformed.');
        }

        markers.push(body.substring(contentStart, endIndex));
        searchIndex = endIndex + MARKER_SUFFIX.length;
    }

    if (markers.length !== 1)
    {
        throw new Error('Pull request body must contain exactly one promotion marker.');
    }

    let metadata;
    try
    {
        metadata = JSON.parse(markers[0]);
    }
    catch (error)
    {
        throw new Error('Promotion marker metadata is not valid JSON.', { cause: error });
    }

    if (
        metadata.schemaVersion !== 1 ||
        !metadata.tag ||
        !/^[0-9a-f]{40}$/.test(metadata.sourceSha || '') ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(metadata.sourceRepository || '') ||
        !/^https:\/\//.test(metadata.runUrl || '')
    )
    {
        throw new Error('Promotion marker metadata is incomplete or invalid.');
    }

    ParseTag(metadata.tag);
    return metadata;
}

module.exports.CreatePromotionMarker = CreatePromotionMarker;
module.exports.ParsePromotionBranch = ParsePromotionBranch;
module.exports.ParsePromotionMarker = ParsePromotionMarker;
module.exports.ParseTag = ParseTag;

