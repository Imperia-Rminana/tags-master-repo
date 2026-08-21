const crypto = require('node:crypto');

const MARKER_PREFIX = '<!-- scp-promotion:';
const MARKER_SUFFIX = ' -->';
const SEMVER_PART = '(0|[1-9][0-9]*)';
const CORE_TAG_PATTERN = new RegExp(`^core/(${SEMVER_PART})\\.(${SEMVER_PART})\\.(${SEMVER_PART})$`);
const BOOSTER_TAG_PATTERN = new RegExp(
    `^boost/([a-z0-9][a-z0-9-]*)/(${SEMVER_PART})\\.(${SEMVER_PART})\\.(${SEMVER_PART})$`
);
const METADATA_FIELDS = [
    'schemaVersion',
    'tag',
    'sourceRepository',
    'sourceBranch',
    'parentRepository',
    'parentBaseBranch',
    'previousTag',
    'isOverride',
    'overrideReason',
    'requestedBy',
    'approvalRunUrl'
];

function ParseTag(tag)
{
    const coreMatch = CORE_TAG_PATTERN.exec(tag);
    if (coreMatch)
    {
        const releaseLine = `${coreMatch[1]}.${coreMatch[3]}`;
        const version = `${releaseLine}.${coreMatch[5]}`;
        return {
            component: 'core',
            boosterName: '',
            releaseLine,
            version,
            tag,
            sourceBranch: `release/${releaseLine}`,
            parentBaseBranch: 'production'
        };
    }

    const boosterMatch = BOOSTER_TAG_PATTERN.exec(tag);
    if (boosterMatch)
    {
        const boosterName = boosterMatch[1];
        const releaseLine = `${boosterMatch[2]}.${boosterMatch[4]}`;
        const version = `${releaseLine}.${boosterMatch[6]}`;
        return {
            component: 'booster',
            boosterName,
            releaseLine,
            version,
            tag,
            sourceBranch: `boost/${boosterName}/${releaseLine}`,
            parentBaseBranch: `boost/${boosterName}/${releaseLine}`
        };
    }

    throw new Error(`Release tag '${tag}' is invalid.`);
}

function ValidateSecret(secret)
{
    if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32)
    {
        throw new Error('Promotion contract secret must contain at least 32 bytes.');
    }
}

function ValidateRepository(repository, displayName)
{
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || ''))
    {
        throw new Error(`${displayName} repository is invalid.`);
    }
}

function ValidateMarkerText(value, displayName, maximumLength)
{
    if (value.length > maximumLength || value.includes('<!--') || value.includes('-->'))
    {
        throw new Error(`${displayName} contains an invalid marker delimiter or is too long.`);
    }
}

function ValidateMetadata(metadata)
{
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    {
        throw new Error('Promotion marker metadata is invalid.');
    }
    const actualFields = Object.keys(metadata).sort();
    const expectedFields = [...METADATA_FIELDS].sort();
    if (actualFields.length !== expectedFields.length ||
        actualFields.some((field, index) => field !== expectedFields[index]))
    {
        throw new Error('Promotion marker fields are incomplete or unexpected.');
    }
    if (metadata.schemaVersion !== 2)
    {
        throw new Error(`Promotion marker schema '${metadata.schemaVersion}' is not supported.`);
    }

    const contract = ParseTag(metadata.tag);
    ValidateRepository(metadata.sourceRepository, 'Source');
    ValidateRepository(metadata.parentRepository, 'Parent');
    if (metadata.sourceBranch !== contract.sourceBranch ||
        metadata.parentBaseBranch !== contract.parentBaseBranch)
    {
        throw new Error('Promotion marker branches do not match its tag.');
    }
    if (typeof metadata.previousTag !== 'string')
    {
        throw new Error('Promotion previous tag is invalid.');
    }
    if (metadata.previousTag)
    {
        const previous = ParseTag(metadata.previousTag);
        if (previous.component !== contract.component ||
            previous.boosterName !== contract.boosterName)
        {
            throw new Error('Promotion previous tag belongs to another component.');
        }
    }
    if (typeof metadata.isOverride !== 'boolean' || typeof metadata.overrideReason !== 'string' ||
        (metadata.isOverride && !metadata.overrideReason.trim()) ||
        (!metadata.isOverride && metadata.overrideReason !== ''))
    {
        throw new Error('Promotion override metadata is invalid.');
    }
    ValidateMarkerText(metadata.overrideReason, 'Promotion override reason', 1000);
    if (typeof metadata.requestedBy !== 'string' || !metadata.requestedBy.trim() ||
        metadata.requestedBy.length > 100 || /[\r\n]/.test(metadata.requestedBy))
    {
        throw new Error('Promotion requester is invalid.');
    }
    ValidateMarkerText(metadata.requestedBy, 'Promotion requester', 100);
    if (typeof metadata.approvalRunUrl !== 'string' ||
        !/^https:\/\//.test(metadata.approvalRunUrl))
    {
        throw new Error('Promotion approval workflow URL is invalid.');
    }
    ValidateMarkerText(metadata.approvalRunUrl, 'Promotion approval workflow URL', 2048);

    return contract;
}

function CanonicalizeMetadata(metadata)
{
    const canonical = {};
    for (const field of METADATA_FIELDS)
    {
        canonical[field] = metadata[field];
    }
    return JSON.stringify(canonical);
}

function ValidatePullRequestNumber(pullRequestNumber)
{
    if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1)
    {
        throw new Error('A positive promotion pull request number is required.');
    }
}

function CreateSignature(metadata, secret, pullRequestNumber)
{
    ValidatePullRequestNumber(pullRequestNumber);
    return `sha256=${crypto.createHmac('sha256', secret)
        .update(`pull-request:${pullRequestNumber}\\n`, 'utf8')
        .update(CanonicalizeMetadata(metadata), 'utf8')
        .digest('hex')}`;
}

function CreatePromotionMarker(metadata, secret, pullRequestNumber)
{
    ValidateSecret(secret);
    ValidateMetadata(metadata);
    const signedMetadata = {
        ...metadata,
        signature: CreateSignature(metadata, secret, pullRequestNumber)
    };
    return `${MARKER_PREFIX}${JSON.stringify(signedMetadata)}${MARKER_SUFFIX}`;
}

function ExtractMarker(body)
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
    return markers[0];
}

function ParsePromotionMarker(body, secret, pullRequestNumber)
{
    ValidateSecret(secret);
    let signedMetadata;
    try
    {
        signedMetadata = JSON.parse(ExtractMarker(body));
    }
    catch (error)
    {
        if (error.message.includes('Promotion marker') || error.message.includes('exactly one'))
        {
            throw error;
        }
        throw new Error('Promotion marker metadata is not valid JSON.', { cause: error });
    }
    if (!signedMetadata || signedMetadata.schemaVersion !== 2)
    {
        throw new Error(`Promotion marker schema '${signedMetadata?.schemaVersion}' is not supported.`);
    }
    const actualFields = Object.keys(signedMetadata).sort();
    const expectedFields = [...METADATA_FIELDS, 'signature'].sort();
    if (actualFields.length !== expectedFields.length ||
        actualFields.some((field, index) => field !== expectedFields[index]))
    {
        throw new Error('Promotion marker fields are incomplete or unexpected.');
    }
    const { signature, ...metadata } = signedMetadata;
    if (!/^sha256=[0-9a-f]{64}$/.test(signature || ''))
    {
        throw new Error('Promotion marker signature is invalid.');
    }
    const expectedSignature = CreateSignature(metadata, secret, pullRequestNumber);
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature)))
    {
        throw new Error('Promotion marker signature is invalid.');
    }
    ValidateMetadata(metadata);
    return metadata;
}

module.exports.CreatePromotionMarker = CreatePromotionMarker;
module.exports.ParsePromotionMarker = ParsePromotionMarker;
module.exports.ParseTag = ParseTag;
module.exports.ValidateMetadata = ValidateMetadata;
